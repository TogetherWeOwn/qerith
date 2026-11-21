import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { exerciseQualificationFiles } from './staging-qualification-files.mjs';

const test = import.meta.main ? nodeTest : () => {};

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { runId: '10', attempt: '2', prefix: 'drive-qualification/full-v0/10/2/' };
const file = `/api/download/${id(1)}`;
const grants = `/api/entries/${id(1)}/read-grants`;
const grant = `${grants}/${id(4)}`;
const folder = n => `/f/${id(n)}`;
const headers = { 'cache-control': 'private, no-store' };
const reply = (status, body = null, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });
const json = (status, value) => reply(status, JSON.stringify(value));
const html = { 'content-type': 'text/html; charset=utf-8' };
const folderRow = row => `<li class="svelte-proof"><svg viewBox="0 0 24 24" aria-hidden="true"><!--[--><path d="M3 19V5h6l2 2h10v12H3Z"></path><!--]--></svg> <a href="/f/${row.id}" dir="auto" class="svelte-proof">${row.name}</a> <span class="kind svelte-proof">Folder</span></li>`;
const main = (name, listing) => `<main data-sveltekit-reload class="svelte-proof"><!--[--><h1 dir="auto" class="svelte-proof">${name}</h1> <!--[-->${listing}<!--]--><!--]--></main>`;
// Svelte emits a filename hash and an empty comment for the title-only <svelte:head>.
const document = content => `<!doctype html><html lang="en"><head><meta charset="utf-8" /><!--1a2b3c4--><!----><title>Qualification · Drive</title><link href="/_app/immutable/assets/folder.css" rel="stylesheet"></head><body><div style="display: contents"><!--[-->${content}<!--]--></div></body></html>`;
const folderPage = (name, listing) => reply(200, document(main(name, listing)), html);
const entries = rows => `<ul role="list">${rows}</ul>`;
const empty = '<section class="empty" aria-labelledby="empty-title"><div><h2 id="empty-title">This folder is empty.</h2></div></section>';

export function setup(intercept = () => undefined, prefix = context.prefix) {
  const fixture = { prefix, fileId: id(1), fileName: 'Test file.bin', fileBytes: Uint8Array.of(1, 128, 255),
    folderId: id(2), folderName: 'Attempt anchor', ownerId: id(3), recipientId: id(4) };
  const folders = [{ id: fixture.folderId, name: fixture.folderName, parentId: null, kind: 'folder' }];
  const calls = [];
  let granted = false;
  const client = actor => async (path, { method, redirect, cache, headers: requestHeaders, signal, body }) => {
    assert.equal(redirect, 'manual');
    assert.equal(cache, 'no-store');
    assert.equal(requestHeaders['sec-fetch-site'], 'same-origin');
    signal.throwIfAborted();
    body = body && JSON.parse(body);
    calls.push(`${actor} ${method} ${path}`);
    const replacement = intercept({ actor, method, path, signal, granted, folders, calls });
    if (replacement !== undefined) return replacement;
    if (path === file) {
      if (actor === 'recipient' && !granted) return reply(404);
      return reply(200, fixture.fileBytes, { 'content-type': 'application/octet-stream', 'content-length': '3',
        'content-disposition': `attachment; filename="Test file.bin"; filename*=UTF-8''Test%20file.bin` });
    }
    assert.equal(actor, 'owner');
    if (path === grants) return json(200, { recipients: granted ? [{ recipientId: fixture.recipientId }] : [], nextCursor: null });
    if (path === grant) { granted = method === 'PUT'; return reply(204); }
    if (method === 'POST') {
      assert.equal(path, '/api/folders');
      assert.ok(folders.some(row => row.id === body.parentId));
      const created = { id: id(folders.length + 4), ...body, kind: 'folder' };
      folders.push(created);
      return json(201, created);
    }
    if (method === 'PATCH') {
      assert.deepEqual(body, { kind: 'move', parentId: id(6) });
      assert.equal(path, `/api/entries/${id(7)}`);
      return json(200, Object.assign(folders[3], { parentId: body.parentId }));
    }
    const selected = folders.find(row => path === `/f/${row.id}`);
    const rows = folders.filter(row => row.parentId === selected.id).map(folderRow).join('');
    return folderPage(selected.name, rows ? entries(rows) : empty);
  };
  return { fixture, provisioning: { prefix, fileId: id(1), folderId: id(2) },
    owner: { principalId: id(3), request: client('owner') },
    recipient: { principalId: id(4), request: client('recipient') }, calls };
}

