import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, onTestFinished, vi } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { privateRequests, stagingOrigin } from '../../drive/src/lib/server/request-auth.ts';
import { admitStagingRequest } from '../../drive/src/lib/server/staging-admission.ts';
import { wireUploadStorage } from '../../drive/src/lib/server/storage-runtime.ts';
import { createUploadIntent, maxUploadIntentBytes, postUploadIntent } from '../../drive/src/lib/server/upload-intent.ts';

const origin = 'https://drive.example';
const config = { endpoint: 'https://storage.example', bucket: 'drive-test', region: 'us-east-1', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' };
async function fixture(requestOrigin = origin, role = 'member') {
  const db = env.DB, owner = crypto.randomUUID();
  await applyD1Migrations(db, env.DRIVE_MIGRATIONS);
  await db.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, ?, 'active')").bind(owner, role).run();
  const sessions = new Sessions(db), { token } = await sessions.issue(owner);
  const bindings = { DB: db, DRIVE_ORIGIN: requestOrigin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: 'fixture',
    DRIVE_UPLOAD_VERIFIER: { isQualified: vi.fn(async () => true), completionTimeoutMs: () => 5000 } };
  const request = (source = requestOrigin, cookie = `__Host-drive-session=${token}`, target = requestOrigin) =>
    new Request(`${target}/api/uploads`, { method: 'POST', headers: { ...(source ? { origin: source } : {}), cookie } });
  const fetch = vi.fn(), transport = { fetch, timeoutMs: 5000 };
  const create = (req = request(), size = 4, overrides = {}) =>
    createUploadIntent(req, size, { ...bindings, ...overrides }, transport);
  const post = (body, { req = request(), headers = {}, overrides = {}, signal } = {}) =>
    postUploadIntent(new Request(req, {
      body, headers: { ...Object.fromEntries(req.headers), 'content-type': 'application/json', ...headers }, signal,
    }), { ...bindings, ...overrides }, transport);
  const row = () => db.prepare('SELECT * FROM drive_upload_intents WHERE owner_id = ?').bind(owner).first();
  return { db, bindings, request, fetch, create, post, row, owner, revoke: () => sessions.revoke(token) };
}

const multipart = { DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
const partBytes = 16 * 1024 ** 2, ceiling = 320 * partBytes;
const first = 'ab'.repeat(32), last = 'cd'.repeat(32);
const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const boundBody = (size, expectedPartSha256s) => JSON.stringify({ size, expectedPartSha256s });

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const scope = 'drive-qualification/full-v0/18/2/';
const scopedKey = new RegExp(`^${scope}${uuid}$`);
const storageConfigId = JSON.stringify([config.endpoint, config.bucket, 'fixture']);
const storageProof = JSON.stringify({ version: 1, storageConfigId, region: config.region, sourceSha: 'b'.repeat(40),
  runId: '42', runAttempt: 1, completionTimeoutMs: 5000 });

function candidateEnv(db, overrides = {}) {
  return wireUploadStorage({ DB: db, DRIVE_ORIGIN: stagingOrigin,
    DRIVE_STAGING_INVITE_ACCEPTANCE: '0',
    DRIVE_QUALIFICATION_SHA: 'a'.repeat(40), DRIVE_QUALIFICATION_RUN_ID: '18', DRIVE_QUALIFICATION_RUN_ATTEMPT: '2',
    DRIVE_QUALIFICATION_VERSION: { id: '00000000-0000-4000-8000-000000000001' },
    DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() + 60_000),
    DRIVE_S3_ENDPOINT: config.endpoint, DRIVE_S3_BUCKET: config.bucket, DRIVE_S3_REGION: config.region,
    DRIVE_S3_ACCESS_KEY_ID: config.accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    DRIVE_S3_STORAGE_EPOCH: 'fixture', DRIVE_S3_QUALIFICATION: storageProof, ...overrides });
}

