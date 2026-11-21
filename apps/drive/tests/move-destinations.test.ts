import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenHash } from '../src/lib/server/identity/sessions';
import { getMoveDestinations, moveDestinationsPath } from '../src/lib/server/move-destinations';
import { stagingOrigin } from '../src/lib/server/request-auth';

const token = 'a'.repeat(43);
const url = stagingOrigin + moveDestinationsPath;
const env = { DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
const request = (query: string, headers?: HeadersInit) => new Request(url + query, {
  headers: { cookie: `__Host-drive-session=${token}`, ...headers },
});

test('move destinations fail closed before any D1 read', async () => {
  const DB = { prepare() { assert.fail('must not use the raw DB'); }, withSession() { assert.fail('must not query'); } };
  const cases = [
    [request('?entry=source'), { DB, DRIVE_ORIGIN: stagingOrigin }, 404],
    [request('?entry=source'), { DB, ...env, DRIVE_STAGING_INVITE_ACCEPTANCE: '0' }, 404],
    [new Request(`${url}?entry=source`, { method: 'HEAD' }), { DB, ...env }, 404],
    [request('?entry=source', { 'sec-fetch-site': 'same-site' }), { DB, ...env }, 403],
    [request('?entry=source', { origin: 'https://elsewhere.example.test' }), { DB, ...env }, 403],
    [request('?entry=source', { cookie: '' }), { DB, ...env }, 401],
    ...['', '?entry=', '?entry=..', '?entry=%C3%28', '?entry=a&entry=b', '?entry=a&owner=b', '?entry=a&after=',
      '?entry=a&folder=%2Fetc', `?entry=${'a'.repeat(4096)}`].map(query => [request(query), { DB, ...env }, 400] as const),
  ] as const;
  for (const [input, settings, status] of cases) {
    const response = await getMoveDestinations(input, settings);
    assert.equal(response.status, status, input.url.slice(0, 200));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), '');
  }
});

test('an unavailable destination on a primary binding returns an empty, non-cacheable 404', async () => {
  let usedPrimary = false;
  const DB = new Proxy({ prepare() { assert.fail('must not use the raw DB'); } }, {
    get(target, key, receiver) {
      if (key !== 'withSession') return Reflect.get(target, key, receiver);
      return (constraint: string) => {
        assert.equal(constraint, 'first-primary');
        usedPrimary = true;
        return { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
      };
    },
  });
  const response = await getMoveDestinations(request('?entry=source&folder=missing'), { DB, ...env });
  assert.equal(response.status, 404);
  assert.equal(usedPrimary, true);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), '');
});

test('move destination read uses one primary statement and projects at most 50 folder IDs and names', async () => {
  let sessions = 0;
  const rows = Array.from({ length: 51 }, (_, i) => ({ folderName: 'Taxes', currentParentId: 'current',
    id: `folder-${i + 1}`, name: `Folder ${i + 1}`, owner_id: 'not projected' }));
  const expectedHash = await tokenHash(token);
  const DB = { prepare() { assert.fail('must not use the raw DB'); }, withSession(constraint: string) {
    assert.equal(constraint, 'first-primary');
    sessions++;
    return { prepare: () => ({ bind: (...args: unknown[]) => {
      assert.deepEqual(args, [expectedHash, 'entry ∑', 'taxes', 'cursor']);
      return { all: async () => ({ results: rows }) };
    } }) };
  } };
  const response = await getMoveDestinations(request('?entry=entry+%E2%88%91&folder=taxes&after=cursor'), { DB, ...env });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { folderName: 'Taxes', currentParentId: 'current',
    folders: rows.slice(0, 50).map(({ id, name }) => ({ id, name })), next: 'folder-50' });
  assert.equal(sessions, 1);
});
