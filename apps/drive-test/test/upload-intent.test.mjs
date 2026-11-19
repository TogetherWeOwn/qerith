import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { createUploadIntent, maxUploadIntentBytes } from '../../drive/src/lib/server/upload-intent.ts';

const origin = 'https://drive.example';
const config = { endpoint: 'https://storage.example', bucket: 'drive-test', region: 'us-east-1', accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' };
async function fixture() {
  const db = env.DB, owner = crypto.randomUUID();
  await applyD1Migrations(db, env.DRIVE_MIGRATIONS);
  await db.prepare("INSERT INTO drive_principals VALUES (?, 'member', 'active')").bind(owner).run();
  const sessions = new Sessions(db), { token } = await sessions.issue(owner);
  const bindings = { DB: db, DRIVE_ORIGIN: origin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: 'fixture',
    DRIVE_UPLOAD_VERIFIER: { isQualified: vi.fn(async () => true) } };
  const request = (source = origin, cookie = `__Host-drive-session=${token}`, target = origin) =>
    new Request(`${target}/intents`, { method: 'POST', headers: { ...(source ? { origin: source } : {}), cookie } });
  const fetch = vi.fn();
  const create = (req = request(), size = 4, overrides = {}) =>
    createUploadIntent(req, size, { ...bindings, ...overrides }, { fetch, timeoutMs: 5000 });
  const row = () => db.prepare('SELECT * FROM drive_upload_intents WHERE owner_id = ?').bind(owner).first();
  return { db, bindings, request, fetch, create, row, owner, revoke: () => sessions.revoke(token) };
}

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

it.each(['mutation', 'dispatch'])('denies revocation at the %s boundary', async (boundary) => {
  const { db, owner, bindings, create, row, revoke, fetch } = await fixture();
  const check = bindings.DRIVE_UPLOAD_VERIFIER.isQualified;
  check.mockImplementation(async () => {
    if (boundary === 'mutation') await revoke();
    else if (check.mock.calls.length === 2) await db.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(owner).run();
    return true;
  });
  expect((await create()).status).toBe(boundary === 'mutation' ? 401 : 503);
  expect(fetch).not.toHaveBeenCalled();
  expect(await row()).toEqual(boundary === 'mutation' ? null : expect.objectContaining({ state: 'created', upload_id: null }));
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

it.each(['confirmed', 'malformed', 'wrong key'])('journals one signed attempt after a %s reply', async (outcome) => {
  const { db, owner, request, bindings, row, fetch } = await fixture();
  let inFlight, receiver, response;
  fetch.mockImplementation(async function () {
    receiver = this;
    inFlight = await row();
    const key = outcome === 'wrong key' ? 'different-key' : inFlight.object_key;
    return new Response(outcome === 'malformed' ? 'unknown outcome' :
      `<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>provider-only</UploadId></InitiateMultipartUploadResult>`);
  });
  vi.stubGlobal('fetch', fetch);
  try { response = await createUploadIntent(request(), maxUploadIntentBytes, bindings); } finally { vi.unstubAllGlobals(); }
  const intent = await row(), success = outcome === 'confirmed';
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(receiver).toBe(globalThis);
  expect(inFlight).toMatchObject({ state: 'initiating', version: 1, declared_size: maxUploadIntentBytes });
  const [[signed]] = fetch.mock.calls;
  expect(signed.url).toBe(`${config.endpoint}/${config.bucket}/${intent.object_key}?uploads=`);
  expect(signed.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
  expect(response.status).toBe(success ? 201 : 409);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.text()).toBe(success ? JSON.stringify({ id: intent.id }) : '');
  expect(intent).toMatchObject({ state: success ? 'allocated' : 'uncertain', version: 2, upload_id: success ? 'provider-only' : null });
  expect(await db.prepare('SELECT * FROM drive_upload_storage_bindings WHERE intent_id = ?').bind(intent.id).first())
    .toEqual({ intent_id: intent.id, endpoint: config.endpoint, bucket: config.bucket, storage_epoch: 'fixture' });
  await expect(db.prepare('UPDATE drive_upload_intents SET declared_size = 1 WHERE id = ?').bind(intent.id).run()).rejects.toThrow('immutable');
  expect(await new UploadIntents(db).claim(owner, intent.id, intent.version, 'allocation')).toBeNull();
});
