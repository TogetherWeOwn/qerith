import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('publishes a nested file once when completion requests race', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('publish-owner', 'member', 'active')").run();
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('publish-owner', null, 'folder');
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('publish-owner');
  await intents.claim('publish-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('publish-owner', intent.id, 1, { kind: 'allocation', uploadId: 'provider-upload' });
  let calls = 0;
  const service = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"' }; });
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

it('does not dispatch completion for pending or uncertain intents', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('negative-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('negative-owner');
  let calls = 0;
  const service = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"' }; });
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  expect(await service.completeAndPublish('negative-owner', intent.id, 0, null, 'pending', parts)).toBeNull();
  await intents.claim('negative-owner', intent.id, 0, 'allocation');
  await intents.recordUncertain('negative-owner', intent.id, 1, 'allocation');
  expect(await service.completeAndPublish('negative-owner', intent.id, 2, null, 'uncertain', parts)).toBeNull();
  expect(calls).toBe(0);
  expect(await service.getReceipt('negative-owner', intent.id)).toBeNull();
});
