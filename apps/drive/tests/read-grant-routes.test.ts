import assert from 'node:assert/strict';
import test from 'node:test';
import { readGrantCollectionRoute, readGrantRecipientRoute } from '../src/lib/server/read-grant-admission';
import { readGrantRequest } from '../src/lib/server/read-grant-routes';
import { privateRequests, stagingOrigin } from '../src/lib/server/request-auth';
import { admitStagingRequest } from '../src/lib/server/staging-admission';

const origin = 'https://drive.example.test';
const path = '/api/entries/source/read-grants';
const target = `${path}/recipient`;
const env = {
  DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1',
  DB: {
    prepare() { throw new Error('Unexpected SQL'); },
    withSession() { throw new Error('Unexpected D1 session'); },
  },
};
const ask = (path: string, init?: RequestInit) => readGrantRequest(new Request(origin + path, init), env);

test('recognizes only the fixture path and exact method for each operation', async () => {
  for (const suffix of ['/', '/recipient/', '/recipient/extra']) assert.equal(ask(path + suffix), undefined);
  const closed = await readGrantRequest(new Request(origin + path), { ...env, DRIVE_SIGN_IN_FIXTURE: undefined });
  assert.equal(closed?.status, 404);
  for (const [url, method, allow] of [[path, 'HEAD', 'GET'], [target, 'POST', 'PUT, DELETE'], [target, 'OPTIONS', 'PUT, DELETE']]) {
    const response = await ask(url, { method });
    assert.deepEqual([response?.status, response?.headers.get('allow'), response?.headers.get('access-control-allow-origin')],
      [405, allow, null]);
  }
});

test('bounds and decodes opaque path IDs and a single cursor without aliases', async () => {
  assert.equal((await ask(path + '?'))?.status, 404);
  for (const query of ['?cursor=', '?cursor=a&cursor=b', '?cursor=%C0%AF', '?limit=1', `?cursor=${'%C3%A9'.repeat(257)}`]) {
    assert.equal((await ask(path + query))?.status, 400, query.slice(0, 50));
  }
  assert.equal((await ask(path + '?cursor=%C3%A9%26%2B'))?.status, 401);
  assert.equal((await ask(path.replace('source', '%73ource')))?.status, 404);
  assert.equal((await ask(path.replace('source', 'a%20b')))?.status, 401);
  for (const dot of ['.', '..', '%2E', '%2E%2E']) {
    assert.equal(ask(path.replace('source', dot)), undefined);
    assert.equal(ask(`${path}/${dot}`), undefined);
  }
  assert.equal((await ask(`${path}?cursor=..`))?.status, 401);
});

test('accepts bodyless mutation framing used by Workers', async () => {
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await ask(target, { method, headers: { origin, 'content-length': '0' }, body: '' }))?.status, 401);
    assert.equal((await ask(target, { method, headers: { origin, 'content-length': '1' } }))?.status, 400);
    assert.equal((await ask(target, { method, headers: { origin, 'content-length': '0', 'transfer-encoding': 'chunked' } }))?.status, 400);
  }
});

test('rejects mutations with a missing Origin, wrong site, body or query before session use', async () => {
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await ask(target, { method }))?.status, 403);
    assert.equal((await ask(target, { method, headers: { origin, 'sec-fetch-site': 'same-site' } }))?.status, 403);
    assert.equal((await ask(target, { method, headers: { origin }, body: '{}' }))?.status, 400);
    assert.equal((await ask(target + '?cursor=x', { method, headers: { origin } }))?.status, 400);
    assert.equal((await ask(target, { method, headers: { origin } }))?.status, 401);
  }
});

test('both staging gates require the exact read-grant opt-in and method/path before resolving', async () => {
  const assets = { signIn: new Set<string>(), root: new Set<string>(), invite: new Set<string>(), people: new Set<string>(), folder: new Set<string>() };
  const verify = async (request: Request, route: string, flag: string | undefined, expected: number) => {
    const bindings = { ...env, DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_INVITE_ACCEPTANCE: '1', DRIVE_STAGING_READ_GRANTS: flag };
    const handle = privateRequests(bindings);
    const hook = await handle({
      event: { request, route: { id: route }, locals: {} },
      resolve: () => { throw new Error('Denials must not resolve the route'); },
    } as unknown as Parameters<typeof handle>[0]);
    for (const result of [hook, await admitStagingRequest(request, bindings, true, assets)]) {
      assert.ok(result instanceof Response);
      assert.deepEqual([result.status, result.headers.get('cache-control')], [expected, 'private, no-store']);
    }
  };
  const list = new Request(stagingOrigin + path);
  const put = new Request(stagingOrigin + target, { method: 'PUT', headers: { origin: stagingOrigin } });
  for (const flag of [undefined, '0', 'true']) {
    await verify(list, readGrantCollectionRoute, flag, 404);
    await verify(put, readGrantRecipientRoute, flag, 404);
  }
  await verify(list, readGrantCollectionRoute, '1', 401);
  await verify(put, readGrantRecipientRoute, '1', 401);
  await verify(new Request(list, { method: 'HEAD' }), readGrantCollectionRoute, '1', 404);
  await verify(new Request(stagingOrigin + target + '/', put), readGrantRecipientRoute, '1', 404);
  await verify(new Request(put, { headers: { origin: stagingOrigin, 'sec-fetch-site': 'cross-site' } }), readGrantRecipientRoute, '1', 403);
});
