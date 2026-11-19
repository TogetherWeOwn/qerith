import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { createUploadCompletionReceipts } from '../../drive/src/lib/server/metadata/upload-completion-receipts.ts';
import { createTrustedUploadPublication } from '../../drive/src/lib/server/metadata/upload-trusted-publication.ts';
import { privateRequests, stagingOrigin } from '../../drive/src/lib/server/request-auth.ts';
import { wireUploadStorage } from '../../drive/src/lib/server/storage-runtime.ts';
import { postUploadIntent } from '../../drive/src/lib/server/upload-intent.ts';
import { uploadRoutes } from '../../drive/src/lib/server/upload-routes.ts';
import { config, epoch, evidence, migrations, response, seed, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, headOk, qualified, setup } from './fixtures/upload-publication-generation.mjs';
const origin = 'https://drive.example.test';
const uploadId = 'provider-upload-id', tag = '"provider-part-tag"', minimum = 5 * 1024 * 1024;

async function fixture({ fail, verify, beforeHead, isQualified = qualified, endpoint = config.endpoint,
  size = 7, completionTimeoutMs = () => 15_000, staging = false } = {}) {
  const requestOrigin = staging ? stagingOrigin : origin;
  await applyD1Migrations(env.DB, migrations);
  const intent = crypto.randomUUID(), key = `private-storage-${intent}`, principal = `uploader-${intent}`;
  const other = `other-${intent}`, calls = [], parts = [];
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, ?, 'active'), (?, 'member', 'active')",
    principal, staging ? 'owner' : 'member', other).run();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', ?)", intent, principal, key, size).run();
  await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, intent).run();
  const { token } = await sessions.issue(principal), foreign = (await sessions.issue(other)).token;
  const bindings = { DB: env.DB, DRIVE_ORIGIN: requestOrigin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: isQualified ? { isQualified: (id) => isQualified(id, intent), completionTimeoutMs,
      verifyParts: (upload) => verify ? verify(upload, parts) : [...parts].sort((a, b) => a.partNumber - b.partNumber) } : undefined };
  const routes = uploadRoutes(bindings, { timeoutMs: 5000, async fetch(request) {
    calls.push(request.method);
    if (request.method === fail) throw new Error(`provider detail: ${key}`);
    const url = new URL(request.url);
    expect(url.pathname).toBe(`/${config.bucket}/${key}`);
    if (request.method === 'PUT') {
      parts.push({ partNumber: Number(url.searchParams.get('partNumber')), etag: tag, size: (await request.arrayBuffer()).byteLength });
      return new Response(null, { headers: { etag: fail === 'receipt' ? `"${'a'.repeat(8191)}"` : tag } });
    }
    if (request.method === 'POST') return response(key);
    expect(request.headers.get('if-match')).toBe(etag);
    await beforeHead?.(token);
    return new Response(null, { headers: { etag, 'content-length': String(size) } });
  } });
  const handle = privateRequests(bindings);
  function send(number, { auth = token, source = requestOrigin, host = requestOrigin, name = 'file', parentId = null,
    intentId = intent, bytes = 7 } = {}) {
    const body = number ? new Uint8Array(bytes) : JSON.stringify({ parentId, name });
    const headers = { 'content-type': number ? 'application/octet-stream' : 'application/json', 'content-length': String(body.length) };
    if (auth) headers.cookie = `__Host-drive-session=${auth}`;
    if (source) headers.origin = source;
    const request = new Request(`${host}/api/uploads/${intentId}/${number ? `parts/${number}` : 'complete'}`,
      { method: number ? 'PUT' : 'POST', body, headers });
    return handle({ event: { request, locals: {} }, resolve: ({ locals }) => number
      ? routes.part(request, locals.driveSession, intentId, String(number))
      : routes.complete(request, locals.driveSession, intentId) });
  }
  const generation = () => sql('SELECT entry_id, size_bytes, etag FROM drive_published_generations WHERE intent_id = ?', intent).first();
  return { send, generation, calls, foreign, key, principal, other };
}

async function occupy(owner, name, parentId = null) {
  const id = crypto.randomUUID();
  await sql("INSERT INTO drive_entries (id, owner_id, name, parent_id, kind) VALUES (?, ?, ?, ?, 'folder')",
    id, owner, name, parentId).run();
  return id;
}

