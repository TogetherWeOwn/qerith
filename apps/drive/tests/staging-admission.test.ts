import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { admitStagingRequest, dispatchStagingRequest } from '../src/lib/server/staging-admission';
import { privateRequests, stagingOrigin } from '../src/lib/server/request-auth';

const id = '01234567-89ab-cdef-0123-456789abcdef';
const shared = '/_app/immutable/chunks/runtime.js';
const signIn = '/_app/immutable/nodes/sign-in.js';
const root = '/_app/immutable/nodes/root.js';
const data = '/__data.json?x-sveltekit-invalidated=01';
const invite = '/_app/immutable/nodes/invite.js';
const people = '/_app/immutable/nodes/people.js';
const folder = '/_app/immutable/assets/folder.css';
const ownerStyle = '/_app/immutable/assets/people.css';
const assets = { signIn: new Set([shared, signIn]), root: new Set([shared, root]), invite: new Set([shared, invite]),
  people: new Set([shared, people, ownerStyle]), folder: new Set([folder, ownerStyle]) };
const cookie = `__Host-drive-session=${'A'.repeat(43)}`;
const request = (path: string, method = 'GET', headers?: HeadersInit) =>
  new Request(stagingOrigin + path, { method, headers: headers ?? { origin: stagingOrigin, cookie } });

function runtime(role: 'owner' | 'member' | 'revoked' | 'offline' = 'owner', remaining_ms = 60_000, delayMs = 0) {
  let reads = 0;
  const DB = { withSession: () => assert.fail('unexpected write session'), prepare: () => {
    reads++;
    if (role === 'offline') throw new Error('fixture unavailable');
    return { bind: () => ({ first: async () => {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      return role === 'revoked' ? null : { id, role, remaining_ms };
    } }) };
  } };
  return { env: { DRIVE_ORIGIN: stagingOrigin, DB }, reads: () => reads, revoke: () => { role = 'revoked'; } };
}

function denied(result: unknown, status: number): asserts result is Response {
  assert.ok(result instanceof Response);
  assert.equal(result.status, status);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.body, null);
}

test('invalid read-grant queries never reach the staging adapter', async () => {
  const path = `/api/entries/${id}/read-grants`;
  const env = { ...runtime('member').env, DRIVE_STAGING_READ_GRANTS: '1' };
  const unexpected = async () => { throw new Error('Unexpected dispatch'); };
  const dispatch = { adapter: unexpected, ceremony: unexpected, invite: unexpected, asset: unexpected };
  for (const input of [request(`${path}?x-sveltekit-probe=1`), request(`${path}/recipient?cursor=x`, 'PUT')]) {
    denied(await dispatchStagingRequest(input, env, true, assets, dispatch), 400);
  }
  const response = await dispatchStagingRequest(request(`${path}?cursor=a%26b`), env, true, assets, {
    ...dispatch, adapter: async input => {
      assert.equal(new URL(input.url).search, '?cursor=a%26b');
      return new Response(null);
    },
  });
  assert.equal(response.status, 200);
});

test('reserved grant recipient IDs reach the adapter without admitting encoded aliases', async () => {
  const path = `/api/entries/${id}/read-grants`;
  const env = { ...runtime('member').env, DRIVE_STAGING_READ_GRANTS: '1' };
  const unexpected = async () => { throw new Error('Unexpected dispatch'); };
  for (const [suffix, escapedSuffix] of [
    ['__data.json', '%5F_data.json'],
    ['__route.js', '%5F_route.js'],
    ['file.html__data.json', 'file.html%5F_data.json'],
    ['file.html__route.js', 'file.html%5F_route.js'],
  ]) {
    const alias = `${path}/${escapedSuffix}`;
    const dispatch = { adapter: unexpected, ceremony: unexpected, invite: unexpected, asset: unexpected };
    denied(await dispatchStagingRequest(request(alias, 'PUT'), env, true, assets, dispatch), 404);
    const response = await dispatchStagingRequest(request(`${path}/${suffix}`, 'PUT'), env, true, assets, {
      ...dispatch, adapter: async input => { assert.equal(new URL(input.url).pathname, alias); return new Response(null); },
    });
    assert.equal(response.status, 200);
  }
});

