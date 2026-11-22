import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { exerciseQualificationFiles } from './staging-qualification-files.mjs';
import { verifyOwnedFolder } from './staging-qualification-folder.mjs';
import { stagingOrigin } from '../src/lib/server/qualification-readiness.ts';

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
const folderRow = row => `<li data-row="${row.id}" class="svelte-proof"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="svelte-glyph"><!--[0--><path d="M3 19V5h6l2 2h10v12H3Z"></path><!--[-1--><!--]--><!--]--></svg><!----> <!--[0--><a href="/f/${row.id}" dir="auto" data-name="" class="svelte-proof">${row.name}</a><!--]--> <span class="kind svelte-proof">Folder</span></li>`;
const move = '<!--[0--><!--$s1--><dialog class="drive-dialog" aria-labelledby="s1-title" closedby="closerequest"><div class="panel"><header><h2 id="s1-title">Move</h2></header><!--$s2--><dialog class="drive-dialog" aria-labelledby="s2-title" closedby="closerequest"><form class="panel" autocomplete="off"><header><h2 id="s2-title">New folder</h2></header></form></dialog></div></dialog><!----> <div class="svelte-proof"><p role="status" class="svelte-proof status"><!--[-1--><!--]--></p></div><!--]-->';
const main = (name, listing) => `<main data-sveltekit-reload="" class="svelte-proof"><!--[0--><h1 dir="auto" tabindex="-1" class="svelte-proof">${name}</h1> ${move} <!--[-1--><!--]--><!--[0-->${listing}<!--]--><!--]--></main>`;
const start = '../_app/immutable/entry/start.A1.js', app = '../_app/immutable/entry/app.B2.js';
const hydration = (name, rows) => `<script>
{
  __sveltekit_fixture = {
    base: new URL("..", location).pathname.slice(0, -1),
    version: "1234"
  };
  const element = document.currentScript.parentElement;
  import("${start}").then(async (kit) => {
    kit.init(__sveltekit_fixture);
    const app = await import("${app}");
    kit.start(app, element, {
      node_ids: [0, 3],
      data: [null,{type:"data",data:{result:{status:"ok",folder:{name:"${name}",entries:[${rows.map(row => `{id:"${row.id}",name:"${row.name}",kind:"folder",movable:true}`).join(',')}],nextPage:null,paged:false,canMove:true}},ownerInvites:true,shareOwner:void 0},uses:{params:["folderId"]}}],
      form: null,
      error: null
    });
  });
}
</script>`;
const document = (name, content, rows = [], script = hydration(name, rows)) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link href="${start}" rel="modulepreload"><link href="${app}" rel="modulepreload">
<link href="../_app/immutable/nodes/3.C3.js" rel="modulepreload">
<!--proof--><!----><title>${name} · Drive</title><link href="../_app/immutable/assets/folder.A1.css" rel="stylesheet"></head><body><div style="display: contents"><!--[-->${content}<!--]-->
${script}</div></body></html>`;
const folderPage = (name, listing, rows) => reply(200, document(name, main(name, listing), rows), html);
const entries = rows => `<ul role="list" class="svelte-proof">${rows}</ul>`;
const empty = '<section class="empty svelte-empty" aria-labelledby="empty-title"><div><h2 id="empty-title" class="svelte-empty">This folder is empty.</h2></div></section>';
const atUrl = (response, url) => Object.defineProperty(response, 'url', { value: url });

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
    if (replacement !== undefined) {
      return path.startsWith('/f/') && !Object.hasOwn(replacement, 'url') ? atUrl(replacement, stagingOrigin + path) : replacement;
    }
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
    const rows = folders.filter(row => row.parentId === selected.id);
    return atUrl(folderPage(selected.name, rows.length ? entries(rows.map(folderRow).join('')) : empty, rows), stagingOrigin + path);
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
  ['expected child rows inside an HTML comment', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, entries(`<!--${folderRow(folders[3])}-->`), [folders[3]]) : undefined],
  ['expected child rows inside an inert template', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, `<template>${entries(folderRow(folders[3]))}</template>`, [folders[3]]) : undefined],
  ['an otherwise correct folder listing with a continuation link', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(5) ? folderPage(folders[1].name, `${entries(folderRow(folders[3]))}<a href="?page=more">Next page</a>`, [folders[3]]) : undefined],
  ...[
    ['a template-wrapped populated view', doc => doc.replace(/<main.*<\/main>/, '<template>$&</template>')],
    ['a hidden ancestor of a populated view', doc => doc.replace(/<main.*<\/main>/, '<div hidden>$&</div>')],
    ['a head hash marker in the folder view', doc => doc.replace('<main ', '<!--1a2b3c4--><main ')],
    ['a CSS-hidden row', doc => doc.replace('<li ', '<li style="display:none" ')],
    ['a child anchor inside SVG', doc => doc.replace('</svg><!----> <!--[0--><a', '<!----> <!--[0--><a').replace('</a>', '</a></svg>')],
    ['a mismatched row link and identity', doc => doc.replace(`href="${folder(7)}"`, `href="${folder(8)}"`)],
    ['a duplicate or unexpected row', doc => doc.replace(/<li .*?<\/li>/, '$&$&')],
    ['an incomplete listing with a populated payload', doc => doc.replace(/<li .*?<\/li>/, '')],
    ['a stale hydration listing that disagrees with visible rows', doc => doc.replace(/entries:\[\{.*?\}\],nextPage/, 'entries:[],nextPage')],
    ['a continuation in the hydration data', doc => doc.replace('nextPage:null', 'nextPage:"more"')],
    ['a non-HTML destination after move', doc => doc, { 'content-type': 'text/plain' }],
  ].map(([name, mutate, headers = html]) => [name, 'folder-operations', ({ path, folders }) => {
    if (path !== folder(6) || folders[3].parentId !== id(6)) return;
    const row = folders[3], title = folders[2].name;
    return reply(200, mutate(document(title, main(title, entries(folderRow(row))), [row])), headers);
  }]),
  ['a template-wrapped old parent after move', 'folder-operations', ({ path, folders }) =>
    path === folder(5) && folders[3].parentId === id(6) ? reply(200, document(folders[1].name, `<template>${main(folders[1].name, empty)}</template>`), html) : undefined],
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

const validAnchor = document('Attempt anchor', main('Attempt anchor', empty));
const layout = '<div class="announcements svelte-layout" data-drive-announcements=""><div role="status" aria-live="polite" aria-atomic="true"></div> <div aria-live="assertive" aria-atomic="true"></div></div>';
test('accepts only empty shared live regions in the emitted folder document', () => {
  const body = regions => new TextEncoder().encode(validAnchor.replace('</main>', `</main><!----> ${regions}`));
  const folder = { name: 'Attempt anchor' };
  verifyOwnedFolder(body(layout), folder, [], id(1));
  assert.throws(() => verifyOwnedFolder(body(layout.replace('aria-atomic="true"></div>', 'aria-atomic="true">Unexpected</div>')), folder, [], id(1)), /Invalid owned folder document/);
});

for (const [name, response] of [
  ['signed-out folder access', () => reply(401)],
  ['a rejected origin', () => reply(403)],
  ['an unavailable folder rendered with HTTP 200', () => reply(200, 'Unavailable', html)],
  ['a same-name document from another folder', () => atUrl(reply(200, validAnchor, html), stagingOrigin + folder(9))],
  ['a document from another origin', () => atUrl(reply(200, validAnchor, html), 'https://extra.example.test' + folder(2))],
  ['a document with no response URL', () => atUrl(reply(200, validAnchor, html), '')],
  ['a wrong folder name', () => folderPage('Another anchor', empty)],
  ['a missing owned Move status', () => reply(200, validAnchor.replace(/<div class="svelte-proof"><p.*?<\/p><\/div>/, ''), html)],
  ['an open Move dialog', () => reply(200, validAnchor.replace('<dialog ', '<dialog open '), html)],
  ['a malformed Move dialog', () => reply(200, validAnchor.replace('</form>', ''), html)],
  ['an unrecognized hydration script', () => reply(200, validAnchor.replace('<script>', '<script>extra();'), html)],
  ['a missing hydration script', () => reply(200, document('Attempt anchor', main('Attempt anchor', empty), [], ''), html)],
  ['malformed UTF-8', () => reply(200, Buffer.concat([Buffer.from(validAnchor), Buffer.of(255)]), html)],
]) {
  test(`rejects ${name} before folder mutation`, async () => {
    const io = setup(({ path }) => path === folder(2) ? response() : undefined);
    await assert.rejects(exerciseQualificationFiles(context, undefined, io), /folder-operations/);
    assert.deepEqual(io.calls, [`owner GET ${file}`, `owner GET ${folder(2)}`]);
  });
}

test('cancels an oversized folder stream before mutation', async () => {
  let cancelled = false;
  const io = setup(({ path }) => path === folder(2) ? reply(200, new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(validAnchor.padEnd(65537))); },
    cancel() { cancelled = true; },
  }), html) : undefined);
  await assert.rejects(exerciseQualificationFiles(context, undefined, io), /folder-operations/);
  assert.equal(cancelled, true);
  assert.deepEqual(io.calls, [`owner GET ${file}`, `owner GET ${folder(2)}`]);
});

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

test('cancellation drains a pending folder document before mutation', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const io = setup(({ path }) => path === folder(2) ? reply(200, new ReadableStream({
    pull() { controller.abort(); }, cancel() { cancelled = true; },
  }), html) : undefined);
  await assert.rejects(exerciseQualificationFiles(context, controller.signal, io), /folder-operations/);
  assert.equal(cancelled, true);
  assert.deepEqual(io.calls, [`owner GET ${file}`, `owner GET ${folder(2)}`]);
});
