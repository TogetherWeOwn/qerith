import assert from 'node:assert/strict';
import test from 'node:test';
import { listingRequest } from '../src/lib/server/listing-routes';
import { stagingOrigin } from '../src/lib/server/request-auth';
import { admitStagingRequest } from '../src/lib/server/staging-admission';

const origin = 'https://drive.example.test';
const folder = '/api/folder-listing';
const shared = '/api/shared-listing';
const db = { prepare() { assert.fail('listing must not read the raw binding'); } };
const staging = { DB: db, DRIVE_ORIGIN: stagingOrigin, DRIVE_SIGN_IN_FIXTURE: '1', DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };

async function denied(response: Response | undefined, status: number) {
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), '');
  if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
}

test('both listing paths stay closed in staging and outside the disposable fixture', async () => {
  const assets = { signIn: new Set<string>(), root: new Set<string>(), invite: new Set<string>(), people: new Set<string>(), folder: new Set<string>() };
  for (const path of [folder, shared]) {
    const request = new Request(stagingOrigin + path);
    const admission = await admitStagingRequest(request, staging, true, assets);
    assert.ok(admission instanceof Response);
    await denied(admission, 404);
    await denied(await listingRequest(request, staging), 404);
    await denied(await listingRequest(new Request(origin + path), { DB: db, DRIVE_ORIGIN: origin }), 404);
  }
});

test('listing rejects method, origin and malformed inputs and hides binding failures', async () => {
  const env = { DB: { ...db, withSession() { throw new TypeError('internal binding details'); } },
    DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
  const list = (path: string, init?: RequestInit, base = origin) => listingRequest(new Request(base + path, init), env);
  for (const method of ['HEAD', 'POST', 'OPTIONS']) await denied(await list(shared, { method }), 405);
  await denied(await list(shared, { headers: { origin: 'https://other.example.test' } }), 403);
  await denied(await list(shared, { headers: { 'sec-fetch-site': 'same-site' } }), 403);
  await denied(await list(shared, undefined, 'https://other.example.test'), 403);
  for (const path of [folder, `${folder}?folderId=`, `${folder}?folderId=${'x'.repeat(513)}`,
    `${folder}?folderId=root&folderId=other`, `${folder}?folderId=root&direction=up`,
    `${folder}?folderId=root&cursor=${'x'.repeat(2049)}`, `${shared}?cursor=`, `${shared}?ownerId=someone`,
    `${shared}?cursor=a&cursor=b`, `${shared}?cursor=${'%61'.repeat(2800)}`]) await denied(await list(path), 400);
  await denied(await list(shared, { headers: { origin, 'sec-fetch-site': 'same-origin' } }), 503);
});

test('listing rejects invalid query encoding before opening a D1 session', async () => {
  let sessions = 0;
  const DB = { ...db, withSession() { sessions++; return db; } };
  const env = { DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
  for (const value of ['%', '%GG', '%C3%28']) {
    for (const query of [`${folder}?folderId=${value}`, `${shared}?cursor=${value}`]) {
      await denied(await listingRequest(new Request(origin + query), env), 400);
    }
  }
  assert.equal(sessions, 0);
  // A correctly encoded replacement character is a valid opaque ID, not a decoding error.
  await denied(await listingRequest(new Request(`${origin}${shared}?cursor=%EF%BF%BD`), env), 401);
  assert.equal(sessions, 1);
});

test('folder session lookup and page read each start a fresh primary session', async () => {
  const sessions: { constraint: string; reads: string[] }[] = [];
  const DB = { ...db, withSession(constraint: string) {
    const reads: string[] = [];
    sessions.push({ constraint, reads });
    return { prepare() {
      return { bind() {
        return {
          async first<T>() {
            reads.push('session');
            return { id: 'reader', role: 'member' } as T;
          },
          async all<T>() {
            reads.push('folder page');
            return { results: [{ id: null, total: 0 } as T] };
          },
        };
      } };
    } };
  } };
  const request = new Request(`${origin}${folder}?folderId=root`, {
    headers: { cookie: `__Host-drive-session=${'a'.repeat(43)}` },
  });
  const response = await listingRequest(request, { DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' });
  assert.equal(response?.status, 200);
  assert.deepEqual(sessions, [
    { constraint: 'first-primary', reads: ['session'] },
    { constraint: 'first-primary', reads: ['folder page'] },
  ]);
});
