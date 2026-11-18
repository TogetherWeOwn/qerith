import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { downloadFile } from '../../drive/src/lib/server/download.ts';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { createPublishedReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { createImmutableS3Reader, createS3Objects } from '../../drive/src/lib/server/s3/objects.ts';
import { config, epoch, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

it('resolves the current listed name and exact generation for a live owner or grantee only', async () => {
  const { id, key, token, evidenceRevision } = await seedBoundPublication('read-grant', { key: '﻿folder/clé' });
  const owner = 'owner-read-grant';
  const metadata = new PrivateMetadata(env.DB);
  const { id: folder } = await metadata.createFolder(owner, null, 'shared');
  const name = 'résumé.pdf';
  await metadata.move(owner, id, folder, name);
  await sql("INSERT INTO drive_principals VALUES ('reader', 'member', 'active')").run();
  const reader = (await sessions.issue('reader')).token;
  const grants = new ReadGrants(env.DB);
  const primary = vi.fn((mode) => env.DB.withSession(mode));
  const { resolveGeneration, storageConfigId } = createPublishedReadAccess({ withSession: primary }, epoch, config);
  const reference = { name, key, etag, storageConfigId, evidenceRevision, sizeBytes: 7 };
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
  await sql("INSERT INTO drive_entries VALUES ('legacy', 'owner-read-fence', NULL, 'old', 'file', 'legacy-key', 7)").run();
  expect(await resolveGeneration(token, 'legacy')).toBeNull();
  await sql('UPDATE drive_entries SET size_bytes = 8 WHERE id = ?', id).run();
  expect(await resolveGeneration(token, id)).toBeNull();
  await sql('UPDATE drive_entries SET size_bytes = 7 WHERE id = ?', id).run();
  expect(await resolveGeneration(token, id)).not.toBeNull();
  await sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent).run();
  expect(await resolveGeneration(token, id)).toBeNull();
  const gone = await seedBoundPublication('read-gone');
  expect(await new PrivateDeletion(env.DB).delete(gone.token, gone.id)).toBe(true);
  expect(await resolveGeneration(gone.token, gone.id)).toBeNull();
});

it('fails closed on malformed evidence and primary read failure', async () => {
  const row = { keyHex: '6b', nameHex: '6e', etag, sizeBytes: 7, evidenceRevision: crypto.randomUUID() };
  const primary = (first) => ({ withSession: () => ({ prepare: () => ({ bind: () => ({ first }) }) }) });
  for (const bad of [{ keyHex: 'ff' }, { nameHex: 'ff' }, { etag: 'W/"weak"' }, { evidenceRevision: 'unknown' }, { sizeBytes: -1 }]) {
    const { resolveGeneration } = createPublishedReadAccess(primary(async () => ({ ...row, ...bad })), epoch, config);
    expect(await resolveGeneration('a'.repeat(43), 'id')).toBeNull();
  }
  const { resolveGeneration } = createPublishedReadAccess(primary(async () => { throw new Error('unavailable'); }), epoch, config);
  expect(await resolveGeneration('a'.repeat(43), 'id')).toBeNull();
});

it('composes with immutable full and range GETs without storage calls for denied or unbound reads', async () => {
  const { id, token } = await seedBoundPublication('read-stream');
  const { resolveGeneration, storageConfigId } = createPublishedReadAccess(env.DB, epoch, config);
  const fetch = vi.fn(async (request) => request.headers.has('range')
    ? new Response('bc', { status: 206, headers: { etag, 'content-range': 'bytes 1-2/7', 'content-length': '2' } })
    : new Response('abcdefg', { headers: { etag, 'content-length': '7' } }));
  const reader = createImmutableS3Reader(createS3Objects(config, { fetch, timeoutMs: 5000 }));
  const readerFor = vi.fn((generationConfig) => generationConfig === storageConfigId ? reader : null);
  const get = (headers = {}, auth = token, resolve = resolveGeneration) => downloadFile(new Request('https://drive.example/file', { headers }), id, {
    authorize: async () => auth, resolveGeneration: resolve, readerFor,
  });
  for (const response of [await get({}, 'a'.repeat(43)), await get({}, token,
    createPublishedReadAccess(env.DB, 'different-epoch', config).resolveGeneration)]) {
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBeNull();
  }
  expect(readerFor).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await (await get()).text()).toBe('abcdefg');
  const range = await get({ range: 'bytes=1-2' });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe('bc');
  expect(fetch.mock.calls.map(([request]) => [request.method, request.headers.get('if-match'), request.headers.get('range')]))
    .toEqual([['GET', etag, null], ['GET', etag, 'bytes=1-2']]);
  for (const upstream of [new Response(null, { status: 404 }), new Response(null, { status: 412 }),
    new Response('bc', { status: 206, headers: { etag, 'content-range': 'bytes 1-2/8', 'content-length': '2' } }),
    new Response('bc', { status: 206, headers: { etag: '"different"', 'content-range': 'bytes 1-2/7' } })]) {
    fetch.mockResolvedValueOnce(upstream);
    const denied = await get({ range: 'bytes=1-2' });
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe('');
  }
  expect(fetch).toHaveBeenCalledTimes(6);
});