async function expectNameTaken(result) {
  expect(result.status).toBe(409);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.get('content-type')).toBe('application/json');
  expect(await result.text()).toBe('{"code":"name-taken"}');
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

it.each(['owner', 'claim', 'send'])('checks the staging owner during allocation (%s)', async (change) => {
  await applyD1Migrations(env.DB, migrations);
  const principal = crypto.randomUUID(), states = [], calls = [];
  const row = () => sql('SELECT * FROM drive_upload_intents WHERE owner_id = ?', principal).first();
  const demote = () => sql("UPDATE drive_principals SET role = 'member' WHERE id = ?", principal).run();
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'owner', 'active')", principal).run();
  try {
    const { token } = await sessions.issue(principal);
    const request = new Request(`${stagingOrigin}/api/uploads`, { method: 'POST', body: '{"size":7}',
      headers: { origin: stagingOrigin, cookie: `__Host-drive-session=${token}`, 'content-type': 'application/json' } });
    const result = await postUploadIntent(request, { DB: env.DB, DRIVE_ORIGIN: stagingOrigin,
      DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
      DRIVE_UPLOAD_VERIFIER: { completionTimeoutMs: () => 5000, async isQualified(id) {
        const state = (await row())?.state ?? null;
        states.push(state);
        if (change === (state === null ? 'claim' : 'send')) await demote();
        return qualified(id);
      } } }, { timeoutMs: 5000, async fetch(request) {
      calls.push(request.method);
      return new Response(`<InitiateMultipartUploadResult><Key>${(await row()).object_key}</Key>` +
        `<UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    } });
    const allowed = change === 'owner', claimed = change !== 'claim';
    expect(await sessions.lookup(token)).toEqual({ id: principal, role: allowed ? 'owner' : 'member' });
    expect(states).toEqual(claimed ? [null, 'initiating'] : [null]);
    expect(calls).toEqual(allowed ? ['POST'] : []);
    const intent = await row();
    expect(intent).toEqual(claimed ? expect.objectContaining({
      state: allowed ? 'allocated' : 'created', version: 2, upload_id: allowed ? uploadId : null
    }) : null);
    expect(result.status).toBe(allowed ? 201 : claimed ? 503 : 401);
    if (allowed) expect(await result.json()).toEqual({ id: intent.id });
    else expect(await result.text()).toBe('');
  } finally { await demote(); }
});

it.each(['part claim', 'parts verification', 'completion claim', 'publication send', 'generation HEAD'])('keeps staging upload owner-only after %s', async (change) => {
  let principal;
  const demote = () => sql("UPDATE drive_principals SET role = 'member' WHERE id = ?", principal).run();
  const claim = {
    'part claim': 'drive_upload_part_operations',
    'completion claim': 'drive_upload_completion_operations JOIN drive_upload_completion_dispatches USING (operation_id)',
    'publication send': 'drive_upload_completion_operations JOIN drive_upload_completion_receipts USING (operation_id)'
  }[change];
  const upload = await fixture({ staging: true, async isQualified(id, intent) {
    if (claim && await sql(`SELECT 1 FROM ${claim} WHERE intent_id = ?`, intent).first()) await demote();
    return qualified(id);
  }, async verify(_upload, parts) {
    if (change === 'parts verification') await demote();
    return parts;
  }, async beforeHead() {
    if (change === 'generation HEAD') await demote();
  } });
  ({ principal } = upload);
  try {
    expect((await upload.send(1, { auth: upload.foreign })).status).toBe(404);
    const partDenied = change === 'part claim';
    expect((await upload.send(1)).status).toBe(partDenied ? 409 : 204);
    expect((await upload.send()).status).toBe(404);
    expect(await upload.generation()).toBeNull();
    const expected = { 'part claim': [], 'parts verification': ['PUT'], 'completion claim': ['PUT'],
      'publication send': ['PUT', 'POST'], 'generation HEAD': ['PUT', 'POST', 'HEAD'] };
    expect(upload.calls).toEqual(expected[change]);
    if (partDenied) expect(await sql(`SELECT r.kind FROM drive_upload_part_operations p JOIN drive_upload_part_observations r
      USING (operation_id) WHERE p.owner_id = ?`, principal).first()).toEqual({ kind: 'uncertain' });
    if (change === 'parts verification') expect(await sql(`SELECT 1 FROM drive_upload_completion_operations o
      JOIN drive_upload_completion_dispatches d USING (operation_id) WHERE o.owner_id = ?`, principal).first()).toBeNull();
    if (change === 'completion claim') expect(await sql(`SELECT 1 FROM drive_upload_completion_operations o
      JOIN drive_upload_completion_quarantine q USING (operation_id) WHERE o.owner_id = ?`, principal).first()).not.toBeNull();
  } finally { await demote(); }
});

it.each(['owner', 'member'])('checks the staging role %s again before the next multipart page', async (role) => {
  await applyD1Migrations(env.DB, migrations);
  const operation = crypto.randomUUID(), owner = `owner-${operation}`;
  const { token, key } = await seed(operation);
  const setRole = (value) => sql('UPDATE drive_principals SET role = ? WHERE id = ?', value, owner).run();
  const storageConfigId = JSON.stringify([config.endpoint, config.bucket, epoch]);
  const calls = [];
  const open = `<ListPartsResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>upload/+id</UploadId>`;
  const fetch = async (request) => {
    const marker = new URL(request.url).searchParams.get('part-number-marker');
    calls.push([request.method, marker]);
    if (request.method === 'POST') return response(key);
    if (marker === '2') return new Response(`${open}<IsTruncated>false</IsTruncated></ListPartsResult>`);
    if (role === 'member') await setRole(role);
    return new Response(`${open}<IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>` +
      '<Part><PartNumber>2</PartNumber><Size>7</Size><ETag>"part-&amp;-ÿ"</ETag></Part></ListPartsResult>');
  };
  const { DRIVE_UPLOAD_VERIFIER: verifier } = wireUploadStorage({
    DRIVE_S3_ENDPOINT: config.endpoint, DRIVE_S3_BUCKET: config.bucket, DRIVE_S3_REGION: config.region,
    DRIVE_S3_STORAGE_EPOCH: epoch, DRIVE_S3_ACCESS_KEY_ID: config.accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, storageConfigId, region: config.region,
      sourceSha: 'a'.repeat(40), runId: '123', runAttempt: 1, completionTimeoutMs: 5000 })
  }, fetch);
  await setRole('owner');
  try {
    let idleMs = 5000;
    const streamBudget = role === 'owner' ? Object.create({ get idleMs() { return idleMs; }, totalMs: 5000 }) : undefined;
    const service = createUploadCompletionReceipts(env.DB, epoch, config, { fetch, timeoutMs: 5000, streamBudget }, verifier, true);
    idleMs = 0;
    const allowed = role === 'owner';
    expect(await service.complete(token, operation)).toBe(allowed ? 'recorded' : 'not-admitted');
    expect(await sql('SELECT role FROM drive_principals WHERE id = ?', owner).first()).toEqual({ role });
    expect(calls).toEqual(allowed ? [['GET', null], ['GET', '2'], ['POST', null]] : [['GET', null]]);
    expect(Boolean(await evidence('receipts', operation))).toBe(allowed);
    if (!allowed) expect(await evidence('dispatches', operation)).toBeNull();
  } finally { await setRole('member'); }
});

it('validates owner-only upload transports at construction without I/O', () => {
  const fetch = vi.fn(), verifier = { isQualified: vi.fn(), verifyParts: vi.fn() };
  const streamBudget = Object.create({ idleMs: 0, totalMs: 5000 });
  for (const options of [{ fetch, timeoutMs: 0 }, { fetch, timeoutMs: 5000, streamBudget }]) {
    expect(() => createUploadCompletionReceipts(env.DB, epoch, config, options, verifier, true)).toThrow('Invalid S3 timeout');
    expect(() => createTrustedUploadPublication(env.DB, epoch, config, options, qualified, true)).toThrow('Invalid S3 timeout');
  }
  for (const mock of [fetch, verifier.isQualified, verifier.verifyParts]) expect(mock).not.toHaveBeenCalled();
});

it('rechecks publication qualification after the caller hook, before HEAD', async () => {
  const { complete, publish } = await setup(crypto.randomUUID());
  expect(await complete()).toBe('recorded');
  let current = true;
  const fetch = vi.fn(headOk), streamBudget = Object.create({ idleMs: 5000, totalMs: 5000 });
  const service = createTrustedUploadPublication(env.DB, epoch, config, { fetch, timeoutMs: 5000, streamBudget,
    async beforeSend() { current = await Promise.resolve(false); return true; } }, (id) => current && qualified(id));
  expect(await publish(service)).toBeNull();
  expect(current).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
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

it.each(['PUT', 'POST', 'qualification', 'receipt'])('preserves send fences and empty errors (%s)', async (fail) => {
  const partFailed = fail !== 'POST';
  let checkPart = fail === 'qualification';
  const part = { bytes: partFailed ? minimum : 7 };
  const { send, calls, generation, key } = await fixture({ fail, size: part.bytes + (partFailed ? 7 : 0),
    isQualified: async (id, intent) => await qualified(id) && (!checkPart ||
      !await sql('SELECT 1 FROM drive_upload_part_operations WHERE intent_id = ?', intent).first()) });
  const first = await send(1, part);
  expect([first.status, await first.text()]).toEqual([partFailed ? 409 : 204, '']);
  checkPart = false;
  if (partFailed) {
    expect(await sql(`SELECT r.kind FROM drive_upload_part_operations p JOIN drive_upload_part_observations r
      USING (operation_id) WHERE p.object_key = ? AND p.part_number = 1`, key).first()).toEqual({ kind: 'uncertain' });
    expect([(await send(1, part)).status, (await send(2)).status]).toEqual([404, 404]);
  }
  expect([(await send()).status, (await send()).status, await generation()]).toEqual([409, partFailed ? 409 : 404, null]);
  expect(calls).toEqual(fail === 'POST' ? ['PUT', 'POST'] : fail === 'qualification' ? [] : ['PUT']);
});

it.each(['provider error', 'qualification', 'session'])('requires current authority when publishing (%s)', async (veto) => {
  let current = true, verifications = 0, heads = 0;
  const { send, foreign, generation, calls, key, principal } = await fixture({
    isQualified: (id) => current && qualified(id),
    verify: (_, parts) => { if (++verifications === 1) current = false; return parts; },
    beforeHead: async (token) => {
      if (++heads !== 1) return;
      if (veto === 'session') {
        await occupy(principal, 'file');
        return sessions.revoke(token);
      }
      if (veto === 'provider error') throw new Error('Transient HEAD failure');
      current = false;
    }
  });
  expect([(await send(1)).status, (await send()).status]).toEqual([204, 409]);
  expect(calls).toEqual(['PUT']);
  current = true;
  const rejected = await send();
  expect([rejected.status, await rejected.text()]).toEqual([veto === 'session' ? 404 : 409, '']);
  expect(await generation()).toBeNull();
  expect(await sql('SELECT id FROM drive_entries WHERE object_key = ?', key).first()).toBeNull();
  current = true;
  expect((await send(undefined, { auth: foreign })).status).toBe(404);
  expect((await send()).status).toBe(veto === 'session' ? 401 : 201);
  expect(calls).toEqual(veto === 'session' ? ['PUT', 'POST', 'HEAD'] : ['PUT', 'POST', 'HEAD', 'HEAD']);
});

it('reports a sibling conflict only for the live owner and an accessible destination', async () => {
  const { send, calls, principal, other, foreign, key, generation } = await fixture();
  const ownParent = await occupy(principal, 'parent'), foreignParent = await occupy(other, 'parent');
  await occupy(principal, 'file', ownParent);
  await occupy(other, 'file', foreignParent);
  await expectNameTaken(await send(undefined, { parentId: ownParent }));
  for (const options of [{ parentId: foreignParent }, { parentId: crypto.randomUUID() },
    { parentId: foreignParent, auth: foreign }, { parentId: ownParent, intentId: crypto.randomUUID() }]) {
    const result = await send(undefined, options);
    expect([result.status, await result.text()]).toEqual([404, '']);
  }
  await sql('UPDATE drive_sessions SET expires_at = 0 WHERE principal_id = ?', principal).run();
  const expired = await send(undefined, { parentId: ownParent });
  expect([expired.status, await expired.text()]).toEqual([401, '']);
  const renewed = (await sessions.issue(principal)).token;
  await sessions.revoke(renewed);
  const revoked = await send(undefined, { parentId: ownParent, auth: renewed });
  expect([revoked.status, await revoked.text()]).toEqual([401, '']);
  expect(await sql('SELECT 1 FROM drive_upload_completion_operations WHERE object_key = ?', key).first()).toBeNull();
  expect(await generation()).toBeNull();
  expect(calls).toEqual([]);
});

it('reports a sibling appearing after sealing without dispatching completion', async () => {
  let verifies = 0;
  const { send, calls, key } = await fixture({ verify: async ({ ownerId }, parts) => {
    if (++verifies === 1) await occupy(ownerId, 'file');
    return parts;
  } });
  expect((await send(1)).status).toBe(204);
  await expectNameTaken(await send());
  expect(await sql(`SELECT 1 FROM drive_upload_completion_dispatches JOIN drive_upload_completion_operations
    USING (operation_id) WHERE object_key = ?`, key).first()).toBeNull();
  expect(calls).toEqual(['PUT']);
  expect((await send(undefined, { name: 'free' })).status).toBe(201);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
});

it('reports a sibling appearing at publication and reuses the verified receipt once the name is free', async () => {
  let sibling;
  const { send, calls, principal, generation } = await fixture({ beforeHead: async () => {
    sibling ??= await occupy(principal, 'file');
  } });
  expect((await send(1)).status).toBe(204);
  await expectNameTaken(await send());
  await expectNameTaken(await send());
  expect(await generation()).toBeNull();
  expect(await sql('SELECT id, kind FROM drive_entries WHERE id = ?', sibling).first()).toEqual({ id: sibling, kind: 'folder' });
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
  await sql("UPDATE drive_entries SET name = 'moved' WHERE id = ?", sibling).run();
  const published = await send(), receipt = await published.json();
  expect([published.status, receipt]).toEqual([201, { id: expect.any(String) }]);
  const replay = await send();
  expect([replay.status, await replay.json()]).toEqual([200, receipt]);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD', 'HEAD']);
});

it('replays the recorded receipt after the published file moves and the old folder is removed', async () => {
  const { send, calls, principal } = await fixture();
  const parentId = await occupy(principal, 'old-parent');
  expect((await send(1)).status).toBe(204);
  const published = await send(undefined, { parentId }), receipt = await published.json();
  expect(published.status).toBe(201);
  await sql('UPDATE drive_entries SET parent_id = NULL WHERE id = ?', receipt.id).run();
  await sql('DELETE FROM drive_entries WHERE id = ?', parentId).run();
  const replay = await send(undefined, { parentId });
  expect([replay.status, await replay.json()]).toEqual([200, receipt]);
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
});

it('does not relabel an unresolved part claim as a name conflict', async () => {
  const { send, calls, key, principal } = await fixture();
  await sql(`INSERT INTO drive_upload_part_operations
    SELECT ?, id, owner_id, object_key, ?, upload_id, version, 1, 7 FROM drive_upload_intents WHERE object_key = ?`,
    crypto.randomUUID(), epoch, key).run();
  await occupy(principal, 'file');
  const result = await send();
  expect([result.status, await result.text()]).toEqual([404, '']);
  expect(calls).toEqual([]);
});

it('keeps a failed HEAD opaque even if a sibling appears during verification', async () => {
  const { send, calls, principal, generation } = await fixture({ beforeHead: async () => {
    await occupy(principal, 'file');
    throw new Error('provider detail');
  } });
  expect((await send(1)).status).toBe(204);
  const result = await send();
  expect([result.status, await result.text()]).toEqual([409, '']);
  expect(await generation()).toBeNull();
  expect(calls).toEqual(['PUT', 'POST', 'HEAD']);
});

it('does not relabel an uncertain completion as a name conflict or send it again', async () => {
  const { send, calls, principal, generation } = await fixture({ fail: 'POST' });
  expect((await send(1)).status).toBe(204);
  const failed = await send();
  expect([failed.status, await failed.text()]).toEqual([409, '']);
  await occupy(principal, 'file');
  const retry = await send();
  expect([retry.status, await retry.text()]).toEqual([404, '']);
  expect(await generation()).toBeNull();
  expect(calls).toEqual(['PUT', 'POST']);
});

it('rejects impossible small-part layouts without consuming slots', async () => {
  const { send, calls } = await fixture({ size: minimum + 7 });
  for (const [number, bytes, status] of [[10_000, minimum, 404], [1, 7, 404], [3, 6, 204], [4, minimum + 1, 404],
    [1, minimum - 1, 404], [1, minimum, 404], [1, minimum + 2, 404], [1, minimum + 1, 204], [undefined, 0, 201]])
    expect((await send(number, { bytes })).status).toBe(status);
  expect(calls).toEqual(['PUT', 'PUT', 'POST', 'HEAD']);
});
