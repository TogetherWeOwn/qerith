import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { privateRequests } from '../../drive/src/lib/server/request-auth.ts';
import { uploadRoutes } from '../../drive/src/lib/server/upload-routes.ts';
import { config, epoch, migrations, response, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, qualified } from './fixtures/upload-publication-generation.mjs';
const origin = 'https://drive.example.test';
const uploadId = 'provider-upload-id', tag = '"provider-part-tag"', minimum = 5 * 1024 * 1024;

async function fixture({ fail, verify, beforeHead, isQualified = qualified, endpoint = config.endpoint,
  size = 7, completionTimeoutMs = () => 15_000 } = {}) {
  await applyD1Migrations(env.DB, migrations);
  const intent = crypto.randomUUID(), key = `private-storage-${intent}`, principal = `uploader-${intent}`;
  const other = `other-${intent}`, calls = [], parts = [];
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active'), (?, 'member', 'active')", principal, other).run();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', ?)", intent, principal, key, size).run();
  await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, intent).run();
  const { token } = await sessions.issue(principal), foreign = (await sessions.issue(other)).token;
  const bindings = { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: isQualified ? { isQualified: (id) => isQualified(id, intent), completionTimeoutMs,
      verifyParts: (upload) => verify ? verify(upload, parts) : [...parts].sort((a, b) => a.partNumber - b.partNumber) } : undefined };
  const routes = uploadRoutes(bindings, { timeoutMs: 5000, async fetch(request) {
    calls.push(request.method);
    if (request.method === fail) throw new Error(`provider detail: ${key}`);
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/${config.bucket}/${key}`);
    if (request.method === 'PUT') {
      parts.push({ partNumber: Number(url.searchParams.get('partNumber')), etag: tag, size: (await request.arrayBuffer()).byteLength });
      return new Response(null, { headers: { etag: tag } });
    }
    if (request.method === 'POST') return response(key);
    expect(request.headers.get('if-match')).toBe(etag);
    await beforeHead?.(token);
    return new Response(null, { headers: { etag, 'content-length': String(size) } });
  } });
  const handle = privateRequests(bindings);
  function send(number, { auth = token, source = origin, host = origin, name = 'file', bytes = 7 } = {}) {
    const body = number ? new Uint8Array(bytes) : JSON.stringify({ parentId: null, name });
    const headers = { 'content-type': number ? 'application/octet-stream' : 'application/json', 'content-length': String(body.length) };
    if (auth) headers.cookie = `__Host-drive-session=${auth}`;
    if (source) headers.origin = source;
    const request = new Request(`${host}/api/uploads/${intent}/${number ? `parts/${number}` : 'complete'}`,
      { method: number ? 'PUT' : 'POST', body, headers });
    return handle({ event: { request, locals: {} }, resolve: ({ locals }) => number
      ? routes.part(request, locals.driveSession, intent, String(number))
      : routes.complete(request, locals.driveSession, intent) });
  }
  const generation = () => sql('SELECT entry_id, size_bytes, etag FROM drive_published_generations WHERE intent_id = ?', intent).first();
  return { send, generation, calls, foreign, key, principal };
}

it('publishes a verified sparse upload without duplicate part or completion sends', async () => {
  const { send, generation, calls, foreign } = await fixture({ size: minimum + 7 });
  expect((await send()).status).toBe(409); // An empty seal must roll back.
  const part = { bytes: minimum };
  expect((await Promise.all([send(1, part), send(1, part)])).map(({ status }) => status).sort()).toEqual([204, 404]);
  expect((await send(3)).status).toBe(204);
  const published = await send(), receipt = await published.json();
  expect([published.status, published.headers.get('cache-control'), receipt])
    .toEqual([201, 'private, no-store', { id: expect.any(String) }]);
  expect(await generation()).toEqual({ entry_id: receipt.id, size_bytes: minimum + 7, etag });
  const replay = await send();
  expect([replay.status, await replay.json()]).toEqual([200, receipt]);
  for (const options of [{ auth: foreign }, { name: 'different' }]) expect((await send(undefined, options)).status).toBe(404);
  expect(calls).toEqual(['PUT', 'PUT', 'POST', 'HEAD']);
});

it('applies exact origin, session, owner and next-request revocation to both mutations', async () => {
  const { send, calls, foreign, principal } = await fixture();
  for (const number of [1, undefined]) for (const [options, status] of [
    [{ source: null }, 403], [{ source: `${origin}, ${origin}` }, 403], [{ host: 'https://other.example.test' }, 403],
    [{ auth: null }, 401], [{ auth: foreign }, 404]
  ]) expect((await send(number, options)).status).toBe(status);
  await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", principal).run();
  for (const number of [1, undefined]) expect((await send(number)).status).toBe(401);
  expect(calls).toEqual([]);
});

it.each([
  [{ isQualified: null }, 503], [{ completionTimeoutMs: () => null }, 503],
  [{ endpoint: 'https://different.example' }, 404]
])('refuses unqualified or different storage before a provider call (%j)', async (options, status) => {
  const { send, calls } = await fixture(options);
  for (const number of [1, undefined]) expect((await send(number)).status).toBe(status);
  expect(calls).toEqual([]);
});

it.each(['PUT', 'POST', 'qualification'])('preserves send fences and empty errors (%s)', async (fail) => {
  const partFailed = fail !== 'POST';
  let checkPart = fail === 'qualification';
  const part = { bytes: partFailed ? minimum : 7 };
  const { send, calls, generation } = await fixture({ fail, size: partFailed ? minimum + 7 : 7,
    isQualified: async (id, intent) => await qualified(id) && (!checkPart ||
      !await sql('SELECT 1 FROM drive_upload_part_operations WHERE intent_id = ?', intent).first()) });
  const first = await send(1, part);
  expect([first.status, await first.text()]).toEqual([partFailed ? 409 : 204, '']);
  checkPart = false;
  if (partFailed) expect([(await send(1, part)).status, (await send(2)).status]).toEqual([404, 404]);
  expect([(await send()).status, (await send()).status]).toEqual([409, partFailed ? 409 : 404]);
  expect(await generation()).toBeNull();
  expect(calls).toEqual(fail === 'POST' ? ['PUT', 'POST'] : fail === 'PUT' ? ['PUT'] : []);
});

it.each(['provider error', 'qualification', 'session'])('requires current authority when publishing (%s)', async (veto) => {
  let current = true, verifications = 0, heads = 0;
  const { send, foreign, generation, calls, key } = await fixture({
    isQualified: (id) => current && qualified(id),
    verify: (_, parts) => { if (++verifications === 1) current = false; return parts; },
    beforeHead: (token) => {
      if (++heads !== 1) return;
      if (veto === 'session') return sessions.revoke(token);
      if (veto === 'provider error') throw new Error('Transient HEAD failure');
      current = false;
    }
  });
  expect([(await send(1)).status, (await send()).status]).toEqual([204, 409]);
  expect(calls).toEqual(['PUT']);
  current = true;
  expect((await send()).status).toBe(409);
  expect(await generation()).toBeNull();
  expect(await sql('SELECT id FROM drive_entries WHERE object_key = ?', key).first()).toBeNull();
  current = true;
  expect((await send(undefined, { auth: foreign })).status).toBe(404);
  expect((await send()).status).toBe(veto === 'session' ? 401 : 201);
  expect(calls).toEqual(veto === 'session' ? ['PUT', 'POST', 'HEAD'] : ['PUT', 'POST', 'HEAD', 'HEAD']);
});

it('checks sibling conflicts before sealing and again at dispatch', async () => {
  const occupy = (owner, name) => sql("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, 'folder')",
    crypto.randomUUID(), owner, name).run();
  let verifies = 0;
  const { send, calls, principal } = await fixture({ verify: async ({ ownerId }, parts) => {
    if (++verifies === 1) await occupy(ownerId, 'file');
    return parts;
  } });
  await occupy(principal, 'occupied');
  expect((await send(undefined, { name: 'occupied' })).status).toBe(404);
  expect((await send(1)).status).toBe(204);
  expect((await send()).status).toBe(409);
  expect(calls).toEqual(['PUT']);
  expect((await send(undefined, { name: 'free' })).status).toBe(201);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
});

it('rejects impossible small-part layouts without consuming slots', async () => {
  const { send, calls } = await fixture({ size: minimum + 7 });
  for (const [number, bytes, status] of [[10_000, minimum, 404], [1, 7, 404], [3, 6, 204], [4, minimum + 1, 404],
    [1, minimum - 1, 404], [1, minimum, 404], [1, minimum + 2, 404], [1, minimum + 1, 204], [undefined, 0, 201]])
    expect((await send(number, { bytes })).status).toBe(status);
  expect(calls).toEqual(['PUT', 'PUT', 'POST', 'HEAD']);
});
