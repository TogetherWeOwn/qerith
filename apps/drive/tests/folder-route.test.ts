import assert from 'node:assert/strict';
import test from 'node:test';
import { postFolder } from '../src/lib/server/folder-route';
import { stagingOrigin } from '../src/lib/server/request-auth';
import { admitStagingRequest } from '../src/lib/server/staging-admission';

const origin = 'https://drive.example.test';
const path = '/api/folders';
const validBody = '{"name":"Folder","parentId":null}';
const headers = { origin, cookie: `__Host-drive-session=${'a'.repeat(43)}`, 'content-type': 'application/json' };
const DB = {
  prepare() { assert.fail('must not use raw DB'); },
  withSession() { assert.fail('rejected input must not open a DB session'); },
};
const fixture = { DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
const post = (init?: RequestInit, url = origin + path) =>
  new Request(url, { method: 'POST', body: validBody, headers, ...init });

async function denied(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), '');
}

test('folder creation stays closed outside the fixture and in staging invite mode', async () => {
  const staging = { ...fixture, DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  const request = post({ headers: { ...headers, origin: stagingOrigin } }, stagingOrigin + path);
  const assets = { signIn: new Set<string>(), root: new Set<string>(), invite: new Set<string>(), people: new Set<string>(), folder: new Set<string>() };
  const result = await admitStagingRequest(request, staging, true, assets);
  assert.ok(result instanceof Response);
  await denied(result, 404);
  await denied(await postFolder(request, staging), 404);
  await denied(await postFolder(post(), { ...fixture, DRIVE_SIGN_IN_FIXTURE: '0' }), 404);
});

test('rejects method, CSRF, query and missing or ambiguous session cookie before touching D1', async () => {
  const method = await postFolder(new Request(origin + path), fixture);
  await denied(method, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  for (const originHeader of ['null', 'https://other.example.test', '']) {
    const requestHeaders = new Headers(headers);
    if (originHeader) requestHeaders.set('origin', originHeader);
    else requestHeaders.delete('origin');
    await denied(await postFolder(post({ headers: requestHeaders }), fixture), 403);
  }
  await denied(await postFolder(post(undefined, 'https://other.example.test' + path), fixture), 403);
  await denied(await postFolder(post({ headers: { ...headers, 'sec-fetch-site': 'same-site' } }), fixture), 403);
  await denied(await postFolder(post(undefined, origin + path + '?'), fixture), 404);
  for (const cookie of ['', `${headers.cookie}; ${headers.cookie}`]) {
    await denied(await postFolder(post({ headers: { ...headers, cookie } }), fixture), 401);
  }
});

test('rejects unexpected fields, invalid names and IDs, bad UTF-8 and bounded-body violations', async () => {
  for (const body of ['null', '{', '{"name":"Folder"}', '{"name":"Folder","parentId":null,"ownerId":"other"}',
    ...['', ' ... ', 'bad/name', 'bad\0name', 'é'.repeat(128), '\ud800'].map(name => JSON.stringify({ name, parentId: null })),
    ...['', 42, 'bad\0id', '💾'.repeat(129), '\ud800'].map(parentId => JSON.stringify({ name: 'Folder', parentId })),
    new Uint8Array([0xff]), validBody.padEnd(5121)]) {
    await denied(await postFolder(post({ body }), fixture), 400);
  }
  for (const extra of [{ 'content-length': '5121' }, { 'content-length': '50' },
    { 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) {
    await denied(await postFolder(post({ headers: { ...headers, ...extra } }), fixture), 400);
  }
});

test('classifies a refused write after the session expires', async () => {
  const prepare = (sql: string) => ({ sql, bind() { return this; } });
  const db = {
    prepare,
    async batch<T>(statements: ReturnType<typeof prepare>[]) {
      let expired = false;
      return statements.map(({ sql }) => {
        if (sql.startsWith('INSERT')) {
          expired = true;
          return { results: [] };
        }
        return { results: expired ? [] : [{ status: 404 } as T] };
      });
    },
  };
  await denied(await postFolder(post(), { ...fixture, DB: { withSession: () => db } }), 401);
});

test('cancels a stalled body on the read deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const init = { body, duplex: 'half' };
  // Unref'ed AbortSignal timers alone do not keep the Node test process alive.
  const keepAlive = setTimeout(() => {}, 4_000);
  try {
    await denied(await postFolder(post(init), fixture), 400);
    assert.ok(cancelled);
  } finally { clearTimeout(keepAlive); }
});