test('reads the exact file, moves the exact child, and independently verifies grant and revocation', async () => {
  const io = setup();
  assert.deepEqual(await exerciseQualificationFiles(context, undefined, io), {
    'authenticated-file-access': 'pass', 'folder-operations': 'pass', 'share-and-revoke': 'pass',
  });
  assert.deepEqual(io.calls, [
    `owner GET ${file}`, `owner GET ${folder(2)}`, ...Array(3).fill('owner POST /api/folders'),
    `owner GET ${folder(2)}`, `owner GET ${folder(5)}`, `owner GET ${folder(6)}`, `owner PATCH /api/entries/${id(7)}`,
    `owner GET ${folder(5)}`, `owner GET ${folder(6)}`, `owner GET ${grants}`, `recipient GET ${file}`, `owner PUT ${grant}`,
    `owner GET ${grants}`, `recipient GET ${file}`, `owner DELETE ${grant}`, `owner GET ${grants}`, `recipient GET ${file}`, `owner GET ${file}`,
  ]);
});

test('refuses missing or out-of-attempt fixtures and aliased sessions without issuing requests', async () => {
  const io = setup();
  for (const invalid of [undefined, { ...io, fixture: { ...io.fixture, prefix: 'other' } },
    { ...io, fixture: { ...io.fixture, fileId: '../wrong' } },
    { ...io, recipient: { ...io.recipient, request: io.owner.request } }]) {
    await assert.rejects(exerciseQualificationFiles(context, undefined, invalid), /fixture or clients are unverified/);
  }
  assert.deepEqual(io.calls, []);
});

test('rejects a stale fixture relabeled with the current prefix before any request', async () => {
  const io = setup();
  const next = { ...context, attempt: '3', prefix: 'drive-qualification/full-v0/10/3/' };
  io.fixture.prefix = next.prefix;
  await assert.rejects(exerciseQualificationFiles(next, undefined, io), /fixture or clients are unverified/);
  // A current record for different IDs does not authorize this fixture either.
  io.provisioning = { prefix: next.prefix, fileId: id(8), folderId: id(9) };
  await assert.rejects(exerciseQualificationFiles(next, undefined, io), /fixture or clients are unverified/);
  assert.deepEqual(io.calls, []);
});

test('rejects missing provisioning evidence before any request', async () => {
  const io = setup();
  delete io.provisioning;
  await assert.rejects(exerciseQualificationFiles(context, undefined, io), /fixture or clients are unverified/);
  assert.deepEqual(io.calls, []);
});

for (const actor of ['owner', 'recipient']) {
  test(`rejects a mismatched ${actor} session principal before any request`, async () => {
    const io = setup();
    io.fixture[`${actor}Id`] = id(8);
    await assert.rejects(exerciseQualificationFiles(context, undefined, io), /fixture or clients are unverified/);
    assert.deepEqual(io.calls, []);
  });
}

