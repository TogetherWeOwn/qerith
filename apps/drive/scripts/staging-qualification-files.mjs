import { deepStrictEqual as equal } from 'node:assert/strict';
import { qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(value) && value === value.trim();

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

// Unwired. The protected caller must provision and bind the file and empty
// anchor to this attempt, keep the owner and active recipient sessions isolated,
// and tear down the fixture even after ambiguous writes. Clients take relative
// paths, inject their own session and same-origin Origin on writes, and must
// honor manual redirects and stop/drain on abort. No retries or shared cookies.
export async function exerciseQualificationFiles(context, signal, { owner, recipient, fixture } = {}) {
  const prefix = qualificationPrefix(context);
  const { fileId, fileName, fileBytes, folderId, folderName, ownerId, recipientId } = fixture ?? {};
  const ids = [fileId, folderId, ownerId, recipientId];
  if (context.prefix !== prefix || fixture?.prefix !== prefix || !ids.every(uuid) || new Set(ids).size !== ids.length ||
      !label(fileName) || !label(folderName) || !(fileBytes instanceof Uint8Array) || !fileBytes.length || fileBytes.length > 4096 ||
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
        const ask = async (client, path, { status = 200, method = 'GET', body, limit = 4096, headers = {} } = {}) => {
          const response = await client(path, { method, signal: active, redirect: 'manual', cache: 'no-store',
            headers: { 'sec-fetch-site': 'same-origin', ...(body && { 'content-type': 'application/json' }) },
            body: body && JSON.stringify(body) });
          try {
            active.throwIfAborted();
            equal([response.status, response.redirected, response.headers.has('location')], [status, false, false]);
            for (const [key, expected] of Object.entries({ 'cache-control': 'private, no-store', ...headers })) {
              equal(response.headers.get(key), expected);
            }
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
      const html = (await ask(owner, `/f/${folder.id}`, { limit: 65536 })).toString('utf8');
      equal([...html.matchAll(/<h1\b[^>]*>([^<]*)<\/h1>/g)].map(match => match[1]), [folder.name]);
      equal(/href="\?page=/.test(html), false);
      const rows = [...html.matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/g)].map(row => {
        const links = [...row[1].matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
        equal(links.length, 1);
        return links[0].slice(1);
      });
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
