import { deepStrictEqual as equal } from 'node:assert/strict';
import { qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value) && value === value.trim();

// Recognize only the script-free folder SSR shell and its direct children.
// Allow Svelte markers between elements, never strip them out of tag syntax.
const gap = String.raw`(?:[ \t\r\n\f]|<!--(?:\[!?-?\d*|\])?-->)*`;
const css = '(?: class="svelte-[a-z0-9]+")?';
const headAttrs = '(?: [a-z-]+="[^"<>]*")+';
const headChild = `(?:<(?:meta|link)${headAttrs} */?>|<title>[^<]*</title>)`;
const folderDocument = new RegExp(`^${gap}<!doctype html>${gap}<html lang="en">${gap}<head>(?:${gap}${headChild})*${gap}</head>${gap}` +
  `<body>${gap}<div style="display: contents">${gap}<main data-sveltekit-reload(?:="")?${css}>${gap}` +
  `<h1 dir="auto"${css}>([^<]*)</h1>([\\s\\S]*?)</main>${gap}</div>${gap}</body>${gap}</html>${gap}$`);
const emptyFolder = new RegExp(`^${gap}<section class="empty(?: svelte-[a-z0-9]+)?" aria-labelledby="empty-title">${gap}` +
  `<div${css}>${gap}<h2 id="empty-title"${css}>This folder is empty\\.</h2>${gap}</div>${gap}</section>${gap}$`);
const folderList = new RegExp(`^${gap}<ul role="list"${css}>([\\s\\S]*?)</ul>${gap}$`);
const onlyGap = new RegExp(`^${gap}$`);
const glyph = '<svg(?: (?:viewBox|aria-hidden|fill|stroke(?:-width|-linecap|-linejoin)?|class)="[^"<>]*")+>' +
  `${gap}<path d="[a-zA-Z0-9 .-]+"(?: */>|></path>)${gap}</svg>`;
const row = `<li${css}>${gap}${glyph}${gap}<a href="(/f/[0-9a-f-]+)" dir="auto"${css}>([^<]*)</a>${gap}` +
  `<span class="kind(?: svelte-[a-z0-9]+)?">Folder</span>${gap}</li>`;

async function boundedBody(response, signal, limit) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let done = false, size = 0, cancelled;
  const chunks = [];
  const cancel = () => { cancelled ??= reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (!done) {
      const part = await reader.read();
      signal.throwIfAborted();
      done = part.done;
      if (done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('Oversized qualification response.');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) cancel();
    await cancelled;
    reader.releaseLock();
  }
}