test('people document and its exclusive assets require the invite flag and live owner session', async () => {
  const enabled = (role?: 'owner' | 'member' | 'revoked') => ({ ...runtime(role).env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' });
  const check = (path: string, method: string, env = enabled(), headers?: HeadersInit) =>
    admitStagingRequest(request(path, method, headers), env, true, assets);
  for (const [path, kind] of [['/people', 'people'], [people, 'people-asset']]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await check(path, method) as { kind: string }).kind, kind);
      denied(await admitStagingRequest(request(path, method), runtime().env, true, assets), 404);
      denied(await check(path, method, enabled(), {}), 401);
      denied(await check(path, method, enabled('member')), 404);
      denied(await check(path, method, enabled('revoked')), 401);
    }
    for (const invalid of [path + '?', path + '/']) denied(await check(invalid, 'GET'), 404);
    denied(await check(path, 'POST'), 404);
    denied(await check(path, 'GET', enabled(), { cookie, 'sec-fetch-site': 'same-site' }), 404);
  }
  const nav = { cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const expired = { ...runtime('owner', 0).env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  const redirect = await check('/people', 'GET', expired, nav);
  denied(redirect, 303);
  assert.equal(redirect.headers.get('location'), '/sign-in?next=%2Fpeople');
  denied(await check(people, 'GET', expired, nav), 401);
  for (const path of ['/people/__data.json', '/%70eople', `${people}.map`]) denied(await check(path, 'GET'), 404);
});

test('folder document and its styles require opt-in and a live owner or member', async () => {
  const enabled = (role?: 'owner' | 'member' | 'revoked') => ({ ...runtime(role).env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' });
  const check = (path: string, method: string, env = enabled(), headers?: HeadersInit) =>
    admitStagingRequest(request(path, method, headers), env, true, assets);
  const document = `/f/${id}`;
  for (const [path, kind] of [[document, 'folder'], [`${document}?page=opaque`, 'folder'], [folder, 'folder-asset']]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await check(path, method) as { kind: string }).kind, kind);
      assert.equal((await check(path, method, enabled('member')) as { kind: string }).kind, kind);
      denied(await check(path, method, runtime().env), 404);
      denied(await check(path, method, enabled(), {}), 401);
      denied(await check(path, method, enabled('revoked')), 401);
    }
    denied(await check(path, 'POST'), 404);
  }
  for (const path of [`${document}/`, `${document}/__data.json`, '/f/%61', '/f/a%2Fb',
    '/f/', '/api/folder-listing', `${folder}?`, `${folder}.map`, '/_app/immutable/nodes/folder.js', people, ownerStyle]) {
    denied(await check(path, 'GET', enabled('member')), 404);
  }
  denied(await check(document, 'GET', enabled(), { cookie, 'sec-fetch-site': 'cross-site' }), 404);
  denied(await check(document, 'GET', enabled(), { cookie, 'sec-fetch-dest': 'empty' }), 404);
  const raw = request(document);
  Object.defineProperty(raw, 'url', { value: `${stagingOrigin}/other/%2e%2e${document}` });
  denied(await admitStagingRequest(raw, enabled(), true, assets), 404);
});

