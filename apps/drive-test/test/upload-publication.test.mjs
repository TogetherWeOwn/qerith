import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

async function completed(owner) {
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create(owner);
  await intents.claim(owner, intent.id, 0, 'allocation');
  await intents.recordSuccess(owner, intent.id, 1, { kind: 'allocation', uploadId: 'provider-upload' });
  await intents.claim(owner, intent.id, 2, 'completion');
  await intents.recordSuccess(owner, intent.id, 3, { kind: 'completion' });
  return await intents.get(owner, intent.id);
}
const verified = async (intent) => ({ objectKey: intent.object_key, sizeBytes: 7, etag: '"verified"' });

it('publishes once and preserves the receipt across restart and entry removal', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('publish-owner', 'member', 'active')").run();
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('publish-owner', null, 'folder');
  const intent = await completed('publish-owner');
  const service = new UploadPublication(env.DB, verified);
  const results = await Promise.all([
    service.publish('publish-owner', intent.id, intent.version, folder.id, 'file'),
    service.publish('publish-owner', intent.id, intent.version, folder.id, 'file'),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const entry = results.find(Boolean);
  expect(await new UploadPublication(env.DB, verified).getReceipt('publish-owner', intent.id)).toEqual(entry);
  expect(await new UploadPublication(env.DB, verified).getReceipt('not-owner', intent.id)).toBeNull();
  expect(await metadata.get('publish-owner', entry.id)).toMatchObject({ name: 'file', kind: 'file' });
  expect(await metadata.usage('publish-owner')).toEqual({ bytes: '7' });
  expect((await metadata.list('publish-owner', null)).entries[0].item_count).toBe(1);
  expect(await env.DB.prepare('SELECT object_key, size_bytes FROM drive_entries WHERE id = ?').bind(entry.id).first())
    .toEqual({ object_key: intent.object_key, size_bytes: 7 });
  await env.DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(entry.id).run();
  expect(await new UploadPublication(env.DB, verified).publish('publish-owner', intent.id, intent.version, folder.id, 'file')).toBeNull();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?').bind(intent.id).first())
    .toEqual({ intent_id: intent.id });
});

it('rejects unverified, stale, cross-user and revoked publications without losing journal evidence', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('negative-owner', 'member', 'active'), ('other-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const pending = await intents.create('negative-owner');
  const service = new UploadPublication(env.DB, verified);
  expect(await service.publish('negative-owner', pending.id, pending.version, null, 'pending')).toBeNull();
  await intents.claim('negative-owner', pending.id, 0, 'allocation');
  await intents.recordUncertain('negative-owner', pending.id, 1, 'allocation');
  expect(await service.publish('negative-owner', pending.id, 2, null, 'uncertain')).toBeNull();
  const intent = await completed('negative-owner');
  const noProof = new UploadPublication(env.DB, async () => null);
  expect(await noProof.publish('negative-owner', intent.id, intent.version, null, 'file')).toBeNull();
  expect(await new UploadPublication(env.DB, async () => ({ objectKey: 'wrong', sizeBytes: 7, etag: 'x' }))
    .publish('negative-owner', intent.id, intent.version, null, 'file')).toBeNull();
  expect(await service.publish('other-owner', intent.id, intent.version, null, 'file')).toBeNull();
  expect(await service.publish('negative-owner', intent.id, intent.version - 1, null, 'file')).toBeNull();
  const changed = await completed('negative-owner');
  const changeDuringVerify = new UploadPublication(env.DB, async (row) => {
    await env.DB.prepare('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?').bind(row.id).run();
    return verified(row);
  });
  expect(await changeDuringVerify.publish('negative-owner', changed.id, changed.version, null, 'stale')).toBeNull();
  const failedVerify = new UploadPublication(env.DB, async () => { throw new Error('verification unavailable'); });
  await expect(failedVerify.publish('negative-owner', intent.id, intent.version, null, 'file')).rejects.toThrow();
  const revokeDuringVerify = new UploadPublication(env.DB, async (row) => {
    await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'negative-owner'").run();
    return verified(row);
  });
  expect(await revokeDuringVerify.publish('negative-owner', intent.id, intent.version, null, 'file')).toBeNull();
  expect(await env.DB.prepare('SELECT state, completion_acknowledged FROM drive_upload_intents WHERE id = ?').bind(intent.id).first())
    .toEqual({ state: 'acknowledged', completion_acknowledged: 1 });
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
});

it('rolls back publication on a name or parent conflict', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('conflict-owner', 'member', 'active')").run();
  const metadata = new PrivateMetadata(env.DB);
  await metadata.createFolder('conflict-owner', null, 'occupied');
  const intent = await completed('conflict-owner');
  const service = new UploadPublication(env.DB, verified);
  await expect(service.publish('conflict-owner', intent.id, intent.version, null, 'occupied')).rejects.toThrow();
  await expect(service.publish('conflict-owner', intent.id, intent.version, 'missing', 'file')).rejects.toThrow();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
  expect(await new UploadIntents(env.DB).get('conflict-owner', intent.id)).toMatchObject({ state: 'acknowledged' });
  expect(await service.publish('conflict-owner', intent.id, intent.version, null, 'available')).not.toBeNull();
});
