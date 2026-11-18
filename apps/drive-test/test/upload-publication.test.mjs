import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { createCompleteForPublication } from '../../drive/src/lib/server/s3/complete-for-publication.ts';

it('publishes size from conditional HEAD after the create-only provider completion', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('adapter-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.createSized('adapter-owner', 7);
  await intents.claim('adapter-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('adapter-owner', intent.id, 1, { kind: 'allocation', uploadId: 'upload' });
  const calls = [];
  const complete = createCompleteForPublication({ endpoint: 'https://storage.example', bucket: 'test-bucket',
    region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' }, { timeoutMs: 1000, fetch: async request => {
    calls.push(request);
    return request.method === 'POST'
      ? new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
      : new Response(null, { headers: { etag: '"complete"', 'content-length': '7' } });
  } });
  const service = new UploadPublication(env.DB, complete);
  expect(await service.completeAndPublish('adapter-owner', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).not.toBeNull();
  expect(calls.map(request => request.method)).toEqual(['POST', 'HEAD']);
  expect(calls[0].headers.get('if-none-match')).toBe('*');
  expect(calls[1].headers.get('if-match')).toBe('"complete"');
  expect(await env.DB.prepare('SELECT object_etag, size_bytes FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toEqual({ object_etag: '"complete"', size_bytes: 7 });
});

it('quarantines a completed upload when HEAD fails or returns a different ETag', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('head-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  for (const head of [
    () => new Response(null, { status: 412 }),
    () => new Response(null, { headers: { etag: '"other"', 'content-length': '7' } }),
  ]) {
    const intent = await intents.createSized('head-owner', 7);
    await intents.claim('head-owner', intent.id, 0, 'allocation');
    await intents.recordSuccess('head-owner', intent.id, 1, { kind: 'allocation', uploadId: 'upload' });
    const calls = [];
    const complete = createCompleteForPublication({ endpoint: 'https://storage.example', bucket: 'test-bucket',
      region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' }, { timeoutMs: 1000, fetch: async request => {
      calls.push(request.method);
      return request.method === 'POST'
        ? new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
        : head();
    } });
    const service = new UploadPublication(env.DB, complete);
    const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
    await expect(service.completeAndPublish('head-owner', intent.id, 2, null, 'file', parts)).rejects.toThrow();
    expect(calls).toEqual(['POST', 'HEAD']);
    expect(await intents.get('head-owner', intent.id)).toMatchObject({ state: 'uncertain' });
    expect(await service.getReceipt('head-owner', intent.id)).toBeNull();
    expect(await service.completeAndPublish('head-owner', intent.id, 2, null, 'file', parts)).toBeNull();
    expect(calls).toEqual(['POST', 'HEAD']);
  }
});

it('publishes a nested file once when completion requests race', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('publish-owner', 'member', 'active')").run();
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('publish-owner', null, 'folder');
  const intents = new UploadIntents(env.DB);
  const intent = await intents.createSized('publish-owner', 7);
  await intents.claim('publish-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('publish-owner', intent.id, 1, { kind: 'allocation', uploadId: 'provider-upload' });
  let calls = 0;
  const service = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  const results = await Promise.all([
    service.completeAndPublish('publish-owner', intent.id, 2, folder.id, 'file', parts),
    service.completeAndPublish('publish-owner', intent.id, 2, folder.id, 'file', parts),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(calls).toBe(1);
  const entry = results.find(Boolean);
  expect(await metadata.get('publish-owner', entry.id)).toMatchObject({ name: 'file', kind: 'file' });
  expect((await metadata.list('publish-owner', null)).entries[0].item_count).toBe(1);
  expect(await env.DB.prepare('SELECT object_key, size_bytes FROM drive_entries WHERE id = ?').bind(entry.id).first())
    .toEqual({ object_key: intent.object_key, size_bytes: 7 });
});

it('refuses a provider size that differs from the immutable declaration', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('size-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.createSized('size-owner', 8);
  await expect(env.DB.prepare('UPDATE drive_upload_intents SET declared_size = 7 WHERE id = ?')
    .bind(intent.id).run()).rejects.toThrow();
  await intents.claim('size-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('size-owner', intent.id, 1, { kind: 'allocation', uploadId: 'upload' });
  const service = new UploadPublication(env.DB, async () => ({ etag: '"complete"', size: 7 }));
  await expect(service.completeAndPublish('size-owner', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).rejects.toThrow('Invalid completion size');
  expect(await service.getReceipt('size-owner', intent.id)).toBeNull();
  expect(await intents.get('size-owner', intent.id)).toMatchObject({ state: 'uncertain' });
});

it('does not dispatch completion for pending or uncertain intents', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('negative-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('negative-owner');
  let calls = 0;
  const service = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  expect(await service.completeAndPublish('negative-owner', intent.id, 0, null, 'pending', parts)).toBeNull();
  await intents.claim('negative-owner', intent.id, 0, 'allocation');
  await intents.recordUncertain('negative-owner', intent.id, 1, 'allocation');
  expect(await service.completeAndPublish('negative-owner', intent.id, 2, null, 'uncertain', parts)).toBeNull();
  expect(calls).toBe(0);
  expect(await service.getReceipt('negative-owner', intent.id)).toBeNull();
});
