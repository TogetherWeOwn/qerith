import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('publishes the same-request completion and fences later cleanup', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-success', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-success');
  await intents.claim('v0-success', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-success', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  const publication = new UploadPublication(env.DB, async (key, uploadId, parts) => {
    expect([key, uploadId, parts[0].size]).toEqual([intent.object_key, 'upload-id', 7]);
    return { etag: '"complete"' };
  });
  const entry = await publication.completeAndPublish('v0-success', intent.id, 2, null, '文件', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ]);
  expect(entry).not.toBeNull();
  expect(await publication.getReceipt('v0-success', intent.id)).toEqual(entry);
  expect(await publication.getReceipt('wrong-owner', intent.id)).toBeNull();
  expect(await env.DB.prepare('SELECT object_etag, size_bytes FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toEqual({ object_etag: '"complete"', size_bytes: 7 });
  expect(await intents.get('v0-success', intent.id)).toMatchObject({ state: 'acknowledged', version: 4 });
  const metadata = new PrivateMetadata(env.DB);
  expect(await metadata.get('v0-success', entry.id)).toMatchObject({ name: '文件', kind: 'file' });
  expect(await metadata.usage('v0-success')).toEqual({ bytes: '7' });
  await expect(env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)').bind(intent.id).run()).rejects.toThrow();
  await env.DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(entry.id).run();
  expect(await new UploadPublication(env.DB, async () => { throw new Error('unexpected completion'); })
    .getReceipt('v0-success', intent.id)).toEqual(entry);
});

it('does not complete an upload with a stale version, wrong owner, or cleanup claim', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-fenced', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-fenced');
  await intents.claim('v0-fenced', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-fenced', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"' }; });
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 1, null, 'file', parts)).toBeNull();
  expect(await publication.completeAndPublish('wrong-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)').bind(intent.id).run();
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(calls).toBe(0);
});

it('excludes cleanup and a second completion while the provider call is in flight', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-inflight', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-inflight');
  await intents.claim('v0-inflight', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-inflight', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => {
    calls++;
    await expect(env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)')
      .bind(intent.id).run()).rejects.toThrow();
    expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'other', parts)).toBeNull();
    return { etag: '"complete"' };
  });
  expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'file', parts)).not.toBeNull();
  expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toEqual({ count: 1 });
});

it('rechecks membership after completion and never replaces a conflicting name', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-conflict', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  async function allocated() {
    const intent = await intents.create('v0-conflict');
    await intents.claim('v0-conflict', intent.id, 0, 'allocation');
    await intents.recordSuccess('v0-conflict', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
    return intent;
  }
  const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
  const revoked = await allocated();
  const publication = new UploadPublication(env.DB, async () => {
    await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'v0-conflict'").run();
    return { etag: '"complete"' };
  });
  expect(await publication.completeAndPublish('v0-conflict', revoked.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'v0-conflict'").run();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(revoked.id).first()).toBeNull();
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('existing', 'v0-conflict', 'file', 'folder')").run();
  const conflict = await allocated();
  const next = new UploadPublication(env.DB, async () => ({ etag: '"complete"' }));
  await expect(next.completeAndPublish('v0-conflict', conflict.id, 2, null, 'file', parts)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id, kind FROM drive_entries WHERE id = 'existing'").first())
    .toEqual({ id: 'existing', kind: 'folder' });
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(conflict.id).first()).toBeNull();
});

it('rolls back the receipt and journal update for an invalid parent', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-parent', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-parent');
  await intents.claim('v0-parent', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-parent', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  const publication = new UploadPublication(env.DB, async () => ({ etag: '"complete"' }));
  await expect(publication.completeAndPublish('v0-parent', intent.id, 2, 'missing', 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).rejects.toThrow();
  expect(await publication.getReceipt('v0-parent', intent.id)).toBeNull();
  expect(await intents.get('v0-parent', intent.id)).toMatchObject({ state: 'completing', version: 3 });
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(intent.object_key).first()).toBeNull();
});

it('does not publish when the intent version changes during completion', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-version', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-version');
  await intents.claim('v0-version', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-version', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  const publication = new UploadPublication(env.DB, async () => {
    await env.DB.prepare('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?')
      .bind(intent.id).run();
    return { etag: '"complete"' };
  });
  expect(await publication.completeAndPublish('v0-version', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).toBeNull();
  expect(await publication.getReceipt('v0-version', intent.id)).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(intent.object_key).first()).toBeNull();
});

it('quarantines an invalid completion response instead of publishing', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-invalid-etag', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-invalid-etag');
  await intents.claim('v0-invalid-etag', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-invalid-etag', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  const publication = new UploadPublication(env.DB, async () => ({ etag: 'invalid' }));
  await expect(publication.completeAndPublish('v0-invalid-etag', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).rejects.toThrow('Invalid completion ETag');
  expect(await publication.getReceipt('v0-invalid-etag', intent.id)).toBeNull();
  expect(await intents.get('v0-invalid-etag', intent.id)).toMatchObject({ state: 'uncertain' });
});

it('does not publish an upload when the same-request completion response is lost', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('v0-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('v0-owner');
  await intents.claim('v0-owner', intent.id, 0, 'allocation');
  await intents.recordSuccess('v0-owner', intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });

  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => {
    calls++;
    throw new Error('completion response lost');
  });
  await expect(publication.completeAndPublish('v0-owner', intent.id, 2, null, 'file', [
    { partNumber: 1, etag: '"part"', size: 7 },
  ])).rejects.toThrow('completion response lost');
  expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(intent.object_key).first()).toBeNull();
  expect(await intents.get('v0-owner', intent.id)).toMatchObject({ state: 'uncertain' });
});
