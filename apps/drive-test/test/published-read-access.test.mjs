import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { createPublishedReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { publishedDownload } from '../../drive/src/lib/server/published-download.ts';
import { config, epoch, parts, seed, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

const expectedConfigId = JSON.stringify([config.endpoint, config.bucket, epoch]);

it('resolves the current listed name and exact generation for a live owner or grantee only', async () => {
  const { id, key, token, evidenceRevision } = await seedBoundPublication('read-grant', { key: `${String.fromCodePoint(0xfeff)}folder/clé` });
  const owner = 'owner-read-grant';
  const metadata = new PrivateMetadata(env.DB);
  const { id: folder } = await metadata.createFolder(owner, null, 'shared');
  const name = 'résumé.pdf';
  await metadata.move(owner, id, folder, name);
  await sql("INSERT INTO drive_principals (id, role, status) VALUES ('reader', 'member', 'active')").run();
  const reader = (await sessions.issue('reader')).token;
  const grants = new ReadGrants(env.DB);
  const primary = vi.fn((mode) => env.DB.withSession(mode));
  const { resolveGeneration, storageConfigId } = createPublishedReadAccess({ withSession: primary }, epoch, config);
  expect(storageConfigId).toBe(expectedConfigId);
  const reference = { name, key, etag, storageConfigId: expectedConfigId, evidenceRevision, sizeBytes: 7 };
  expect(await resolveGeneration(token, id)).toEqual(reference);
  expect(await resolveGeneration(reader, id)).toBeNull();
  expect(await grants.create(token, folder, 'reader')).toBe(true);
  expect(await resolveGeneration(reader, id)).toEqual(reference);
  expect(await grants.revoke(token, folder, 'reader')).toBe(true);
  expect(await resolveGeneration(reader, id)).toBeNull();
  expect(await grants.create(token, id, 'reader')).toBe(true);
  expect(await resolveGeneration(reader, id)).toEqual(reference);
  await sessions.revoke(reader);
  expect(await resolveGeneration(reader, id)).toBeNull();
  const renewed = (await sessions.issue('reader')).token;
  await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner).run();
  expect(await resolveGeneration(renewed, id)).toBeNull();
  expect(primary.mock.calls).toEqual(Array.from({ length: 7 }, () => ['first-primary']));
});

it('returns no reference for legacy rows, wrong configuration, mismatched size, tombstones or deletion', async () => {
  const { id, intent, token } = await seedBoundPublication('read-fence');
  const { resolveGeneration } = createPublishedReadAccess(env.DB, epoch, config);
  expect(await resolveGeneration(token, id)).not.toBeNull();
  for (const [wrongEpoch, wrongConfig] of [[epoch, { ...config, bucket: 'other-bucket' }],
    [epoch, { ...config, endpoint: 'https://other.example' }], ['epoch-2', config]]) {
    expect(await createPublishedReadAccess(env.DB, wrongEpoch, wrongConfig).resolveGeneration(token, id)).toBeNull();
  }
  const legacy = await seed('read-legacy', { declaredSize: 7 });
  const publication = new UploadPublication(env.DB, async () => ({ etag, size: 7 }), legacy.token);
  const legacyFile = await publication.completeAndPublish('owner-read-legacy', legacy.intent, 2, null, 'old', parts);
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications WHERE entry_id = ?', legacyFile.id).first())
    .toEqual({ completion_operation_id: null, evidence_revision: null });
  expect(await resolveGeneration(legacy.token, legacyFile.id)).toBeNull();
  await sql('UPDATE drive_entries SET size_bytes = 8 WHERE id = ?', id).run();
  expect(await resolveGeneration(token, id)).toBeNull();
  await sql('UPDATE drive_entries SET size_bytes = 7 WHERE id = ?', id).run();
  expect(await resolveGeneration(token, id)).not.toBeNull();
  await sql('INSERT INTO drive_upload_publication_tombstones VALUES (CAST(? AS TEXT))', intent).run();
  expect(await resolveGeneration(token, id)).toBeNull();
  const gone = await seedBoundPublication('read-gone');
  expect(await resolveGeneration(gone.token, gone.id)).not.toBeNull();
  expect(await new PrivateDeletion(env.DB).delete(gone.token, gone.id)).toBe(true);
  expect(await resolveGeneration(gone.token, gone.id)).toBeNull();
});

it.each([
  ['deletion', ({ id, key }, operation) => sql('INSERT INTO drive_deleted_entries VALUES (?, ?, ?, ?)', id, 'pending-deletion', `owner-${operation}`, key)],
  ['quarantine', (_file, operation) => sql('INSERT INTO drive_upload_completion_quarantine VALUES (?)', operation)],
])('denies a live published entry with %s evidence', async (label, fence) => {
  const operation = `read-ledger-${label}`;
  const file = await seedBoundPublication(operation);
  const { resolveGeneration } = createPublishedReadAccess(env.DB, epoch, config);
  expect(await resolveGeneration(file.token, file.id)).not.toBeNull();
  expect((await fence(file, operation).run()).meta.changes).toBe(1);
  expect(await sql('SELECT id FROM drive_entries WHERE id = ?', file.id).first()).toEqual({ id: file.id });
  expect(await resolveGeneration(file.token, file.id)).toBeNull();
});

it('preserves opaque evidence and fails closed on malformed evidence or a primary read failure', async () => {
  const evidenceRevision = 'opaque-revision'.padEnd(36, '0');
  const revisionHex = new TextEncoder().encode(evidenceRevision).toHex();
  const row = { keyHex: '6b', nameHex: '6e', etag, sizeBytes: 7, revisionHex };
  const primary = (first) => ({ withSession: () => ({ prepare: () => ({ bind: () => ({ first }) }) }) });
  const valid = createPublishedReadAccess(primary(async () => row), epoch, config);
  expect(await valid.resolveGeneration('a'.repeat(43), 'id')).toMatchObject({ evidenceRevision });
  for (const bad of [{ keyHex: 'ff' }, { nameHex: 'ff' }, { etag: 'W/"weak"' }, { revisionHex: 'ff' },
    { revisionHex: '61' }, { revisionHex: `${revisionHex}00` }, { sizeBytes: -1 }]) {
    const { resolveGeneration } = createPublishedReadAccess(primary(async () => ({ ...row, ...bad })), epoch, config);
    expect(await resolveGeneration('a'.repeat(43), 'id')).toBeNull();
  }
  const { resolveGeneration } = createPublishedReadAccess(primary(async () => { throw new Error('unavailable'); }), epoch, config);
  expect(await resolveGeneration('a'.repeat(43), 'id')).toBeNull();
});

it('composes with immutable full and range GETs without storage calls for denied or unbound reads', async () => {
  const { id, token } = await seedBoundPublication('read-stream');
  const storage = { DB: env.DB, DRIVE_S3_ENDPOINT: config.endpoint, DRIVE_S3_BUCKET: config.bucket,
    DRIVE_S3_REGION: config.region, DRIVE_S3_ACCESS_KEY_ID: config.accessKeyId,
    DRIVE_S3_SECRET_ACCESS_KEY: config.secretAccessKey, DRIVE_S3_STORAGE_EPOCH: epoch };
  const fetch = vi.fn(async (request) => request.headers.has('range')
    ? new Response('bc', { status: 206, headers: { etag, 'content-range': 'bytes 1-2/7', 'content-length': '2' } })
    : new Response('abcdefg', { headers: { etag, 'content-length': '7' } }));
  const onReadError = vi.fn();
  const get = (headers = {}, auth = token, bindings = storage, signal) => publishedDownload(
    new Request('https://drive.example/file', { headers, signal }), id, auth, bindings, onReadError, fetch);
  for (const response of [await get({}, 'a'.repeat(43)), await get({}, token,
    { ...storage, DRIVE_S3_STORAGE_EPOCH: 'different-epoch' })]) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBeNull();
  }
  expect(onReadError).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const full = await get();
  expect(full.status).toBe(200);
  expect(full.headers.get('content-length')).toBe('7');
  expect(await full.text()).toBe('abcdefg');
  const range = await get({ range: 'bytes=1-2' });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-length')).toBe('2');
  expect(await range.text()).toBe('bc');
  const url = `${config.endpoint}/${config.bucket}/key-read-stream`;
  expect(fetch.mock.calls.map(([request]) => [request.method, request.url, request.headers.get('if-match'), request.headers.get('range')]))
    .toEqual([['GET', url, etag, null], ['GET', url, etag, 'bytes=1-2']]);
  for (const [request] of fetch.mock.calls) expect(request.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*if-match/);
  for (const upstream of [new Response(null, { status: 404 }), new Response(null, { status: 412 }),
    new Response('bc', { status: 206, headers: { etag, 'content-range': 'bytes 1-2/8', 'content-length': '2' } }),
    new Response('bc', { status: 206, headers: { etag: '"different"', 'content-range': 'bytes 1-2/7' } })]) {
    fetch.mockResolvedValueOnce(upstream);
    const denied = await get({ range: 'bytes=1-2' });
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('');
  }
  expect(onReadError).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(new Response(null, { headers: { etag, 'content-length': '7' } }));
  const empty = await get();
  expect(empty.status).toBe(404);
  expect(empty.headers.get('content-disposition')).toBeNull();
  expect(onReadError).toHaveBeenCalledTimes(1);
  const singleHeaders = { etag, 'content-range': 'bytes 1-1/7', 'content-length': '1' };
  fetch.mockResolvedValueOnce(new Response('b', { status: 206, headers: singleHeaders }));
  expect(await (await get({ range: 'bytes=1-1' })).text()).toBe('b');
  fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(output) {
    output.enqueue(new Uint8Array([98]));
  }, pull(output) { output.error(new Error('EOF unavailable')); } }, { highWaterMark: 0 }),
  { status: 206, headers: singleHeaders }));
  expect((await get({ range: 'bytes=1-1' })).status).toBe(404);
  for (const range of [null, 'bytes=1-2']) {
    fetch.mockResolvedValueOnce(new Response('b', { status: range ? 206 : 200, headers: range
      ? { etag, 'content-range': 'bytes 1-2/7', 'content-length': '2' } : { etag, 'content-length': '7' } }));
    const truncated = await get(range ? { range } : {});
    expect(truncated.status).toBe(range ? 206 : 200);
    await expect(truncated.arrayBuffer()).rejects.toThrow();
  }
  for (const stop of ['provider', 'client', 'backpressure', 'final-byte', 'single-byte']) {
    const single = stop === 'single-byte', afterEof = single || stop === 'final-byte';
    const cancelled = vi.fn();
    const abort = new AbortController();
    const cutoff = new AbortController();
    const eof = Promise.withResolvers();
    let source;
    const pendingEof = new ReadableStream({ start(output) {
      source = output;
      output.enqueue(new TextEncoder().encode(single ? 'b' : 'abcdefg'));
    }, pull(output) {
      if (afterEof) output.close();
      eof.resolve();
    }, cancel: cancelled }, { highWaterMark: 0 });
    fetch.mockResolvedValueOnce(new Response(pendingEof, single
      ? { status: 206, headers: singleHeaders } : { headers: { etag, 'content-length': '7' } }));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(cutoff.signal);
    const client = (await get(single ? { range: 'bytes=1-1' } : {}, token, storage, abort.signal)
      .finally(() => timeout.mockRestore())).body.getReader();
    if (stop === 'backpressure') {
      cutoff.abort();
      expect(cancelled).toHaveBeenCalledOnce(); // Before any client read relieves backpressure.
    } else {
      if (!single) expect(new TextDecoder().decode((await client.read()).value)).toBe('abcdef');
      await eof.promise;
      if (afterEof) {
        await scheduler.wait(0); // Let the verified final byte reach the native writer, not the client.
        cutoff.abort();
      } else if (stop === 'client') abort.abort();
      else source.error(new Error('EOF unavailable'));
    }
    await expect(client.read(), stop).rejects.toThrow();
    if (stop === 'client') expect(cancelled).toHaveBeenCalledOnce();
  }
  await sessions.revoke(token);
  const revoked = await get({ 'if-none-match': etag, range: 'bytes=20-' });
  expect(revoked.status).toBe(404);
  expect(revoked.headers.get('content-range')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(16);
});
