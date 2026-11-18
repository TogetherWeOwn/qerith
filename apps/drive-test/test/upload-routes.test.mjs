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

async function fixture({ fail, beforeHead, verifierPresent = true, endpoint = config.endpoint } = {}) {
  await applyD1Migrations(env.DB, migrations);
  const intent = crypto.randomUUID(), calls = [], parts = [];
  const key = `private-storage-${intent}`, principal = `uploader-${intent}`, other = `other-${intent}`;
  await sql("INSERT INTO drive_principals VALUES (?, 'member', 'active'), (?, 'member', 'active')", principal, other).run();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', 7)", intent, principal, key).run();
  await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, intent).run();
  const { token } = await sessions.issue(principal);
  const foreign = (await sessions.issue(other)).token;
  const bindings = { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: verifierPresent ? { isQualified: qualified, verifyParts: async () => parts } : undefined };
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
    return new Response(null, { headers: { etag, 'content-length': '7' } });
  } });
  const handle = privateRequests(bindings);
  function send(number, { auth = token, source = origin, host = origin } = {}) {
    const body = number ? 'payload' : JSON.stringify({ parentId: null, name: 'file' });
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
  [{ verifierPresent: false }, 503], [{ endpoint: 'https://different.example' }, 404]
])('refuses unqualified or different storage before a provider call (%j)', async (options, status) => {
  const { send, calls } = await fixture(options);
  expect((await send(1)).status).toBe(status);
  expect((await send()).status).toBe(status);
  expect(calls).toEqual([]);
});

it.each(['PUT', 'POST', 'HEAD'])('does not leak, publish or resend after uncertain %s', async (fail) => {
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

it('rechecks the session at the atomic publication write after a matching HEAD', async () => {
  const { send, calls, generation } = await fixture({ beforeHead: (token) => sessions.revoke(token) });
  expect((await send(1)).status).toBe(204);
  expect((await send()).status).toBe(409);
  expect((await send()).status).toBe(401);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
  expect(await generation()).toBeNull();
});
