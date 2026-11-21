import assert from 'node:assert/strict';
import test from 'node:test';
import { folderPage } from '../src/lib/server/folder-page';
import { stagingOrigin } from '../src/lib/server/request-auth';
import { loadFolder } from '../src/routes/f/[folderId]/load-folder';
import { moveNeighbor, openFolderMove, readMoveReceipt } from '../src/routes/f/[folderId]/move-action';

const savedMove = { source: 'B', target: null, rows: ['A', 'B', 'C', 'D'], until: 0 };
test('Move focus prefers the next surviving original row and falls back to the heading', () => {
  for (const [live, expected] of [['CD', 'C'], ['AC', 'C'], ['A', 'A'], ['', undefined], ['Z', undefined]] as const)
    assert.equal(moveNeighbor(savedMove, [...live].map(id => ({ id }))), expected, live);
});
test('Move receipt links only to the current parent, including My Drive', async t => {
  let currentParentId: string | null = 'other';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ folderName: 'My Drive', currentParentId }));
  assert.equal(await readMoveReceipt(savedMove), null);
  currentParentId = null;
  assert.deepEqual(await readMoveReceipt(savedMove), { id: null, name: 'My Drive' });
});

const request = (query = '') => new Request(`https://example.test/f/private?${query}`);
const unavailable = { status: 'unavailable' };
const authorize = async () => 'session-token';
const get = async (_token: string, id: string) => ({ id, name: 'Receipts', kind: 'folder' as const, owner_id: 'private-owner' });

test('does not read without authorization or with a malformed page', async () => {
  const read = test.mock.fn(async () => null);
  const readAccess = { get: read, list: read };
  assert.deepEqual(await folderPage(request(), 'private', { authorize: async () => null, readAccess }), unavailable);
  for (const bad of ['page=', 'page=a&page=b', `page=${'x'.repeat(379)}`])
    assert.deepEqual(await folderPage(request(bad), 'private', { authorize, readAccess }), unavailable);
  assert.equal(read.mock.callCount(), 0);
});

test('rejects invalid folder IDs before authorization or metadata reads', async () => {
  const auth = test.mock.fn(authorize);
  const readFolder = test.mock.fn(get);
  const list = test.mock.fn(async () => ({ entries: [], nextCursor: null }));
  const deps = { authorize: auth, readAccess: { get: readFolder, list } };
  for (const [label, id] of [['empty', ''], ['dot', '.'], ['dot-dot', '..'], ['129 characters', 'x'.repeat(129)]]) {
    assert.deepEqual(await folderPage(request(), id, deps), unavailable, label);
    assert.equal(auth.mock.callCount(), 0, label);
    assert.equal(readFolder.mock.callCount(), 0, label);
    assert.equal(list.mock.callCount(), 0, label);
  }

  const id = 'x'.repeat(128);
  const req = request();
  assert.deepEqual(await folderPage(req, id, deps), {
    status: 'ok', folder: { name: 'Receipts', entries: [], nextPage: null, paged: false }
  });
  assert.deepEqual(auth.mock.calls.map(call => call.arguments), [[req]]);
  assert.deepEqual(readFolder.mock.calls.map(call => call.arguments), [[await authorize(), id]]);
  assert.deepEqual(list.mock.calls.map(call => call.arguments), [[await authorize(), id, null]]);
});

test('stops before listing when the folder lookup is denied or returns a file', async () => {
  for (const folder of [null, { ...await get('', 'private'), kind: 'file' as const }]) {
    const readFolder = test.mock.fn(async () => folder);
    const list = test.mock.fn(async () => ({ entries: [], nextCursor: null }));
    assert.deepEqual(await folderPage(request(), 'private', { authorize, readAccess: { get: readFolder, list } }), unavailable);
    assert.equal(readFolder.mock.callCount(), 1);
    assert.equal(list.mock.callCount(), 0);
  }
});