async function allocationFixture(target = stagingOrigin, role = 'owner') {
  const result = await fixture(target, role);
  const { db, owner } = result;
  if (role === 'owner') {
    onTestFinished(async () => {
      await db.prepare("UPDATE drive_principals SET role = 'member' WHERE id = ?").bind(owner).run();
    });
  }
  return result;
}

it.each([
  ['ordinary app', origin, 'member', '{"size":4}', false],
  ['ordinary staging', stagingOrigin, 'owner', '{"size":4}', false],
  ['qualification preview', stagingOrigin, 'owner', '{"size":4}', true],
  ['qualification digest-bound with synthetic invite opt-in', stagingOrigin, 'member', boundBody(0, empty), true],
])('reserves the exact server-selected key before multipart dispatch for %s', async (_mode, target, role, body, candidate) => {
  const { db, owner, post, row, fetch } = await allocationFixture(target, role);
  const overrides = candidate ? candidateEnv(db, role === 'member' ? multipart : {}) : {};
  let claimed, storage, reservation;
  fetch.mockImplementation(async () => {
    claimed = await row();
    storage = await db.prepare('SELECT * FROM drive_upload_storage_bindings WHERE intent_id = ?').bind(claimed.id).first();
    reservation = await db.prepare('SELECT object_key FROM drive_upload_key_reservations WHERE object_key = ?')
      .bind(claimed.object_key).first();
    return new Response(`<InitiateMultipartUploadResult><Key>${claimed.object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
  });
  const forged = { 'x-drive-qualification-run-id': '99', 'x-drive-qualification-run-attempt': '1',
    'x-drive-qualification-prefix': 'drive-qualification/full-v0/99/1/' };
  expect((await post('{"size":4,"prefix":"outside/"}', { overrides })).status).toBe(400);
  const response = await post(body, { overrides, headers: forged });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: claimed.id });
  expect(claimed).toMatchObject({ owner_id: owner, state: 'initiating', version: 1, upload_id: null });
  expect(claimed.object_key).toMatch(candidate ? scopedKey : new RegExp(`^${uuid}$`));
  expect(claimed.id).toMatch(new RegExp(`^${uuid}$`));
  expect(storage).toEqual({ intent_id: claimed.id, endpoint: config.endpoint, bucket: config.bucket, storage_epoch: 'fixture' });
  expect(reservation).toEqual({ object_key: claimed.object_key });
  expect(await row()).toMatchObject({ object_key: claimed.object_key, state: 'allocated', upload_id: 'provider-only' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0].url).toBe(`${config.endpoint}/${config.bucket}/${claimed.object_key}?uploads=`);
});

it('keeps digest-bound upload admission closed under uploaded candidate settings', async () => {
  const { db, post, row, fetch } = await allocationFixture();
  expect((await post(boundBody(0, empty), { overrides: candidateEnv(db) })).status).toBe(400);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('fails closed for partial, stale, non-staging and unqualified candidate uploads', async () => {
  const { db, post, request, row, fetch } = await allocationFixture();
  for (const broken of [
    { DRIVE_QUALIFICATION_RUN_ID: undefined, DRIVE_QUALIFICATION_RUN_ATTEMPT: undefined },
    { DRIVE_QUALIFICATION_RUN_ID: '18/', DRIVE_QUALIFICATION_RUN_ATTEMPT: '2' },
    { DRIVE_QUALIFICATION_RUN_ID: '1'.repeat(21) }, { DRIVE_QUALIFICATION_RUN_ID: '18\n' },
    { DRIVE_QUALIFICATION_RUN_ATTEMPT: '02' }, { DRIVE_QUALIFICATION_RUN_ATTEMPT: undefined },
    { DRIVE_QUALIFICATION_SHA: undefined }, { DRIVE_QUALIFICATION_SHA: 'HEAD' },
    { DRIVE_QUALIFICATION_VERSION: { id: 'latest' } }, { DRIVE_QUALIFICATION_VERSION: undefined },
    { DRIVE_QUALIFICATION_EXPIRES_AT: undefined }, { DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() - 1) },
    { DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() + 26 * 60_000) },
    { DRIVE_SIGN_IN_FIXTURE: '1' }, { DRIVE_S3_BUCKET: 'wrong-bucket' }, { DRIVE_S3_REGION: 'wrong-region' },
    { DRIVE_S3_STORAGE_EPOCH: 'wrong-epoch' }, { DRIVE_S3_QUALIFICATION: undefined },
  ]) {
    const overrides = candidateEnv(db, broken);
    expect((await post('{"size":4}', { overrides })).status, JSON.stringify(broken)).toBe(503);
  }
  const overrides = candidateEnv(db);
  expect((await post('{"size":4}', { overrides, req: request(origin) })).status).toBe(403);
  expect((await post('{"size":4}', { overrides, req: new Request(stagingOrigin + '/api/uploads?attempt=3',
    { method: 'POST', headers: request().headers }) })).status).toBe(404);
  expect((await post('{"size":4}', { overrides: candidateEnv(db, { DRIVE_ORIGIN: origin }),
    req: request(origin, undefined, origin) })).status).toBe(503);
  expect((await post('{"size":4}', { overrides: { DRIVE_QUALIFICATION_RUN_ATTEMPT: '2' } })).status).toBe(503);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['abort', 'expiry'])('keeps the claimed key and sends nothing on candidate %s after the claim', async reason => {
  const { db, post, row, fetch } = await allocationFixture();
  const controller = new AbortController();
  const overrides = candidateEnv(db);
  const { DRIVE_UPLOAD_VERIFIER: verifier } = overrides;
  const clock = vi.spyOn(Date, 'now');
  let claimed;
  overrides.DRIVE_UPLOAD_VERIFIER = { ...verifier, async isQualified(id, signal) {
    if ((claimed = await row())) {
      if (reason === 'abort') controller.abort();
      else clock.mockReturnValue(Number(overrides.DRIVE_QUALIFICATION_EXPIRES_AT));
    }
    return verifier.isQualified(id, signal);
  } };
  try {
    expect((await post('{"size":4}', { overrides, signal: controller.signal })).status).toBe(503);
  } finally { clock.mockRestore(); }
  expect(claimed).toMatchObject({ state: 'initiating', upload_id: null });
  expect(claimed.object_key).toMatch(scopedKey);
  expect(await row()).toMatchObject({ object_key: claimed.object_key, state: 'created', upload_id: null });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps a lost allocation enumerable and never repurposes an older intent on retry', async () => {
  const { db, owner, post, fetch } = await allocationFixture();
  const rows = async () => (await db.prepare('SELECT * FROM drive_upload_intents WHERE owner_id = ?').bind(owner).all()).results;
  const dispatched = [];
  let lost;
  fetch.mockImplementation(async request => {
    const claim = (await rows()).find(intent => intent.state === 'initiating');
    dispatched.push({ url: request.url, claim });
    if (lost) throw new Error('fixture lost the provider response');
    return new Response(`<InitiateMultipartUploadResult><Key>${claim.object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
  });
  expect((await post('{"size":4}')).status).toBe(201);
  const [original] = await rows();
  lost = true;
  const overrides = candidateEnv(db);
  expect((await post('{"size":4}', { overrides })).status).toBe(409);
  const uncertain = (await rows()).find(intent => intent.id !== original.id);
  expect(uncertain).toMatchObject({ state: 'uncertain', version: 2, upload_id: null });
  lost = false;
  const retry = await post('{"size":4}', { overrides });
  expect(retry.status).toBe(201);
  const { id } = await retry.json();
  const final = await rows();
  expect(final).toHaveLength(3);
  expect(final).toEqual(expect.arrayContaining([original, uncertain]));
  const fresh = final.find(intent => intent.id === id);
  expect(fresh.object_key).not.toBe(uncertain.object_key);
  for (const [position, intent] of [uncertain, fresh].entries()) {
    expect(intent.object_key).toMatch(scopedKey);
    expect(dispatched[position + 1]).toMatchObject({
      url: `${config.endpoint}/${config.bucket}/${intent.object_key}?uploads=`,
      claim: { id: intent.id, object_key: intent.object_key, state: 'initiating' },
    });
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([[0, empty], [partBytes + 1, first + last], [ceiling, first.repeat(319) + last]])(
  'atomically binds the ordered digest vector for %i bytes before dispatch', async (size, packed) => {
    const { db, owner, post, row, fetch } = await fixture(stagingOrigin);
    const body = boundBody(size, packed);
    let claimed, storage;
    fetch.mockImplementation(async () => {
      claimed = await row();
      storage = await db.prepare('SELECT * FROM drive_upload_storage_bindings WHERE intent_id = ?').bind(claimed.id).first();
      return new Response(`<InitiateMultipartUploadResult><Key>${claimed.object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
    });
    const response = await post(body, { headers: { 'content-length': String(body.length) },
      overrides: { ...multipart, DRIVE_UPLOAD_S3: { ...config, endpoint: `${config.endpoint}/` } } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(claimed).toMatchObject({ owner_id: owner, declared_size: size, expected_part_sha256s: packed,
      state: 'initiating', version: 1, upload_id: null });
    expect(storage).toEqual({ intent_id: claimed.id, endpoint: config.endpoint, bucket: config.bucket, storage_epoch: 'fixture' });
    expect(await row()).toMatchObject({ state: 'allocated', expected_part_sha256s: packed, upload_id: 'provider-only' });
    expect([response.status, response.headers.get('cache-control'), await response.json()])
      .toEqual([201, 'private, no-store', { id: claimed.id }]);
  });

it('rejects noncanonical bound requests without claiming or checking storage', async () => {
  const { post, row, fetch, bindings } = await fixture(stagingOrigin);
  const valid = boundBody(0, empty);
  for (const body of [
    boundBody(0, ''), boundBody(0, first.slice(1)), boundBody(0, `${first}a`), boundBody(0, first.toUpperCase()),
    boundBody(0, `${first.slice(1)}g`), boundBody(0, first + last), boundBody(partBytes + 1, first),
    boundBody(ceiling + 1, first.repeat(320)), boundBody(ceiling, first.repeat(321)), boundBody(1, [first]),
    `{"expectedPartSha256s":"${first}","size":1}`, `{"size":1,"size":1,"expectedPartSha256s":"${first}"}`,
    `{"size":1,"expectedPartSha256s":"${first}","expectedPartSha256s":"${first}"}`,
    `{"size":1,"expectedPartSha256s":"${first}","extra":0}`, `{"size":1e0,"expectedPartSha256s":"${first}"}`,
    `${valid}\n`, valid.slice(0, -1), '{"size":4}'.padEnd(65),
  ]) expect((await post(body, { overrides: multipart })).status).toBe(400);
  for (const length of [valid.length - 1, valid.length + 1, boundBody(ceiling, first.repeat(320)).length + 1]) {
    expect((await post(valid, { headers: { 'content-length': String(length) }, overrides: multipart })).status).toBe(400);
  }
  expect(await row()).toBeNull();
  expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([[origin, 'member'], [stagingOrigin, 'member'], [stagingOrigin, 'owner']])(
  'refuses bound requests outside multipart mode (%s, %s)', async (target, role) => {
    const { post, row, fetch, bindings, db, owner } = await fixture(target, role);
    try {
      const flag = target === stagingOrigin && role === 'member' ? '0' : '1';
      expect((await post(boundBody(0, empty), { overrides: { DRIVE_STAGING_INVITE_ACCEPTANCE: flag } })).status).toBe(400);
      expect(await row()).toBeNull();
      expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      if (role === 'owner') await db.prepare("UPDATE drive_principals SET role = 'member' WHERE id = ?").bind(owner).run();
    }
  });

it('allocates from a browser JSON body and returns only the intent ID', async () => {
  const { post, row, fetch } = await fixture();
  fetch.mockImplementation(async () => new Response(
    `<InitiateMultipartUploadResult><Key>${(await row()).object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`));
  const response = await post(JSON.stringify({ size: maxUploadIntentBytes }));
  const intent = await row();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(intent).toMatchObject({ declared_size: maxUploadIntentBytes, state: 'allocated' });
  expect(response.status).toBe(201);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ id: intent.id });
});

it.each([
  ['default staging', stagingOrigin, undefined, 'owner', 16 * 1024 ** 2],
  ['off in staging', stagingOrigin, '0', 'owner', 16 * 1024 ** 2],
  ['invalid staging flag', stagingOrigin, 'true', 'owner', 16 * 1024 ** 2],
  ['flag outside staging', origin, '1', 'member', 16 * 1024 ** 2],
  ['opt-in staging', stagingOrigin, '1', 'member', 5 * 1024 ** 3],
])('enforces the declaration ceiling for %s before claiming or dispatching', async (_mode, target, flag, role, limit) => {
  const { post, row, fetch, bindings, db, owner } = await fixture(target, role);
  const overrides = { DRIVE_STAGING_INVITE_ACCEPTANCE: flag };
  try {
    for (const size of [limit + 1, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await post(JSON.stringify({ size }), { overrides })).status).toBe(400);
    }
    expect(await row()).toBeNull();
    expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockImplementation(async () => new Response(
      `<InitiateMultipartUploadResult><Key>${(await row()).object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`));
    const accepted = await post(JSON.stringify({ size: limit }), { overrides }), intent = await row();
    expect([accepted.status, await accepted.json()]).toEqual([201, { id: intent.id }]);
    expect(intent).toMatchObject({ declared_size: limit, state: 'allocated', expected_part_sha256s: null });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    if (role === 'owner') await db.prepare("UPDATE drive_principals SET role = 'member' WHERE id = ?").bind(owner).run();
  }
});

it('allocates only for the live staging member behind the exact flag and admits canonical upload routes', async () => {
  const { bindings, db, owner, post, request, row, revoke, fetch } = await fixture(stagingOrigin);
  const body = '{"size":4}', enabled = { DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
  for (const flag of [undefined, '0', 'true']) {
    expect((await post(body, { overrides: { DRIVE_STAGING_INVITE_ACCEPTANCE: flag } })).status).toBe(401);
  }
  expect((await post(body, { req: request(origin), overrides: enabled })).status).toBe(403);
  const other = crypto.randomUUID();
  await db.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')").bind(other).run();
  expect((await post(JSON.stringify({ size: 4, ownerId: other }), { overrides: enabled })).status).toBe(400);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  fetch.mockImplementation(async () => new Response(
    `<InitiateMultipartUploadResult><Key>${(await row()).object_key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`));
  const result = await post(body, { overrides: enabled }), intent = await row();
  expect(result.status).toBe(201);
  expect(await result.json()).toEqual({ id: intent.id });
  expect(intent).toMatchObject({ owner_id: owner, declared_size: 4, state: 'allocated', upload_id: 'provider-only' });
  expect(fetch).toHaveBeenCalledOnce();
  const [[signed]] = fetch.mock.calls;
  expect(signed.method).toBe('POST');
  expect(signed.url).toBe(`${config.endpoint}/${config.bucket}/${intent.object_key}?uploads=`);
  expect(signed.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);

  const runtime = { ...bindings, ...enabled }, handle = privateRequests(runtime);
  const resolve = vi.fn(() => new Response(null, { status: 204 }));
  const empty = new Set(), assets = { signIn: empty, root: empty, invite: empty, people: empty };
  for (const [path, routeId, method] of [
    ['', '', 'POST'], [`/${intent.id}/parts/1`, '/[intentId]/parts/[partNumber]', 'PUT'],
    [`/${intent.id}/complete`, '/[intentId]/complete', 'POST'],
  ]) {
    const req = new Request(`${stagingOrigin}/api/uploads${path}`, { method, headers: request().headers });
    expect(await admitStagingRequest(req, runtime, true, assets)).toEqual({ kind: 'upload' });
    const locals = {};
    const admitted = await handle({ event: { request: req, route: { id: `/api/uploads${routeId}` }, locals }, resolve });
    expect(admitted.status).toBe(204);
    expect(locals.driveSession?.principal).toEqual({ id: owner, role: 'member' });
  }
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(await db.prepare('SELECT 1 FROM drive_published_generations WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
  await revoke();
  expect((await post(body, { overrides: enabled })).status).toBe(401);
  expect(fetch).toHaveBeenCalledOnce();
});

it('rejects malformed, oversized and truncated JSON before claiming or dispatching', async () => {
  const { post, row, fetch, bindings } = await fixture();
  const valid = '{"size":4}';
  for (const [body, headers] of [
    [null], ['{"size":'], ['null'], ['{"size":"4"}'], ['{"size":4,"name":"file"}'],
    ['{"size":-1}'], ['{"size":1.5}'], ['{"size":1.0000000000000001}'], ['{"size":1e0}'],
    ['{"size":1,"size":4}'], [JSON.stringify({ size: maxUploadIntentBytes + 1 })],
    [new Uint8Array([0xff])], [valid.padEnd(65)], [valid, { 'content-type': 'text/plain' }],
    [valid, { 'content-length': '65' }], [valid, { 'content-length': String(valid.length + 1) }],
    [valid, { 'content-length': String(valid.length - 1) }],
  ]) expect((await post(body, { headers })).status).toBe(400);
  expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).not.toHaveBeenCalled();
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['legacy', 'cancellation'], ['legacy', 'timeout'], ['bound', 'cancellation'], ['bound', 'timeout'],
])('stops reading a %s request on %s without dispatching a parseable prefix', async (mode, stop) => {
  const bound = mode === 'bound';
  const { post, row, fetch } = await fixture(bound ? stagingOrigin : origin);
  const controller = new AbortController();
  const cancel = vi.fn();
  const prefix = bound ? boundBody(0, empty) : '{"size":4}';
  const body = new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(prefix)); }, cancel });
  const response = post(body, { signal: controller.signal, overrides: bound ? multipart : {} });
  if (stop === 'cancellation') controller.abort();
  expect((await response).status).toBe(400);
  expect(cancel).toHaveBeenCalledOnce();
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
}, 10_000);

it('refuses unauthenticated, revoked and unconfigured HTTP requests before dispatch', async () => {
  const { post, request, row, db, owner, fetch } = await fixture();
  const body = '{"size":4}';
  for (const source of ['', 'https://other.example']) expect((await post(body, { req: request(source) })).status).toBe(403);
  expect((await post(body, { req: request(origin, '') })).status).toBe(401);
  for (const key of ['DB', 'DRIVE_ORIGIN', 'DRIVE_UPLOAD_EPOCH', 'DRIVE_UPLOAD_S3', 'DRIVE_UPLOAD_VERIFIER'])
    expect((await post(body, { overrides: { [key]: undefined } })).status).toBe(503);
  await db.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(owner).run();
  expect((await post(body)).status).toBe(401);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('requires the real session and exact origin for bound requests', async () => {
  const { post, request, revoke, row, fetch, bindings } = await fixture(stagingOrigin);
  const body = boundBody(0, empty);
  expect((await post(body, { req: request(origin), overrides: multipart })).status).toBe(403);
  expect((await post(body, { req: request(stagingOrigin, ''), overrides: multipart })).status).toBe(401);
  await revoke();
  expect((await post(body, { overrides: multipart })).status).toBe(401);
  expect(await row()).toBeNull();
  expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['late revocation', 'uncertain reply'])('keeps the bound journal on %s without returning an ID', async (outcome) => {
  const { post, revoke, row, fetch } = await fixture(stagingOrigin);
  const revoked = outcome === 'late revocation';
  fetch.mockImplementation(async () => {
    if (!revoked) return new Response('unknown outcome');
    const { object_key: key } = await row();
    await revoke();
    return new Response(`<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
  });
  const response = await post(boundBody(0, empty), { overrides: multipart });
  expect([response.status, response.headers.get('cache-control'), await response.text()])
    .toEqual([revoked ? 401 : 409, 'private, no-store', '']);
  expect(await row()).toMatchObject({ version: 2, expected_part_sha256s: empty,
    state: revoked ? 'allocated' : 'uncertain', upload_id: revoked ? 'provider-only' : null });
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not claim against qualified storage without a usable completion budget', async () => {
  const { post, row, fetch, bindings } = await fixture();
  for (const completionTimeoutMs of [undefined, () => null, () => 0, () => 1.5, () => 0x80000000]) {
    const verifier = { ...bindings.DRIVE_UPLOAD_VERIFIER, completionTimeoutMs };
    expect((await post('{"size":4}', { overrides: { DRIVE_UPLOAD_VERIFIER: verifier } })).status).toBe(503);
  }
  expect(bindings.DRIVE_UPLOAD_VERIFIER.isQualified).toHaveBeenCalledTimes(5);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('requires exact configured target and source origins, a live cookie and qualified storage', async () => {
  const { create, request, fetch, row, revoke } = await fixture();
  for (const source of ['', 'null', `${origin}/`, `${origin}, ${origin}`, 'https://other.example'])
    expect((await create(request(source))).status).toBe(403);
  expect((await create(request(origin, undefined, 'https://other.example'))).status).toBe(403);
  expect((await create(request(origin, ''))).status).toBe(401);
  for (const size of [-1, 1.5, maxUploadIntentBytes + 1]) expect((await create(undefined, size)).status).toBe(400);
  for (const override of [{ DRIVE_ORIGIN: `${origin}/` }, { DRIVE_UPLOAD_S3: undefined },
    { DRIVE_UPLOAD_S3: { ...config, endpoint: 'http://storage.example' } }, { DRIVE_UPLOAD_EPOCH: undefined },
    { DRIVE_UPLOAD_VERIFIER: undefined }, { DRIVE_UPLOAD_VERIFIER: { isQualified: async () => false } }])
    expect((await create(undefined, 4, override)).status).toBe(503);
  await revoke();
  expect((await create()).status).toBe(401);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  ['fixture', 'mutation', origin], ['fixture', 'dispatch', origin],
  ['staging invite', 'mutation', stagingOrigin], ['staging invite', 'dispatch', stagingOrigin],
  ['bound staging invite', 'mutation', stagingOrigin], ['bound staging invite', 'dispatch', stagingOrigin],
])('%s denies revocation at the %s boundary', async (mode, boundary, requestOrigin) => {
  const { db, owner, bindings, create, post, row, revoke, fetch } = await fixture(requestOrigin);
  const check = bindings.DRIVE_UPLOAD_VERIFIER.isQualified;
  check.mockImplementation(async () => {
    if (boundary === 'mutation') await revoke();
    else if (check.mock.calls.length === 2) await db.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(owner).run();
    return true;
  });
  const bound = mode === 'bound staging invite';
  const response = bound ? await post(boundBody(0, empty), { overrides: multipart }) : await create(undefined, 4, multipart);
  expect(response.status).toBe(boundary === 'mutation' ? 401 : 503);
  expect(fetch).not.toHaveBeenCalled();
  expect(await row()).toEqual(boundary === 'mutation' ? null : expect.objectContaining({ state: 'created', upload_id: null,
    expected_part_sha256s: bound ? empty : null }));
});

it('does not dispatch when the last qualification check consumes the deadline', async () => {
  const { bindings, create, row, fetch } = await fixture();
  const check = bindings.DRIVE_UPLOAD_VERIFIER.isQualified;
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  check.mockImplementation(async () => { if (check.mock.calls.length === 2) clock = 5000; return true; });
  try { expect((await create()).status).toBe(503); } finally { now.mockRestore(); }
  expect(await row()).toMatchObject({ state: 'created', upload_id: null });
  expect(fetch).not.toHaveBeenCalled();
});

it('does not dispatch if the session expires while the final lookup returns', async () => {
  const { bindings, request, row, fetch } = await fixture();
  const original = Sessions.prototype.lookupWithRemainingLifetime;
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const lookup = vi.spyOn(Sessions.prototype, 'lookupWithRemainingLifetime').mockImplementation(async function (token) {
    const session = await original.call(this, token);
    if (bindings.DRIVE_UPLOAD_VERIFIER.isQualified.mock.calls.length === 2 && session) clock += session.remaining_ms;
    return session;
  });
  try {
    const response = await createUploadIntent(request(), 4, bindings, { fetch, timeoutMs: 24 * 60 * 60 * 1000 });
    expect(response.status).toBe(503);
  } finally { lookup.mockRestore(); now.mockRestore(); }
  expect(clock).toBeGreaterThan(0);
  expect(await row()).toMatchObject({ state: 'created', upload_id: null });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['timeout', 'caller cancellation'])('stops an unresponsive qualification preflight: %s', async (stop) => {
  const { bindings, fetch, request, row } = await fixture();
  const check = bindings.DRIVE_UPLOAD_VERIFIER.isQualified;
  const controller = new AbortController();
  let approve, onStart;
  const started = new Promise(resolve => { onStart = resolve; });
  check.mockImplementation(() => new Promise(resolve => { approve = resolve; onStart(); }));
  const pending = createUploadIntent(new Request(request(), { signal: controller.signal }), 4, bindings,
    { fetch, timeoutMs: stop === 'timeout' ? 20 : 5000 });
  if (stop === 'caller cancellation') { await started; controller.abort(); }
  const response = await pending;
  expect(response.status).toBe(503);
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0][1].aborted).toBe(true);
  approve(true);
  expect(await row()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['confirmed', 'malformed', 'wrong key', 'post-dispatch session read failure'])('journals one signed attempt: %s', async (outcome) => {
  const { db, owner, request, bindings, row, fetch } = await fixture();
  let inFlight, receiver, response, lookup;
  fetch.mockImplementation(async function () {
    receiver = this;
    inFlight = await row();
    if (outcome === 'post-dispatch session read failure')
      lookup = vi.spyOn(Sessions.prototype, 'lookupWithRemainingLifetime').mockRejectedValueOnce(new Error('D1 unavailable'));
    const key = outcome === 'wrong key' ? 'different-key' : inFlight.object_key;
    return new Response(outcome === 'malformed' ? 'unknown outcome' :
      `<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
  });
  vi.stubGlobal('fetch', fetch);
  try { response = await createUploadIntent(request(), maxUploadIntentBytes, bindings); }
  finally { lookup?.mockRestore(); vi.unstubAllGlobals(); }
  const intent = await row(), success = outcome === 'confirmed';
  const allocated = success || outcome === 'post-dispatch session read failure';
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(receiver).toBe(globalThis);
  expect(inFlight).toMatchObject({ state: 'initiating', version: 1, declared_size: maxUploadIntentBytes });
  const [[signed]] = fetch.mock.calls;
  expect(signed.url).toBe(`${config.endpoint}/${config.bucket}/${intent.object_key}?uploads=`);
  expect(signed.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(response.status).toBe(success ? 201 : 409);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.text()).toBe(success ? JSON.stringify({ id: intent.id }) : '');
  expect(intent).toMatchObject({ state: allocated ? 'allocated' : 'uncertain', version: 2, upload_id: allocated ? 'provider-only' : null });
  expect(await db.prepare('SELECT * FROM drive_upload_storage_bindings WHERE intent_id = ?').bind(intent.id).first())
    .toEqual({ intent_id: intent.id, endpoint: config.endpoint, bucket: config.bucket, storage_epoch: 'fixture' });
  await expect(db.prepare('UPDATE drive_upload_intents SET declared_size = 1 WHERE id = ?').bind(intent.id).run()).rejects.toThrow('immutable');
  expect(await new UploadIntents(db).claim(owner, intent.id, intent.version, 'allocation')).toBeNull();
});
