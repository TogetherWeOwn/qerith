import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { privateRequests } from '../../drive/src/lib/server/request-auth.ts';
import { uploadRoutes } from '../../drive/src/lib/server/upload-routes.ts';
import { config, epoch, migrations, response, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, qualified } from './fixtures/upload-publication-generation.mjs';

const origin = 'https://drive.example.test';
const uploadId = 'provider-upload-id';
const tag = '"provider-part-tag"';

async function fixture({ fail, verify, beforeHead, verifierPresent = true, endpoint = config.endpoint,
  size = 7, completionTimeoutMs = () => 15_000 } = {}) {
  await applyD1Migrations(env.DB, migrations);
  const intent = crypto.randomUUID(), calls = [], parts = [];
  const key = `private-storage-${intent}`, principal = `uploader-${intent}`, other = `other-${intent}`;
  await sql("INSERT INTO drive_principals VALUES (?, 'member', 'active'), (?, 'member', 'active')", principal, other).run();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', ?)", intent, principal, key, size).run();
  await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, intent).run();
  const { token } = await sessions.issue(principal);
  const foreign = (await sessions.issue(other)).token;
  const bindings = { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: verifierPresent ? { isQualified: qualified, completionTimeoutMs,
      verifyParts: (upload) => verify ? verify(upload, parts) : parts } : undefined };
  const routes = uploadRoutes(bindings, { timeoutMs: 5000, async fetch(request) {
    calls.push(request.method);
    if (request.method === fail) throw new Error(`provider detail: ${key}`);
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/${config.bucket}/${key}`);
    expect(request.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    if (request.method === 'PUT') {
      expect(url.searchParams.get('uploadId')).toBe(uploadId);
      parts.push({ partNumber: Number(url.searchParams.get('partNumber')), etag: tag, size: (await request.arrayBuffer()).byteLength });
      return new Response(null, { headers: { etag: tag } });
    }
    if (request.method === 'POST') {
      expect(await request.text()).toContain(`<ETag>${tag}</ETag>`);
      return response(key);
    }
    expect(request.method).toBe('HEAD');
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

it('publishes only the conditionally verified generation and never sends a duplicate part or completion', async () => {
  const { send, generation, calls } = await fixture();
  expect((await send()).status).toBe(409, 'an empty seal must roll back and leave the intent usable');
  const attempts = await Promise.all([send(1), send(1)]);
  expect(attempts.map(({ status }) => status).sort()).toEqual([204, 404]);
  expect(await attempts.find(({ status }) => status === 204).text()).toBe('');
  const published = await send();
  expect(published.status).toBe(201);
  expect(published.headers.get('cache-control')).toBe('private, no-store');
  const receipt = await published.json();
  expect(receipt).toEqual({ id: expect.any(String) });
  expect(await generation()).toEqual({ entry_id: receipt.id, size_bytes: 7, etag });
  expect((await send()).status).toBe(404);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
});

it('applies exact origin, session, owner and next-request revocation to both mutations', async () => {
  const { send, calls, foreign, principal } = await fixture();
  for (const number of [1, undefined]) {
    for (const options of [{ source: null }, { source: `${origin}, ${origin}` }, { host: 'https://other.example.test' }]) {
      expect((await send(number, options)).status).toBe(403);
    }
    expect((await send(number, { auth: null })).status).toBe(401);
    expect((await send(number, { auth: foreign })).status).toBe(404);
  }
  await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", principal).run();
  expect((await send(1)).status).toBe(401);
  expect((await send()).status).toBe(401);
  expect(calls).toEqual([]);
});

it.each([
  [{ verifierPresent: false }, 503], [{ completionTimeoutMs: () => null }, 503],
  [{ endpoint: 'https://different.example' }, 404]
])('refuses unqualified or different storage before a provider call (%j)', async (options, status) => {
  const { send, calls } = await fixture(options);
  expect((await send(1)).status).toBe(status);
  expect((await send()).status).toBe(status);
  expect(calls).toEqual([]);
});

it.each(['PUT', 'POST'])('does not leak, publish or resend after uncertain %s', async (fail) => {
  const { send, calls, generation, key } = await fixture({ fail });
  const first = await send(1);
  expect(first.status).toBe(fail === 'PUT' ? 409 : 204);
  expect(await first.text()).not.toContain(key);
  const complete = await send();
  expect(complete.status).toBe(409);
  expect(await complete.text()).toBe('');
  await send(1);
  await send();
  expect(await generation()).toBeNull();
  expect(calls).toEqual(['PUT', 'POST', 'HEAD'].slice(0, ['PUT', 'POST', 'HEAD'].indexOf(fail) + 1));
});

it('resumes an undispatched seal, then reuses the receipt after a failed HEAD', async () => {
  let verifications = 0, heads = 0;
  const { send, foreign, generation, calls } = await fixture({
    verify: (_, parts) => ++verifications === 1 ? null : parts,
    beforeHead: () => { if (++heads === 1) throw new Error('Transient HEAD failure'); }
  });
  expect((await send(1)).status).toBe(204);
  expect((await send()).status).toBe(409);
  expect((await send()).status).toBe(409);
  expect(await generation()).toBeNull();
  expect((await send(undefined, { auth: foreign })).status).toBe(404);
  expect((await send()).status).toBe(201);
  expect((await send()).status).toBe(404);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD', 'HEAD']);
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
  const minimum = 5 * 1024 * 1024;
  const { send, calls } = await fixture({ size: minimum + 7,
    verify: (_, parts) => [...parts].sort((a, b) => a.partNumber - b.partNumber) });
  expect((await send(1)).status).toBe(404); // No earlier slot can fill the rest.
  expect((await send(2)).status).toBe(204); // The short final part may arrive first.
  expect((await send(1, { bytes: minimum - 1 })).status).toBe(404);
  expect((await send(1, { bytes: minimum })).status).toBe(204);
  expect((await send()).status).toBe(201);
  expect(calls).toEqual(['PUT', 'PUT', 'POST', 'HEAD']);
});

it('rechecks the session at the atomic publication write after a matching HEAD', async () => {
  const { send, calls, generation } = await fixture({ beforeHead: (token) => sessions.revoke(token) });
  expect((await send(1)).status).toBe(204);
  expect((await send()).status).toBe(409);
  expect((await send()).status).toBe(401);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
  expect(await generation()).toBeNull();
});
