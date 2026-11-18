import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication as Publication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';

let sessionToken;
class UploadPublication extends Publication {
  constructor(db, complete) { super(db, complete, sessionToken); }
}
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { createCompleteForPublication } from '../../drive/src/lib/server/s3/complete-for-publication.ts';

async function setup(owner) {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')").bind(owner).run();
  sessionToken = (await new Sessions(env.DB).issue(owner)).token;
  return new UploadIntents(env.DB);
}

async function allocate(intents, owner) {
  const intent = await intents.createSized(owner, 7);
  await intents.claim(owner, intent.id, 0, 'allocation');
  await intents.recordSuccess(owner, intent.id, 1, { kind: 'allocation', uploadId: 'upload' });
  return intent;
}

function completeWithHead(calls, head) {
  return createCompleteForPublication({ endpoint: 'https://storage.example', bucket: 'test-bucket',
    region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' }, { timeoutMs: 1000, fetch: async request => {
    calls.push(request);
    return request.method === 'POST'
      ? new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
      : head();
  } });
}

it('publishes size from conditional HEAD after the create-only provider completion', async () => {
  const intents = await setup('adapter-owner');
  const intent = await allocate(intents, 'adapter-owner');
  const calls = [];
  const complete = completeWithHead(calls, () => new Response(null, {
    headers: { etag: '"complete"', 'content-length': '7' },
  }));
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

it('quarantines a completed upload when HEAD fails or returns mismatched metadata', async () => {
  const intents = await setup('head-owner');
  for (const head of [
    () => new Response(null, { status: 412 }),
    () => new Response(null, { headers: { etag: '"other"', 'content-length': '7' } }),
    () => new Response(null, { headers: { etag: '"complete"', 'content-length': '8' } }),
  ]) {
    const intent = await allocate(intents, 'head-owner');
    const calls = [];
    const complete = completeWithHead(calls, head);
    const service = new UploadPublication(env.DB, complete);
    const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
    await expect(service.completeAndPublish('head-owner', intent.id, 2, null, 'file', parts)).rejects.toThrow();
    expect(calls.map(request => request.method)).toEqual(['POST', 'HEAD']);
    expect(await intents.get('head-owner', intent.id)).toMatchObject({ state: 'uncertain' });
    expect(await service.getReceipt('head-owner', intent.id)).toBeNull();
    expect(await service.completeAndPublish('head-owner', intent.id, 2, null, 'file', parts)).toBeNull();
    expect(calls.map(request => request.method)).toEqual(['POST', 'HEAD']);
  }
});

it('publishes a nested file once when completion requests race', async () => {
  const intents = await setup('publish-owner');
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('publish-owner', null, 'folder');
  const intent = await allocate(intents, 'publish-owner');
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
  const intents = await setup('size-owner');
  const intent = await intents.createSized('size-owner', 8);
  await expect(env.DB.prepare('UPDATE drive_upload_intents SET declared_size = 7 WHERE id = ?')
    .bind(intent.id).run()).rejects.toThrow();
  await intents.claim('size-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('size-owner', intent.id, 1, { kind: 'allocation', uploadId: 'upload' });
  let calls = 0;
  const service = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  expect(await service.completeAndPublish('size-owner', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).toBeNull();
  expect(calls).toBe(0);
  expect(await service.getReceipt('size-owner', intent.id)).toBeNull();
  expect(await intents.get('size-owner', intent.id)).toMatchObject({ state: 'allocated', version: 2 });
});