const publicRoutes = [
  ['/sign-in?next=%2F', ['GET', 'HEAD'], { kind: 'sign-in' }],
  ...(['challenge', 'restart', 'verify'] as const).map(step =>
    [`/api/sign-in/${step}`, ['POST'], { kind: 'ceremony', step }] as const),
  ...[shared, signIn].map(path => [path, ['GET', 'HEAD'], { kind: 'public-asset' }] as const),
] as const;
const protectedRoutes = [
  ['/?after=cursor', ['GET', 'HEAD'], { kind: 'root' }],
  [data, ['GET'], { kind: 'root-data' }],
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
        if (target.kind === 'private-asset' || (target.kind === 'root' && method === 'HEAD')) {
          assert.ok(!(result instanceof Response) && (result.kind === 'private-asset' || result.kind === 'root') &&
            typeof result.deadline === 'number' && result.deadline > performance.now());
          assert.equal(result.kind, target.kind);
        } else {
          assert.deepEqual(result, target, `${method} ${path}`);
        }
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
    '/__data.json/', '/%5f_data.json', '/index.html__data.json', '/sign-in/__data.json', '/shared/__data.json',
    '/_app/env.js', '/_app/version.json', '/_app/immutable/chunks/other.js',
    '/_app/immutable/nodes/%72oot.js', `${root}.map`, '/api/uploads/', '/api/uploads/list',
    '/api/sign-in/enroll', '/api/sign-in/%76erify', `/api/download/${id}/`, `/api/download/${id}%2F`,
    '/api/owner/invitations', `/api/owner/invitations/${id}/cancel`, `/api/owner/members/${id}/revoke`,
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
  const admitted = await admitStagingRequest(request(root), env, true, assets);
  assert.ok(!(admitted instanceof Response) && admitted.kind === 'private-asset');
  revoke();
  denied(await admitStagingRequest(request(root), env, true, assets), 401);
  assert.equal(reads(), 2);
});

