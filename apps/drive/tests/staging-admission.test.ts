import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { admitStagingRequest, stagingOrigin } from '../src/lib/server/staging-admission';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const shared = '/_app/immutable/chunks/runtime.js';
const signIn = '/_app/immutable/nodes/sign-in.js';
const root = '/_app/immutable/assets/root.css';
const assets = { signIn: new Set([shared, signIn]), root: new Set([shared, root]) };
const cookie = `__Host-drive-session=${'A'.repeat(43)}`;
const request = (path: string, method = 'GET', headers?: HeadersInit) =>
  new Request(stagingOrigin + path, { method, headers: headers ?? { origin: stagingOrigin, cookie } });

function runtime(role: 'owner' | 'member' | 'revoked' | 'offline' = 'owner') {
  let reads = 0;
  const DB = { prepare: () => {
    reads++;
    if (role === 'offline') throw new Error('fixture unavailable');
    return { bind: () => ({ first: async () => role === 'revoked' ? null : { id, role } }) };
  } };
  return { env: { DRIVE_ORIGIN: stagingOrigin, DB }, reads: () => reads, revoke: () => { role = 'revoked'; } };
}

function denied(result: unknown, status: number): asserts result is Response {
  assert.ok(result instanceof Response);
  assert.equal(result.status, status);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.body, null);
}

const publicRoutes = [
  ['/sign-in?next=%2F', ['GET', 'HEAD'], { kind: 'sign-in' }],
  ...(['challenge', 'restart', 'verify'] as const).map(step =>
    [`/api/sign-in/${step}`, ['POST'], { kind: 'ceremony', step }] as const),
  ...[shared, signIn].map(path => [path, ['GET', 'HEAD'], { kind: 'public-asset' }] as const),
] as const;
const protectedRoutes = [
  ['/?after=cursor', ['GET', 'HEAD'], { kind: 'root' }],
  [root, ['GET', 'HEAD'], { kind: 'private-asset' }],
  [`/api/download/${id}`, ['GET'], { kind: 'download' }],
  ['/api/uploads', ['POST'], { kind: 'upload' }],
  [`/api/uploads/${id}/complete`, ['POST'], { kind: 'upload' }],
  ...[1, 10000].map(part => [`/api/uploads/${id}/parts/${part}`, ['PUT'], { kind: 'upload' }] as const),
] as const;

test('preview admits only the declared methods and exact routes or assets', async () => {
  for (const [path, allowed, target] of [...publicRoutes, ...protectedRoutes]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS', 'PATCH', 'DELETE', 'CUSTOM']) {
      const { env, reads } = runtime();
      const result = await admitStagingRequest(request(path, method), env, true, assets);
      if ((allowed as readonly string[]).includes(method)) {
        assert.deepEqual(result, target, `${method} ${path}`);
        assert.equal(reads(), protectedRoutes.some(route => route[0] === path) ? 1 : 0);
      } else {
        denied(result, 404);
        assert.equal(reads(), 0, `${method} ${path}`);
      }
    }
  }
  const range = request(`/api/download/${id}`, 'GET', { cookie, range: 'bytes=0-15' });
  assert.deepEqual(await admitStagingRequest(range, runtime().env, true, assets), { kind: 'download' });
});

test('unlisted paths fail before authentication, including framework paths and noncanonical variants', async () => {
  const { env, reads } = runtime();
  for (const path of ['/shared', '/people', `/f/${id}`, '/invite', '/recover', '/sign-in/', '/sign-in.html',
    '/__data.json', '/sign-in/__data.json', '/_app/env.js', '/_app/version.json', '/_app/immutable/chunks/other.js',
    '/_app/immutable/assets/%72oot.css', '/_app/immutable/assets/root.css.map', '/api/uploads/', '/api/uploads/list',
    '/api/sign-in/enroll', '/api/sign-in/%76erify', `/api/download/${id}/`, `/api/download/${id}%2F`,
    `/api/uploads/${id}/complete/`, `/api/uploads/${id}/abort`, `/api/uploads/${id}/parts/1/`,
    ...['0', '01', '10001', '1e1', '%31'].map(part => `/api/uploads/${id}/parts/${part}`)]) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT']) {
      denied(await admitStagingRequest(request(path, method), env, true, assets), 404);
    }
  }
  assert.equal(reads(), 0);
});

test('only the exact staging binding can open preview; neither missing bindings nor a fixture flag opens it', async () => {
  const { env, reads } = runtime();
  for (const origin of [undefined, `${stagingOrigin}/`, 'https://drive.example.test', 'https://other.example.test']) {
    denied(await admitStagingRequest(request('/'), { ...env, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' }, true, assets), 503);
  }
  denied(await admitStagingRequest(request('/sign-in'), { ...env, DB: undefined }, true, assets), 503);
  denied(await admitStagingRequest(request('/sign-in'), env, false, assets), 503);
  assert.equal(reads(), 0);
});

test('wrong host, foreign origin and cross-site protected fetches do not look up a session', async () => {
  const { env, reads } = runtime();
  for (const [path, [method]] of [...publicRoutes, ...protectedRoutes]) {
    for (const req of [new Request(`https://other.example.test${path}`, { method, headers: { cookie, origin: stagingOrigin } }),
      request(path, method, { cookie, origin: 'https://other.example.test' }),
      request(path, method, { cookie, origin: stagingOrigin, 'sec-fetch-site': 'cross-site' })]) {
      denied(await admitStagingRequest(req, env, true, assets), 403);
    }
  }
  denied(await admitStagingRequest(request('/api/uploads', 'POST', { cookie }), env, true, assets), 403);
  assert.equal(reads(), 0);
});

test('every protected request checks a live owner, including assets after revocation', async () => {
  for (const [path, [method]] of protectedRoutes) {
    for (const [role, status] of [['owner', 401], ['revoked', 401], ['member', 403], ['offline', 503]] as const) {
      const { env, reads } = runtime(role);
      const headers = role === 'owner' ? { origin: stagingOrigin } : { origin: stagingOrigin, cookie };
      denied(await admitStagingRequest(request(path, method, headers), env, true, assets), status);
      assert.equal(reads(), role === 'owner' ? 0 : 1);
    }
  }
  const req = request('/?after=cursor', 'GET', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
  const result = await admitStagingRequest(req, runtime().env, true, assets);
  denied(result, 303);
  assert.equal(result.headers.get('location'), '/sign-in?next=%2F%3Fafter%3Dcursor');

  const { env, reads, revoke } = runtime();
  assert.deepEqual(await admitStagingRequest(request(root), env, true, assets), { kind: 'private-asset' });
  revoke();
  denied(await admitStagingRequest(request(root), env, true, assets), 401);
  assert.equal(reads(), 2);
});
