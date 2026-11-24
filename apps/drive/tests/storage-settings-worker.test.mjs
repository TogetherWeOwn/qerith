import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempDisposable, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { Sessions } from '../src/lib/server/identity/sessions.ts';
import { createS3Listing } from '../src/lib/server/s3/listing.ts';
import { fixture as passkey } from './ceremony-fixture.ts';
import { withStorageSettingsMinio } from './storage-settings-minio-fixture.mjs';

const origin = 'https://drive-owner-fixture.example.test';
const settingsPath = '/api/owner/storage';
const unconfigured = { status: 'unconfigured', revision: null, config: null };
const randomToken = () => randomBytes(32).toString('base64url');

async function withWorker(run, { settingsKey, outboundService = () => { throw new Error('Unexpected outbound request'); } } = {}) {
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  const release = 'a'.repeat(40), bootstrap = randomToken();
  const worker = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.NONE),
    modules: [{ type: 'ESModule', path: resolve(process.env.DRIVE_SETTINGS_PACKAGE || '.svelte-kit/first-release-package/_worker.js') }],
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    assets: { ...config.assets, directory: resolve(config.assets.directory), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: randomUUID() },
    bindings: {
      DRIVE_ORIGIN: origin, DRIVE_FIRST_RELEASE_ORIGIN: origin, DRIVE_OWNER_ENROLLMENT_RELEASE: release,
      DRIVE_OWNER_ENROLLMENT: `${release}:${Date.now() + 300_000}:${bootstrap}`,
      ...(settingsKey && { DRIVE_STORAGE_SETTINGS_KEY: settingsKey }),
    },
    outboundService,
  }));
  try {
    const db = await worker.getD1Database('DB');
    for (const name of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
      const sql = unstable_splitSqlQuery(await readFile(join('migrations', name), 'utf8'));
      await db.batch(sql.map(statement => db.prepare(statement)));
    }
    const send = async (status, method, path, { cookie, body, headers } = {}) => {
      const typed = body === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' };
      const response = await worker.dispatchFetch(origin + path, { method, redirect: 'manual',
        headers: { origin, 'sec-fetch-site': 'same-origin', ...typed, ...(cookie && { cookie }), ...headers },
        body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      assert.equal(response.status, status, `${method} ${path}`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      return response;
    };
    await run({ db, send, bootstrap });
  } finally { await worker.dispose(); }
}

async function ownerSession(send, bootstrap) {
  const path = '/api/deployer/owner-enrollment';
  const headers = { authorization: `Bearer ${bootstrap}` };
  const body = { operation: 'challenge' };
  await send(403, 'POST', path, { body });
  await send(403, 'POST', path, { body, headers: { ...headers, origin: 'https://elsewhere.example.test' } });
  const { options } = await (await send(200, 'POST', path, { body, headers })).json();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rpID = new URL(origin).hostname;
  const { registration } = await passkey('registration', { key, origin, rpID, challenge: options.challenge });
  assert.equal((await (await send(200, 'POST', path, { headers,
    body: { operation: 'enroll', challenge: options.challenge, response: registration } })).json()).ok, true);
  await send(409, 'POST', path, { headers, body });
  const issued = await send(200, 'POST', '/api/sign-in/challenge');
  const transaction = issued.headers.get('set-cookie').split(';')[0];
  const { challenge } = await issued.json();
  const { authentication } = await passkey('authentication', { key, origin, rpID, challenge, counter: 2 });
  authentication.response.userHandle = options.user.id;
  const verified = await send(204, 'POST', '/api/sign-in/verify', { cookie: transaction, body: authentication });
  const cookie = verified.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^__Host-drive-session=[A-Za-z0-9_-]{43}$/);
  return cookie;
}

test('the packaged Worker admits first-owner setup and closes file bytes without S3 bindings', { timeout: 30_000 }, async () => {
  await withWorker(async ({ db, send, bootstrap }) => {
    const html = await (await send(200, 'GET', '/sign-in')).text();
    assert.match(html, /Sign in/);
    const asset = html.match(/\/_app\/immutable\/[\w./-]+\.(?:js|css)/)?.[0];
    assert.ok(asset);
    await (await send(200, 'GET', asset)).body.cancel();
    await send(401, 'GET', '/');
    for (const [method, path] of [['GET', settingsPath], ['PUT', settingsPath], ['POST', `${settingsPath}/test`]]) {
      await send(401, method, path);
    }
    const cookie = await ownerSession(send, bootstrap);
    await send(200, 'HEAD', '/', { cookie });
    await (await send(200, 'GET', '/', { cookie })).body.cancel();
    assert.deepEqual(await (await send(200, 'GET', settingsPath, { cookie })).json(), unconfigured);
    const member = randomUUID();
    await db.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')").bind(member).run();
    const memberCookie = `__Host-drive-session=${(await new Sessions(db).issue(member)).token}`;
    for (const [method, path] of [['GET', settingsPath], ['PUT', settingsPath], ['POST', `${settingsPath}/test`]]) {
      await send(403, method, path, { cookie: memberCookie });
      await send(403, method, path, { cookie, headers: { origin: 'https://elsewhere.example.test' } });
    }
    const id = randomUUID();
    for (const [method, path] of [['POST', '/api/uploads'], ['PUT', `/api/uploads/${id}/parts/1`],
      ['POST', `/api/uploads/${id}/complete`], ['GET', `/api/uploads/${id}/resume`], ['GET', `/api/download/${id}`]]) {
      await send(401, method, path);
      await send(403, method, path, { cookie: memberCookie });
      assert.deepEqual(await (await send(503, method, path, { cookie })).json(), { error: 'storage_unconfigured' });
    }
    assert.equal(await db.prepare('SELECT count(*) AS count FROM drive_upload_intents').first('count'), 0);
  });
});

test('the packaged Worker verifies MinIO permissions, saves encrypted settings and transfers bytes',
  { timeout: 120_000, skip: process.env.DRIVE_STORAGE_SETTINGS_MINIO !== '1' }, async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), 'drive-owner-storage-test-'));
    await withStorageSettingsMinio(dir.path, 'drive-owner-storage-test', async ({ config: { secretAccessKey, ...config }, outbound, minio }) => {
      const { bucket, accessKeyId } = config;
      const input = { ...config, secretAccessKey, revision: null };
      const operations = [];
      let redirect = false;
      const outboundService = (request) => outbound(request, (request) => {
        const url = new URL(request.url);
        operations.push(`${request.method} ${url.pathname.startsWith(`/${bucket}/drive-storage-probes/`) ? 'probe' : 'file'} ${[...url.searchParams.keys()].sort().join(',')}`);
        if (redirect) return new Response(null, { status: 307, headers: { location: 'https://different.example.com/' } });
      });
      await withWorker(async ({ db, send, bootstrap }) => {
        const cookie = await ownerSession(send, bootstrap);
        const redacted = async (response, secret = secretAccessKey) => {
          const text = await response.text();
          assert.ok(!text.includes(secret), 'Storage settings response exposed a secret');
          return JSON.parse(text);
        };
        const read = async () => redacted(await send(200, 'GET', settingsPath, { cookie }));
        const write = async (status, body, test = false) => redacted(await send(status, test ? 'POST' : 'PUT',
          test ? `${settingsPath}/test` : settingsPath, { cookie, body }), body.secretAccessKey);
        assert.deepEqual(await read(), unconfigured);
        for (const bad of ['http://drive-storage.example.com', 'https://127.0.0.1', 'https://[::1]']) {
          assert.deepEqual(await write(400, { ...input, endpoint: bad }, true), { error: 'invalid_settings' });
        }
        try { assert.deepEqual(await write(200, input, true), { status: 'verified' }); }
        catch (error) { throw new Error(`MinIO probe stopped after ${operations.join('; ') || 'zero S3 operations'}`, { cause: error }); }
        assert.deepEqual(await read(), unconfigured);
        const connected = await write(200, input);
        assert.deepEqual(connected, { status: 'connected', config, revision: connected.revision });
        assert.match(connected.revision, /^[a-f0-9-]{36}$/);
        const stored = await db.prepare('SELECT * FROM drive_storage_settings').first();
        assert.ok(stored.ciphertext.length > 32 && !JSON.stringify(stored).includes(secretAccessKey) &&
          !JSON.stringify(stored).includes(accessKeyId));
        assert.deepEqual(await read(), connected);
        for (const operation of ['POST probe uploads', 'DELETE probe uploadId', 'PUT probe partNumber,uploadId',
          'GET probe uploadId', 'POST probe uploadId', 'HEAD probe ', 'GET probe ', 'DELETE probe ']) assert.ok(operations.includes(operation), operation);

        const data = Buffer.from('Fixture bytes after owner storage setup');
        const expectedPartSha256s = createHash('sha256').update(data).digest('hex');
        const { id } = await (await send(201, 'POST', '/api/uploads', { cookie, body: { size: data.length, expectedPartSha256s } })).json();
        const edit = { ...config, revision: connected.revision };
        assert.deepEqual(await write(409, { ...edit, bucket: 'different-bucket' }), { error: 'storage_location_locked' });
        redirect = true;
        const count = operations.length;
        assert.deepEqual(await write(422, { ...edit, secretAccessKey: randomToken() }), { error: 'connection_failed' });
        assert.equal(operations.length, count + 1);
        redirect = false;
        assert.deepEqual(await write(422, { ...edit, secretAccessKey: randomToken() }), { error: 'connection_failed' });
        assert.deepEqual(await read(), connected);
        const rotated = await write(200, edit);
        assert.notEqual(rotated.revision, connected.revision);
        assert.deepEqual(await read(), rotated);
        assert.equal(await db.prepare('SELECT storage_epoch FROM drive_storage_settings').first('storage_epoch'), stored.storage_epoch);
        assert.deepEqual(await write(409, edit), { error: 'settings_conflict' });

        await send(204, 'PUT', `/api/uploads/${id}/parts/1`, { cookie, body: data });
        const resume = await (await send(200, 'GET', `/api/uploads/${id}/resume`, { cookie })).json();
        assert.equal(resume.parts[0].sha256, expectedPartSha256s);
        const { id: file } = await (await send(201, 'POST', `/api/uploads/${id}/complete`, { cookie,
          body: { parentId: null, name: 'test-transfer.bin' } })).json();
        const download = await send(200, 'GET', `/api/download/${file}`, { cookie });
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), data);
        assert.equal(await db.prepare('SELECT count(*) AS count FROM drive_storage_probe').first('count'), 0);
        const listing = createS3Listing(minio.settings, minio.options);
        const { keys } = await listing.objects({ verifyScope: true });
        assert.equal(keys.length, 1);
        assert.ok(!keys[0].startsWith('drive-storage-probes/'));
        assert.deepEqual((await listing.uploads({ verifyScope: true })).uploads, []);
      }, { settingsKey: randomToken(), outboundService });
    });
  });
