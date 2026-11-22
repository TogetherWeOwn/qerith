import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readinessPath } from '../src/lib/server/qualification-readiness.ts';
import { exerciseQualificationResumeFixture } from '../scripts/staging-qualification-app-transfer.mjs';
import { fixture as passkey } from './ceremony-fixture.ts';

const uploads = '/api/uploads';
const revokedMemberId = '00000000-0000-4000-8000-000000000003';
const foreignMemberId = '00000000-0000-4000-8000-000000000004';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sessionCookie = '__Host-drive-session';

// Serialized into the disposable Worker. Unexpected calls fail without a network fallback.
export function qualificationTransferStorage(prefix) {
  let key, completed = false;
  const parts = [];
  const uploadId = 'fixture-transfer', etag = '"fixture-object"', bucket = 'fixture';
  return async request => {
    const { origin, pathname, searchParams: query } = new URL(request.url);
    const { method, headers } = request;
    const object = decodeURIComponent(pathname).slice(`/${bucket}/`.length);
    if (origin !== 'https://storage.example.test' || !pathname.startsWith(`/${bucket}/`) ||
        !object.startsWith(prefix) || !/^[a-f0-9-]{36}$/.test(object.slice(prefix.length)) || !headers.has('authorization')) {
      throw new Error('Unexpected qualification fixture storage target');
    }
    if (!key && method === 'POST' && query.has('uploads')) {
      key = object;
      return new Response(`<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (!key || key !== object) throw new Error('Unexpected qualification fixture key');
    if (!completed && query.get('uploadId') === uploadId) {
      const number = parts.length + 1;
      if (method === 'PUT' && number <= 2 && query.get('partNumber') === String(number)) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length !== (number === 1 ? 16 * 1024 ** 2 : 257)) throw new Error('Unexpected qualification fixture part length');
        parts.push(bytes);
        return new Response(null, { headers: { etag: `"part-${number}"` } });
      }
      if (method === 'GET') {
        const entries = parts.map(({ length }, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>"part-${i + 1}"</ETag><Size>${length}</Size></Part>`);
        return new Response(`<ListPartsResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId><IsTruncated>false</IsTruncated>${entries.join('')}</ListPartsResult>`);
      }
      if (method === 'POST' && parts.length === 2) {
        const manifest = await request.text();
        if (/<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>/.test(manifest)) {
          completed = true;
          return new Response(`<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
        }
      }
    }
    if (completed && !query.size && headers.get('if-match') === etag) {
      const evidence = { etag, 'content-length': String(parts[0].length + parts[1].length) };
      if (method === 'HEAD') return new Response(null, { headers: evidence });
      if (method === 'GET' && !headers.has('range')) return new Response(new ReadableStream({ start(stream) {
        for (const bytes of parts) stream.enqueue(bytes);
        stream.close();
      } }), { headers: evidence });
    }
    throw new Error('Unexpected qualification fixture storage operation');
  };
}

export async function exerciseQualificationTransferWorker({ worker, DB, origin, scope, session }) {
  const send = (path, init, cookie, overrides) => {
    init.signal?.throwIfAborted();
    return worker.fetch(`${origin}${path}`, { ...init, redirect: 'manual',
      headers: { ...init.headers, origin, ...(cookie && { cookie }), ...overrides } });
  };
  const post = (path, body, cookie, signal) => send(path, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, cookie);
  const empty = async (response, status) => {
    assert.deepEqual([response.status, await response.text()], [status, '']);
  };
  const owner = await session('fixture-owner', 'owner');
  const revoked = await session(revokedMemberId, 'member');
  const foreign = await session(foreignMemberId, 'member');
  await empty(await post(`/api/owner/members/${revokedMemberId}/revoke`, undefined, owner), 204);
  const invited = await post('/api/owner/invitations', { displayName: 'Qualification transfer member' }, owner);
  assert.equal(invited.status, 201);
  const { token } = await invited.json();
  const issued = await post('/api/invite/challenge', { token });
  assert.equal(issued.status, 200);
  const { options: { challenge, rp: { id: rpID }, user: { id: userHandle } } } = await issued.json();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { registration } = await passkey('registration', { key, origin, rpID, challenge });
  await empty(await post('/api/invite/enroll', { token, challenge, response: registration }), 204);
  const principal = await DB.prepare('SELECT principal_id FROM drive_credentials WHERE id = ?').bind(registration.id).first('principal_id');
  assert.match(principal, /^[a-f0-9-]{36}$/);
  assert.notEqual(principal, revokedMemberId);

  let counter = 1;
  const cookiePair = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0];
  const signIn = async signal => {
    const issued = await post('/api/sign-in/challenge', undefined, undefined, signal);
    assert.equal(issued.status, 200);
    const { challenge } = await issued.json();
    const transaction = cookiePair(issued, '__Host-drive-login');
    assert.ok(transaction);
    const { authentication } = await passkey('authentication', { key, challenge, origin, rpID, counter: ++counter });
    authentication.response.userHandle = userHandle;
    const verified = await post('/api/sign-in/verify', authentication, transaction, signal);
    await empty(verified, 204);
    const cookie = cookiePair(verified, sessionCookie);
    assert.ok(cookie);
    return cookie;
  };
  const sessionHash = cookie => sha256(cookie.slice(sessionCookie.length + 1));
  const observed = [], opened = [];
  let packed, firstCookie, id, objectKey;
  const lookup = id => DB.prepare('SELECT owner_id, object_key, expected_part_sha256s FROM drive_upload_intents WHERE id = ?').bind(id).first();
  const openClient = async (requested, signal, binding) => {
    assert.deepEqual(requested, scope);
    signal.throwIfAborted();
    if (id) {
      assert.deepEqual(binding, { principalId: principal, intentId: id });
      await DB.prepare('UPDATE drive_sessions SET expires_at = 0 WHERE token_hash = ?').bind(sessionHash(firstCookie)).run();
    } else assert.deepEqual(binding, { principalId: null, intentId: null });
    const cookie = await signIn(signal);
    assert.ok(cookie !== firstCookie, 'reopen issues a fresh synthetic session');
    firstCookie ??= cookie;
    const active = await DB.prepare(`SELECT p.id, p.role FROM drive_principals p JOIN drive_sessions s ON s.principal_id = p.id
      WHERE s.token_hash = ? AND p.status = 'active' AND s.expires_at > ?`).bind(sessionHash(cookie), Date.now()).first();
    assert.deepEqual(active, { id: principal, role: 'member' });
    opened.push(active.id);
    return { scope, principalId: active.id, role: active.role, intentId: id ?? null, async request(path, init) {
      if (path === readinessPath) return send(path, init);
      observed.push(`${init.method} ${path}`);
      if (path === uploads) {
        for (const [actor, status, overrides] of [[owner, 400], [cookie, 403, { 'x-test-invite': '0' }],
          [undefined, 401], [revoked, 401]]) await empty(await send(path, init, actor, overrides), status);
        assert.equal(await DB.prepare('SELECT count(*) AS total FROM drive_upload_intents').first('total'), 0);
        const response = await send(path, init, cookie);
        assert.equal(response.status, 201);
        ({ id } = await response.clone().json());
        ({ expectedPartSha256s: packed } = JSON.parse(init.body));
        assert.equal(packed.length, 128);
        const row = await lookup(id);
        assert.equal(row.owner_id, principal);
        assert.equal(row.expected_part_sha256s, packed);
        assert.ok(row.object_key.startsWith(scope.prefix));
        assert.match(row.object_key.slice(scope.prefix.length), /^[a-f0-9-]{36}$/);
        objectKey = row.object_key;
        return response;
      }
      if (path === `${uploads}/${id}/resume`) {
        for (const [actor, status, overrides] of [[foreign, 404], [cookie, 404, { 'x-test-invite': '0' }],
          [undefined, 401], [revoked, 401], [firstCookie, 401]]) await empty(await send(path, init, actor, overrides), status);
        const response = await send(path, init, cookie);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.clone().json(), { declaredSize: 16 * 1024 ** 2 + 257,
          expectedPartSha256s: packed, parts: [{ partNumber: 1, sizeBytes: 16 * 1024 ** 2, sha256: packed.slice(0, 64) }] });
        return response;
      }
      return send(path, init, cookie);
    } };
  };
  const signal = AbortSignal.timeout(45_000);
  assert.deepEqual(await exerciseQualificationResumeFixture(scope, signal, openClient, revokedMemberId), { 'interrupted-transfer-resume': 'pass' });
  assert.deepEqual(opened, [principal, principal]);
  const row = await DB.prepare(`SELECT entry_id, owner_id, object_key FROM drive_published_generations WHERE intent_id = ?`)
    .bind(id).first();
  assert.equal(row?.owner_id, principal);
  assert.equal(row.object_key, objectKey);
  assert.deepEqual(observed, [`POST ${uploads}`, `PUT ${uploads}/${id}/parts/1`, `GET ${uploads}/${id}/resume`,
    `PUT ${uploads}/${id}/parts/2`, `POST ${uploads}/${id}/complete`, `GET /api/download/${row.entry_id}`]);
  assert.equal(await DB.prepare('SELECT count(*) AS total FROM drive_upload_intents').first('total'), 1);
  console.log('Generated Worker: qualified invitee sealed one scoped intent and resumed with a fresh session, without part replay');
}