test('projects safe fields and resumes a stable opaque boundary for an overlong entry ID', async () => {
  const cursor = { id: 'x'.repeat(4096), name: `Résumé ${'é'.repeat(123)}` };
  const later = { id: 'next', name: 'Z', kind: 'file' as const };
  const last = { id: 'last', name: 'ZZ', kind: 'file' as const };
  for (const anchor of [cursor, { ...cursor, name: 'A' }]) {
    const item = { ...anchor, kind: 'file' as const };
    const readAccess = { get, list: async () => ({ entries: [{ ...item, object_key: 'private-key' }], nextCursor: anchor }) };
    const page = await folderPage(request(), 'private', { authorize, readAccess });
    assert(page.status === 'ok' && page.folder.nextPage);
    assert.deepEqual(page.folder.entries, [item]);
    assert.match(page.folder.nextPage, /^[A-Za-z0-9_-]{378}$/);
    const next = request(`page=${page.folder.nextPage}`);
    // An entry that takes the boundary name is behind the cursor too.
    for (const entries of [[later], [{ ...item, id: 'replacement', name: anchor.name }, later], null]) {
      const list = test.mock.fn(async (_token: string, _id: string, after?: typeof cursor | null) =>
        after?.name === later.name ? { entries: [last], nextCursor: null } : entries && { entries, nextCursor: later });
      const deps = { authorize, readAccess: { get, list } };
      const continuation = await folderPage(next, 'private', deps);
      assert.deepEqual(list.mock.calls.map(call => call.arguments), [[await authorize(), 'private', { name: anchor.name, id: '' }]]);
      if (!entries) {
        assert.deepEqual(continuation, unavailable);
        continue;
      }
      assert(continuation.status === 'ok' && continuation.folder.nextPage);
      const { nextPage, ...rest } = continuation.folder;
      assert.deepEqual(rest, { name: 'Receipts', entries: [later], paged: true });
      assert.match(nextPage, /^[A-Za-z0-9_-]{378}$/);
      assert.deepEqual(await folderPage(request(`page=${nextPage}`), 'private', deps), {
        status: 'ok', folder: { name: 'Receipts', entries: [last], nextPage: null, paged: true }
      });
      assert.equal(list.mock.callCount(), 2);
      assert.deepEqual(list.mock.calls[1].arguments, [await authorize(), 'private', { name: later.name, id: '' }]);
    }
    assert.deepEqual(await folderPage(next, 'other', { authorize, readAccess }), unavailable);
    assert.deepEqual(await folderPage(next, 'private', { authorize: async () => 'another-session', readAccess }), unavailable);
  }
});

test('only projects a positive download hint on a canonical file ID', async () => {
  const id = '00000000-0000-4000-8000-000000000611';
  const file = { id, name: 'Available', kind: 'file' as const };
  const entries = [
    { ...file, downloadable: 1 as const, object_key: 'private-key' },
    { ...file, id: id.slice(0, -1) + '2', downloadable: 0 as const },
    { ...file, id: id.slice(0, -1) + '3' },
    { ...file, id: 'legacy-file', downloadable: 1 as const },
    { ...file, id: 'folder', kind: 'folder' as const, downloadable: 1 as const },
  ];
  const readAccess = { get, list: async () => ({ entries, nextCursor: null }) };
  const page = await folderPage(request(), 'private', { authorize, readAccess });
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.folder.entries, [
    { ...file, downloadable: true },
    ...entries.slice(1).map(({ id, name, kind }) => ({ id, name, kind })),
  ]);
});

test('nested loader and picker dispatch allow only owned, addressable rows in invite mode', async () => {
  const file = { id: '00000000-0000-4000-8000-000000000611', name: 'Invoice.pdf', kind: 'file' };
  const folder = { id: 'a folder/雪', name: '2026', kind: 'folder' };
  const invalid = { ...file, id: '..' };
  for (const role of ['owner', 'member'] as const) for (const [invite, owned] of [[false, 1], [true, 0], [true, 1]] as const) {
    const statement = {
      bind: () => statement,
      first: async <T>() => await get('', 'private') as T,
      all: async <T>() => ({ results: [{ id: null, owned }, { ...file, downloadable: 1, object_key: 'private-key' }, folder, { ...invalid, movable: true }] as T[] }),
    };
    const withSession = test.mock.fn((_mode: 'first-primary') => ({ prepare: () => statement }));
    const origin = invite ? stagingOrigin : 'https://drive.example.test';
    const { result } = await loadFolder({ DB: { withSession }, DRIVE_ORIGIN: origin,
      ...(invite ? { DRIVE_STAGING_INVITE_ACCEPTANCE: '1' } : { DRIVE_SIGN_IN_FIXTURE: '1' }),
    })({
      request: new Request(`${origin}/f/private`), params: { folderId: 'private' }, setHeaders: () => {},
      locals: { driveSession: { token: 'a'.repeat(43), principal: { id: 'principal', role } } },
    });
    assert.deepEqual(withSession.mock.calls.map(call => call.arguments), [['first-primary'], ['first-primary']]);
    assert.equal(result.status, 'ok');
    const flag = invite && owned ? { movable: true } : {};
    assert.equal(result.folder.canMove, flag.movable);
    assert.deepEqual(result.folder.entries, [{ ...file, downloadable: true, ...flag }, { ...folder, ...flag }, invalid]);
    const open = test.mock.fn<Parameters<typeof openFolderMove>[2]>();
    for (const { id } of [...result.folder.entries, { id: 'not-on-this-page' }]) openFolderMove(result, id, open);
    openFolderMove({ status: 'unavailable' }, file.id, open);
    assert.deepEqual(open.mock.calls.map(call => call.arguments), flag.movable ? [[file], [folder]] : []);
  }
});

test('does not disclose the title if live listing is denied, fails or exceeds the bound', async () => {
  for (const list of [async () => null, async () => { throw new Error('storage failed'); }, async () => ({ entries: Array(101).fill(await get('', 'private')), nextCursor: null })])
    assert.deepEqual(await folderPage(request(), 'private', { authorize, readAccess: { get, list } }), unavailable);
});