const fileResponse = (bytes, name = 'Test file.bin') => reply(200, Uint8Array.from(bytes), {
  'content-type': 'application/octet-stream', 'content-length': '3',
  'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
});
for (const [name, caseName, intercept] of [
  ['same-length wrong file bytes', 'authenticated-file-access', () => fileResponse([1, 127, 255])],
  ['correct bytes with the wrong file identity', 'authenticated-file-access', () => fileResponse([1, 128, 255], 'Other file.bin')],
  ['oversized file body with the expected headers', 'authenticated-file-access', () => fileResponse([1, 128, 255, 0])],
  ['a redirect instead of the download', 'authenticated-file-access', () => reply(303, null, { location: '/sign-in' })],
  ['an unavailable folder rendered with HTTP 200', 'folder-operations', ({ path }) => path === folder(2) ? reply(200, 'Unavailable') : undefined],
  ['expected child rows inside an HTML comment', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, entries(`<!--${folderRow(folders[3])}-->`)) : undefined],
  ['expected child rows inside an inert template', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, `<template>${entries(folderRow(folders[3]))}</template>`) : undefined],
  ['an otherwise correct folder listing with a continuation link', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, `${entries(folderRow(folders[3]))}<a href="?page=more">Next page</a>`) : undefined],
  ...[
    ['a template-wrapped populated view', view => reply(200, document(`<template>${view}</template>`), html)],
    ['a hidden ancestor of a populated view', view => reply(200, document(`<div hidden>${view}</div>`), html)],
    ['a head hash marker in the folder view', view => reply(200, document(`<!--1a2b3c4-->${view}`), html)],
    ['a CSS-hidden row', view => reply(200, document(view.replace('<li ', '<li style="display:none" ')), html)],
    ['a child anchor inside SVG', view => reply(200, document(view.replace('</svg>', '').replace('</a>', '</a></svg>')), html)],
    ['a non-HTML destination after move', view => reply(200, document(view), { 'content-type': 'text/plain' })],
  ].map(([name, render]) => [name, 'folder-operations', ({ path, folders }) =>
    path === folder(6) && folders[3].parentId === id(6) ? render(main(folders[2].name, entries(folderRow(folders[3])))) : undefined]),
  ['a template-wrapped old parent after move', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(6) ? reply(200, document(`<template>${main(folders[1].name, empty)}</template>`), html) : undefined],
  ['a heading-only old parent after move', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(6) ? folderPage(folders[1].name, '') : undefined],
  ['a comment containing the empty state after move', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(6) ? folderPage(folders[1].name, `<!--${empty}-->`) : undefined],
  ['an acknowledged move with stale source listing', 'folder-operations', ({ method, folders }) => method === 'PATCH'
    ? json(200, { ...folders[3], parentId: id(6) }) : undefined],
  ['a share route that never grants recipient access', 'share-and-revoke', ({ actor, granted }) =>
    actor === 'recipient' && granted ? reply(404) : undefined],
  ['an acknowledged revoke with a stale owner grant', 'share-and-revoke', ({ method }) => method === 'DELETE' ? reply(204) : undefined],
  ['an empty grant list but retained recipient access', 'share-and-revoke', ({ actor, calls }) =>
    actor === 'recipient' && calls.includes(`owner DELETE ${grant}`) ? fileResponse([1, 128, 255]) : undefined],
  ['an access denial that still exposes content', 'share-and-revoke', ({ actor, granted }) =>
    actor === 'recipient' && !granted ? reply(404, 'unexpected content') : undefined],
  ['a grant listing that is not complete', 'share-and-revoke', ({ path }) =>
    path === grants ? json(200, { recipients: [], nextCursor: 'more' }) : undefined],
]) {
  test(`fails closed on ${name}`, async () => {
    await assert.rejects(exerciseQualificationFiles(context, undefined, setup(intercept)), { message: `Qualification case failed: ${caseName}.` });
  });
}

test('cancellation drains a pending download and prevents subsequent steps', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const io = setup(() => reply(200, new ReadableStream({
    pull() { controller.abort(); }, cancel() { cancelled = true; },
  }), fileResponse([]).headers));
  await assert.rejects(exerciseQualificationFiles(context, controller.signal, io), /authenticated-file-access/);
  assert.equal(cancelled, true);
  assert.deepEqual(io.calls, [`owner GET ${file}`]);
});