test('invite mode admits live members to My Drive, its data and assets, the exact download GET and canonical uploads', async () => {
  const { env, revoke } = runtime('member');
  const admit = (input: Request, flag?: string) =>
    admitStagingRequest(input, { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: flag }, true, assets);
  for (const [path, methods, target] of protectedRoutes) {
    for (const method of methods) {
      const input = request(path, method);
      const disabledStatus = target.kind === 'root' && method === 'HEAD' ? 401 : 403;
      for (const flag of [undefined, '0', 'true', '1 ']) denied(await admit(input, flag), disabledStatus);
      const enabled = await admit(input, '1');
      assert.ok(!(enabled instanceof Response) && enabled.kind === target.kind);
      if (target.kind === 'upload') {
        denied(await admitStagingRequest(input, { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' }, false, assets), 503);
        denied(await admit(request(path, method, { origin: stagingOrigin, cookie, 'sec-fetch-site': 'none' }), '1'), 403);
        for (const suffix of ['?', '?batch=1']) denied(await admit(request(path + suffix, method), '1'), 404);
      }
    }
  }
  for (const path of ['/people', '/api/owner/members', '/__data.json/', '/api/root-listing', `${root}.map`]) {
    denied(await admit(request(path), '1'), 404);
  }
  denied(await admit(request(data, 'GET', { cookie, 'sec-fetch-site': 'cross-site' }), '1'), 403);
  revoke();
  for (const [path, methods] of protectedRoutes) {
    for (const method of methods) denied(await admit(request(path, method), '1'), 401);
  }
});

test('metadata writes admit only canonical methods and URLs, then validate the live session before dispatch', async () => {
  const { env, reads, revoke } = runtime('member');
  const enabled = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  for (const [path, method] of [['/api/folders', 'POST'], ['/api/entries/r%C3%A9sum%C3%A9', 'PATCH']]) {
    for (const flag of [undefined, '0', 'true', '1 ']) {
      denied(await admitStagingRequest(request(path, method), { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: flag }, true, assets), 404);
    }
    for (const alternative of ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].filter(m => m !== method)) {
      denied(await admitStagingRequest(request(path, alternative), enabled, true, assets), 404);
    }
    for (const alias of [path + '/', path + '?', path + '?x=1', path + '#x', path.replace('/api/', '/%61pi/')]) {
      denied(await admitStagingRequest(request(alias, method), enabled, true, assets), 404);
    }
    const raw = request(path, method);
    Object.defineProperty(raw, 'url', { value: `${stagingOrigin}/other/%2e%2e${path}` });
    denied(await admitStagingRequest(raw, enabled, true, assets), 404);
    denied(await admitStagingRequest(request(path, method, { cookie }), enabled, true, assets), 403);
    denied(await admitStagingRequest(request(path, method, { cookie, origin: stagingOrigin, 'sec-fetch-site': 'none' }), enabled, true, assets), 403);
    denied(await admitStagingRequest(request(path, method, { origin: stagingOrigin }), enabled, true, assets), 401);
  }
  for (const alias of ['/api/entries/%61', '/api/entries/%C3%a9', '/api/entries/%00', '/api/entries/%ZZ']) {
    denied(await admitStagingRequest(request(alias, 'PATCH'), enabled, true, assets), 404);
  }
  assert.equal(reads(), 0);
  const unexpected = async () => assert.fail('metadata write reached an unrelated handler');
  const dispatch = { adapter: unexpected, asset: unexpected, ceremony: unexpected, invite: unexpected };
  const writes = [request('/api/folders', 'POST'), request('/api/entries/r%C3%A9sum%C3%A9', 'PATCH')];
  for (const input of writes) denied(await dispatchStagingRequest(input, enabled, true, assets, dispatch), 400);
  revoke();
  for (const input of writes) denied(await dispatchStagingRequest(input, enabled, true, assets, dispatch), 401);
  assert.equal(reads(), 4);
});

test('staging owner lifecycle routes require the exact invite flag and a live owner', async () => {
  const list = '/api/owner/invitations';
  const routes = [[list, 'GET'], [`${list}?after=${id}`, 'GET'], [list, 'POST'],
    [`${list}/${id}/cancel`, 'POST'], [`/api/owner/members/${id}/revoke`, 'POST']] as const;
  for (const [path, method] of routes) {
    const { env, reads, revoke } = runtime();
    const input = request(path, method);
    const enabled = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
    for (const flag of [undefined, '0', '1 ']) {
      denied(await admitStagingRequest(input, { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: flag }, true, assets), 404);
    }
    denied(await admitStagingRequest(input, enabled, false, assets), 503);
    denied(await admitStagingRequest(request(path, method, { origin: stagingOrigin }), enabled, true, assets), 401);
    denied(await admitStagingRequest(request(path, method, { origin: stagingOrigin, cookie, 'sec-fetch-site': 'same-site' }),
      enabled, true, assets), 403);
    assert.equal(reads(), 0);
    denied(await admitStagingRequest(input, { ...runtime('member').env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' }, true, assets), 403);
    const unexpected = async () => assert.fail('owner route reached a public handler');
    assert.equal((await dispatchStagingRequest(input, enabled, true, assets, {
      adapter: async forwarded => { assert.equal(forwarded, input); return new Response(null, { status: 204 }); },
      asset: unexpected, ceremony: unexpected, invite: unexpected,
    })).status, 204);
    revoke();
    denied(await admitStagingRequest(input, enabled, true, assets), 401);
  }
});

test('owner lifecycle admission rejects unlisted methods, paths and query forms before D1', async () => {
  const { env, reads } = runtime();
  const enabled = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  const list = '/api/owner/invitations';
  for (const [path, method] of [[list, 'HEAD'], [list, 'DELETE'], [`${list}/`, 'GET'], [`${list}?`, 'GET'],
    [`${list}?after=`, 'GET'], [`${list}?after=a&after=b`, 'GET'], [`${list}?token=a`, 'GET'], [`${list}?after=a`, 'POST'],
    [`${list}/${id}/cancel`, 'GET'], [`${list}/${id}/cancel?after=a`, 'POST'], [`${list}/%61/cancel`, 'POST'],
    [`/api/owner/members/${id}/restore`, 'POST'], [`/api/owner/members/${id}/revoke/`, 'POST']]) {
    denied(await admitStagingRequest(request(path, method), enabled, true, assets), 404);
  }
  assert.equal(reads(), 0);
});

test('denials and signed-out redirects do not enter any downstream handler', async () => {
  const unexpected = async () => assert.fail('denied request reached downstream dispatch');
  const dispatch = { adapter: unexpected, asset: unexpected, ceremony: unexpected, invite: unexpected };
  const { env, reads, revoke } = runtime();
  for (const [req, status] of [
    [request(data, 'HEAD'), 404],
    [request(data, 'GET', {}), 401],
    [request('/sign-in.html'), 404],
    [request('/api/uploads/list', 'POST'), 404],
    [request('/api/sign-in/verify', 'GET'), 404],
    [request('/api/sign-in/verify', 'POST', { origin: 'https://other.example.test' }), 403],
    [request('/api/uploads', 'POST', { origin: stagingOrigin }), 401],
    [request(root, 'GET', {}), 401],
    [request('/', 'GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }), 303]
  ] as const) {
    denied(await dispatchStagingRequest(req, env, true, assets, dispatch), status);
  }
  denied(await dispatchStagingRequest(request('/api/sign-in/challenge', 'POST'), env, false, assets, dispatch), 503);
  denied(await dispatchStagingRequest(request('/', 'GET', {
    cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document'
  }), env, true, assets, dispatch), 303);
  denied(await dispatchStagingRequest(request('/', 'HEAD'), runtime('member').env, true, assets, dispatch), 401);
  assert.equal(reads(), 0);

  revoke();
  for (const [path, [method]] of protectedRoutes) {
    denied(await dispatchStagingRequest(request(path, method), env, true, assets, dispatch), 401);
  }
  assert.equal(reads(), protectedRoutes.length);
});

test('private assets are not dispatched when the session lifetime runs out during lookup', async () => {
  const { env, reads } = runtime('owner', 1, 10);
  const unexpected = async () => assert.fail('expired owner session reached downstream dispatch');
  denied(await dispatchStagingRequest(request(root), env, true, assets, {
    adapter: unexpected, asset: unexpected, ceremony: unexpected, invite: unexpected,
  }), 401);
  assert.equal(reads(), 1);
});

test('the staged sign-in probe reports a live owner without dispatching the root page', async () => {
  const unexpected = async () => assert.fail('sign-in probe reached downstream dispatch');
  const dispatch = { adapter: unexpected, asset: unexpected, ceremony: unexpected, invite: unexpected };
  for (const [fixture, status] of [[runtime(), 200], [runtime('member'), 401], [runtime('owner', 1, 10), 401]] as const) {
    denied(await dispatchStagingRequest(request('/', 'HEAD'), fixture.env, true, assets, dispatch), status);
    assert.equal(fixture.reads(), 1);
  }
});

test('admitted traffic reaches one handler; assets and root data cannot carry CDN cache overrides', async () => {
  const { env } = runtime();
  const cacheHeaders = ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control'];
  for (const [path, [method], target] of [...publicRoutes, ...protectedRoutes]) {
    const calls: string[] = [];
    const response = new Response(null, { headers: Object.fromEntries(cacheHeaders.map(name => [name, 'public, max-age=3600'])) });
    const handle = async (name: string) => (calls.push(name), response);
    const result = await dispatchStagingRequest(request(path, method), env, true, assets, {
      adapter: () => handle('adapter'), ceremony: (_, step) => handle(`ceremony:${step}`),
      invite: (_, step) => handle(`invite:${step}`), asset: () => handle('asset')
    });
    const expected = target.kind === 'ceremony' ? `ceremony:${target.step}` : target.kind.endsWith('-asset') ? 'asset' : 'adapter';
    assert.deepEqual(calls, [expected]);
    if (expected !== 'asset' && target.kind !== 'root-data') continue;
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    for (const name of cacheHeaders) assert.equal(result.headers.get(name), null);
  }
});

const inviteRoutes = [
  ['/invite', ['GET', 'HEAD'], { kind: 'invite' }],
  [invite, ['GET', 'HEAD'], { kind: 'invite-asset' }],
  ...(['present', 'challenge', 'enroll'] as const).map(step =>
    [`/api/invite/${step}`, ['POST'], { kind: 'invite-ceremony', step }] as const),
] as const;

test('staging invite mode is default-off and admits only exact route and asset methods', async () => {
  const { env, reads } = runtime();
  const enabled = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  for (const [path, methods, target] of inviteRoutes) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS']) {
      const input = request(path, method);
      for (const value of [undefined, '0', 'true']) {
        denied(await admitStagingRequest(input, { ...enabled, DRIVE_STAGING_INVITE_ACCEPTANCE: value }, true, assets), 404);
      }
      const result = await admitStagingRequest(input, enabled, true, assets);
      if ((methods as readonly string[]).includes(method)) assert.deepEqual(result, target);
      else denied(result, 404);
    }
    const [method] = methods;
    for (const suffix of ['/', '?', '?token=fixture', '#fixture', '.map']) {
      denied(await admitStagingRequest(request(path + suffix, method), enabled, true, assets), 404);
    }
    denied(await admitStagingRequest(request(path, method), enabled, false, assets), 503);
  }
  for (const path of ['/%69nvite', '//invite', '/invite/__data.json', '/api/invite', '/api/invite/present/extra',
    '/api/invite/%70resent', '/api/invite/present%2F', '/api/invite/recover']) {
    denied(await admitStagingRequest(request(path), enabled, true, assets), 404);
    denied(await admitStagingRequest(request(path, 'POST'), enabled, true, assets), 404);
  }
  // Preserve the raw value to exercise spellings the Request constructor would normalize.
  const raw = request('/invite');
  Object.defineProperty(raw, 'url', { value: `${stagingOrigin}/other/%2e%2e/invite` });
  denied(await admitStagingRequest(raw, enabled, true, assets), 404);
  denied(await admitStagingRequest(request(root, 'GET', {}), enabled, true, assets), 401);
  assert.equal(reads(), 0);
});

test('foreign site metadata permits only the top-level invite document and never dispatches HEAD or a ceremony', async () => {
  const { env, reads } = runtime();
  const enabled = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  const calls: string[] = [];
  const handle = async (name: string) => (calls.push(name), new Response(null));
  const dispatch = { adapter: () => handle('document'), asset: () => handle('asset'),
    ceremony: () => handle('sign-in'), invite: (_: Request, step: string) => handle(step) };
  const navigation = { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const req of [request('/invite', 'HEAD', navigation), request('/invite', 'GET', { 'sec-fetch-site': 'cross-site' }),
    request(invite, 'GET', navigation), request('/api/invite/enroll', 'POST', { ...navigation, origin: stagingOrigin }),
    request('/api/invite/enroll', 'POST', {}), request('/invite', 'GET', { ...navigation, origin: 'null' }),
    new Request('https://other.example.test/invite')]) {
    denied(await dispatchStagingRequest(req, enabled, true, assets, dispatch), 403);
  }
  assert.deepEqual(calls, []);
  await dispatchStagingRequest(request('/invite', 'GET', navigation), enabled, true, assets, dispatch);
  const asset = await dispatchStagingRequest(request(invite), enabled, true, assets, dispatch);
  assert.equal(asset.headers.get('cache-control'), 'private, no-store');
  for (const step of ['present', 'challenge', 'enroll']) {
    await dispatchStagingRequest(request(`/api/invite/${step}`, 'POST'), enabled, true, assets, dispatch);
  }
  assert.deepEqual(calls, ['document', 'asset', 'present', 'challenge', 'enroll']);
  assert.equal(reads(), 0);
});

test('resume is an exact bodyless GET in both staging admission layers', async () => {
  const path = `/api/uploads/${id}/resume`, route = { id: '/api/uploads/[intentId]/resume' };
  const check = async (input: Request, status: number, role: Parameters<typeof runtime>[0] = 'member', flag = '1') => {
    const { env, reads } = runtime(role);
    const bindings = { ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: flag };
    let resolved = 0;
    const adapter = async () => {
      resolved++;
      return new Response(null, { status: 204, headers: { 'cache-control': 'private, no-store' } });
    };
    const unexpected = () => assert.fail('resume must only dispatch to the adapter');
    const handle = privateRequests(bindings);
    for (const result of [
      await dispatchStagingRequest(input, bindings, true, assets, { adapter, ceremony: unexpected, invite: unexpected, asset: unexpected }),
      await handle({ event: { request: input, route, locals: {} }, resolve: adapter } as unknown as Parameters<typeof handle>[0]),
    ]) denied(result, status);
    assert.equal(resolved, status === 204 ? 2 : 0);
    if (status === 400 || status === 403 || status === 404) assert.equal(reads(), 0);
  };
  for (const role of ['owner', 'member'] as const) {
    await check(request(path, 'GET', { cookie, 'content-length': '0' }), 204, role);
    await check(request(path), 404, role, '0');
  }
  for (const alias of [path + '?', path + '?x-sveltekit-invalidated=1', path + '/', path + '/extra',
    path.replace(id, id.toUpperCase()), path.replace(id, '%30' + id.slice(1)), path.replace('/resume', '/%72esume')]) {
    await check(request(alias), 404);
  }
  for (const method of ['HEAD', 'POST', 'OPTIONS']) await check(request(path, method), 404);
  await check(request(path, 'GET', { cookie, origin: 'https://other.example.test' }), 403);
  for (const site of ['same-site', 'cross-site', 'none']) {
    await check(request(path, 'GET', { cookie, 'sec-fetch-site': site }), 403);
  }
  await check(request(path, 'GET', { cookie, 'content-length': '1' }), 400);
  await check(request(path, 'GET', { cookie, 'content-length': '0', 'transfer-encoding': 'chunked' }), 400);
  await check(request(path, 'GET', {}), 401);
  await check(request(path), 401, 'revoked');
});

test('Shared with me admits only exact documents for live members with both flags', async () => {
  const shared = '/shared';
  const cases = [
    [shared, 404, 'member', 'GET', '0'], [shared, 404, 'owner'],
    [shared, 401, 'revoked'], [shared, 503, 'offline'], [shared, 404, 'member', 'POST'],
    [shared + '/', 404], [shared + '/__data.json', 404], [shared + '?cursor=%FF', 400],
    [shared + '?cursor=one&cursor=two', 400], [shared + '?cursor=' + encodeURIComponent('é'.repeat(257)), 400],
    [shared + '?cursor=old%3A%2B%26id', 200], [shared, 200, 'member', 'HEAD'],
  ] as const;
  const success = async () => new Response(null, { headers: { 'cache-control': 'private, no-store' } });
  const dispatch = { adapter: success, asset: success, ceremony: success, invite: success };
  for (const [path, expected, role = 'member', method = 'GET', flag = '1'] of cases) {
    const env = { ...runtime(role).env, DRIVE_STAGING_INVITE_ACCEPTANCE: '1', DRIVE_STAGING_SHARED_LISTING: flag };
    const input = request(path, method);
    const handle = privateRequests(env);
    const event = { request: input, route: { id: shared }, locals: {} };
    denied(await dispatchStagingRequest(input, env, true, assets, dispatch), expected);
    denied(await handle({ event, resolve: success } as unknown as Parameters<typeof handle>[0]), expected);
  }
});