// Unwired. Use the protected caller's independent provisioning record for the
// exact attempt's file and empty anchor, not values copied from the fixture.
// Each client pairs its request function with the principal verified for that
// isolated session. Functions take relative paths, supply session and same-origin
// Origin on writes, honor manual redirects, and stop/drain on abort. No retries
// or shared cookies. The caller tears down even after ambiguous writes.
export async function exerciseQualificationFiles(context, signal, {
  owner: ownerSession, recipient: recipientSession, fixture, provisioning,
} = {}) {
  const prefix = qualificationPrefix(context);
  const { fileId, fileName, fileBytes, folderId, folderName, ownerId, recipientId } = fixture ?? {};
  const ids = [fileId, folderId, ownerId, recipientId];
  const owner = ownerSession?.request, recipient = recipientSession?.request;
  if (context.prefix !== prefix || fixture?.prefix !== prefix || provisioning?.prefix !== prefix ||
      provisioning.fileId !== fileId || provisioning.folderId !== folderId || !ids.every(uuid) || new Set(ids).size !== ids.length ||
      !label(fileName) || !label(folderName) || !(fileBytes instanceof Uint8Array) || !fileBytes.length || fileBytes.length > 4096 ||
      ownerSession?.principalId !== ownerId || recipientSession?.principalId !== recipientId ||
      typeof owner !== 'function' || typeof recipient !== 'function' || owner === recipient) {
    throw new Error('Authenticated qualification fixture or clients are unverified.');
  }
  const bytes = Buffer.from(fileBytes);
  const download = `/api/download/${fileId}`;
  const grants = `/api/entries/${fileId}/read-grants`;
  const results = {};
  const exercise = async (name, steps) => {
    try {
      await runQualificationPhase(async (_, active) => {
        const ask = async (client, path, { status = 200, method = 'GET', body, limit = 4096, headers = {}, html = false } = {}) => {
          const response = await client(path, { method, signal: active, redirect: 'manual', cache: 'no-store',
            headers: { 'sec-fetch-site': 'same-origin', ...(body && { 'content-type': 'application/json' }) },
            body: body && JSON.stringify(body) });
          try {
            active.throwIfAborted();
            equal([response.status, response.redirected, response.headers.has('location')], [status, false, false]);
            for (const [key, expected] of Object.entries({ 'cache-control': 'private, no-store', ...headers })) {
              equal(response.headers.get(key), expected);
            }
            if (html) equal(/^text\/html(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(response.headers.get('content-type')), true);
            return await boundedBody(response, active, limit);
          } finally {
            if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
          }
        };
        const readFile = async client => equal(await ask(client, download, { limit: bytes.length, headers: {
          'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
          'content-disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'content-range': null, 'content-encoding': null,
        } }), bytes);
        await steps(ask, readFile);
      }, null, signal, 60_000);
      results[name] = 'pass';
    } catch {
      throw new Error(`Qualification case failed: ${name}.`);
    }
  };

  await exercise('authenticated-file-access', (_ask, readFile) => readFile(owner));
  await exercise('folder-operations', async ask => {
    const seen = new Set(ids);
    const entry = (id, parentId, name) => ({ id, parentId, name, kind: 'folder' });
    const create = async (name, parentId) => {
      const created = JSON.parse(await ask(owner, '/api/folders', { status: 201, method: 'POST', body: { name, parentId } }));
      if (!uuid(created.id) || seen.has(created.id)) throw new Error('Invalid created folder identity.');
      equal(created, entry(created.id, parentId, name));
      seen.add(created.id);
      return created;
    };
    // Staging admits SSR folders, not the disposable fixture JSON listing.
    const list = async (folder, children) => {
      const html = (await ask(owner, `/f/${folder.id}`, { html: true, limit: 65536 })).toString('utf8');
      const [, name, listing] = html.match(folderDocument) ?? [];
      equal(name, folder.name);
      if (!children.length) {
        equal(emptyFolder.test(listing), true);
        return;
      }
      const [, body] = listing.match(folderList) ?? [];
      if (body === undefined) throw new Error('Incomplete folder listing.');
      const rows = [];
      const next = new RegExp(`${gap}${row}`, 'y');
      for (const _ of children) {
        const match = next.exec(body);
        if (!match) throw new Error('Incomplete folder listing.');
        rows.push(match.slice(1));
      }
      equal(onlyGap.test(body.slice(next.lastIndex)), true);
      equal(rows.sort(), children.map(child => [`/f/${child.id}`, child.name]).sort());
    };
    const anchor = { id: folderId, name: folderName };
    await list(anchor, []);
    const source = await create('Qualification source', folderId);
    const target = await create('Qualification destination', folderId);
    const child = await create('Qualification child', source.id);
    await list(anchor, [source, target]);
    await list(source, [child]);
    await list(target, []);
    equal(JSON.parse(await ask(owner, `/api/entries/${child.id}`, {
      method: 'PATCH', body: { kind: 'move', parentId: target.id },
    })), entry(child.id, target.id, child.name));
    await list(source, []);
    await list(target, [child]);
  });
  await exercise('share-and-revoke', async (ask, readFile) => {
    const noRead = () => ask(recipient, download, { status: 404, limit: 0 });
    const readGrants = async recipients => equal(JSON.parse(await ask(owner, grants)), { recipients, nextCursor: null });
    const changeGrant = method => ask(owner, `${grants}/${recipientId}`, { status: 204, method, limit: 0 });
    await readGrants([]);
    await noRead();
    await changeGrant('PUT');
    await readGrants([{ recipientId }]);
    await readFile(recipient);
    await changeGrant('DELETE');
    await readGrants([]);
    await noRead();
    await readFile(owner);
  });
  signal?.throwIfAborted();
  return results;
}
