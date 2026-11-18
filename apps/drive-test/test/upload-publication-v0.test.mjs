import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { producer, response, seed, sql } from './fixtures/upload-completion.mjs';

const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];

async function setup(owner) {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES (?, 'member', 'active')").bind(owner).run();
  return new UploadIntents(env.DB);
}

async function allocate(intents, owner) {
  const intent = await intents.createSized(owner, 7);
  await intents.claim(owner, intent.id, 0, 'allocation');
  await intents.recordSuccess(owner, intent.id, 1, { kind: 'allocation', uploadId: 'upload-id' });
  return intent;
}

it('publishes the same-request completion and fences later cleanup', async () => {
  const intents = await setup('v0-success');
  const intent = await allocate(intents, 'v0-success');
  const publication = new UploadPublication(env.DB, async (key, uploadId, parts) => {
    expect([key, uploadId, parts[0].size]).toEqual([intent.object_key, 'upload-id', 7]);
    return { etag: '"complete"', size: 7 };
  });
  const entry = await publication.completeAndPublish('v0-success', intent.id, 2, null, '文件', parts);
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
  const intents = await setup('v0-fenced');
  const intent = await allocate(intents, 'v0-fenced');
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 1, null, 'file', parts)).toBeNull();
  expect(await publication.completeAndPublish('wrong-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'v0-fenced'").run();
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'v0-fenced'").run();
  await env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)').bind(intent.id).run();
  expect(await intents.claim('v0-fenced', intent.id, 2, 'completion')).toBeNull();
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(calls).toBe(0);
});

it('honors the existing publication tombstone before and during completion', async () => {
  const intents = await setup('v0-tombstone');
  const before = await allocate(intents, 'v0-tombstone');
  await env.DB.prepare('INSERT INTO drive_upload_publication_tombstones VALUES (?)').bind(before.id).run();
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  expect(await intents.claim('v0-tombstone', before.id, 2, 'completion')).toBeNull();
  expect(await publication.completeAndPublish('v0-tombstone', before.id, 2, null, 'before', parts)).toBeNull();
  expect(calls).toBe(0);
  const during = await allocate(intents, 'v0-tombstone');
  const racing = new UploadPublication(env.DB, async () => {
    await env.DB.prepare('INSERT INTO drive_upload_publication_tombstones VALUES (?)').bind(during.id).run();
    return { etag: '"complete"', size: 7 };
  });
  expect(await racing.completeAndPublish('v0-tombstone', during.id, 2, null, 'during', parts)).toBeNull();
  expect(await racing.getReceipt('v0-tombstone', during.id)).toBeNull();
});

it('does not redispatch a legacy completion after a mistaken journal reset', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const { token, key, intent } = await seed('v0-legacy-reset', { declaredSize: 7 });
  expect(await producer(async () => response(key)).complete(token, 'v0-legacy-reset')).toBe('recorded');
  const intents = new UploadIntents(env.DB);
  expect(await intents.recordNotDispatched('owner-v0-legacy-reset', intent, 3, 'completion')).toBe(true);
  expect(await intents.claim('owner-v0-legacy-reset', intent, 4, 'completion')).toBeNull();
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => { calls++; return { etag: '"complete"', size: 7 }; });
  expect(await publication.completeAndPublish('owner-v0-legacy-reset', intent, 4, null, 'file', parts)).toBeNull();
  expect(calls).toBe(0);
  expect(await sql('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?', intent).first()).toBeNull();
});

it('excludes cleanup and a second completion while the provider call is in flight', async () => {
  const intents = await setup('v0-inflight');
  const intent = await allocate(intents, 'v0-inflight');
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => {
    calls++;
    await expect(env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)')
      .bind(intent.id).run()).rejects.toThrow();
    expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'other', parts)).toBeNull();
    return { etag: '"complete"', size: 7 };
  });
  expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'file', parts)).not.toBeNull();
  expect(await publication.completeAndPublish('v0-inflight', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toEqual({ count: 1 });
});

it('does not reopen an in-flight provider attempt after a mistaken journal reset', async () => {
  const intents = await setup('v0-reset-inflight');
  const intent = await allocate(intents, 'v0-reset-inflight');
  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => {
    calls++;
    expect(await intents.recordNotDispatched('v0-reset-inflight', intent.id, 3, 'completion')).toBe(true);
    expect(await intents.claim('v0-reset-inflight', intent.id, 4, 'completion')).toBeNull();
    await expect(env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)')
      .bind(intent.id).run()).rejects.toThrow();
    expect(await publication.completeAndPublish('v0-reset-inflight', intent.id, 4, null, 'retry', parts)).toBeNull();
    return { etag: '"complete"', size: 7 };
  });
  await publication.completeAndPublish('v0-reset-inflight', intent.id, 2, null, 'file', parts);
  expect(calls).toBe(1);
});

it('rechecks membership after completion and never replaces a conflicting name', async () => {
  const intents = await setup('v0-conflict');
  const revoked = await allocate(intents, 'v0-conflict');
  const publication = new UploadPublication(env.DB, async () => {
    await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'v0-conflict'").run();
    return { etag: '"complete"', size: 7 };
  });
  expect(await publication.completeAndPublish('v0-conflict', revoked.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'v0-conflict'").run();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(revoked.id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(revoked.object_key).first()).toBeNull();
  const conflict = await allocate(intents, 'v0-conflict');
  const next = new UploadPublication(env.DB, async () => {
    await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('existing', 'v0-conflict', 'file', 'folder')").run();
    return { etag: '"complete"', size: 7 };
  });
  await expect(next.completeAndPublish('v0-conflict', conflict.id, 2, null, 'file', parts)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id, kind FROM drive_entries WHERE id = 'existing'").first())
    .toEqual({ id: 'existing', kind: 'folder' });
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(conflict.id).first()).toBeNull();
});

it('does not publish when the intent version changes during completion', async () => {
  const intents = await setup('v0-version');
  const intent = await allocate(intents, 'v0-version');
  const publication = new UploadPublication(env.DB, async () => {
    await env.DB.prepare('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?')
      .bind(intent.id).run();
    return { etag: '"complete"', size: 7 };
  });
  expect(await publication.completeAndPublish('v0-version', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(await publication.getReceipt('v0-version', intent.id)).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(intent.object_key).first()).toBeNull();
});

it('quarantines invalid completion ETags and missing or mismatched sizes', async () => {
  const intents = await setup('v0-invalid-result');
  for (const [result, error] of [
    [{ etag: 'invalid', size: 7 }, 'Invalid completion ETag'],
    [{ etag: '"complete"' }, 'Invalid completion size'],
    [{ etag: '"complete"', size: 8 }, 'Invalid completion size'],
  ]) {
    const intent = await allocate(intents, 'v0-invalid-result');
    const publication = new UploadPublication(env.DB, async () => result);
    await expect(publication.completeAndPublish('v0-invalid-result', intent.id, 2, null, 'file', [
      { partNumber: 1, etag: '"part"', size: 7 },
    ])).rejects.toThrow(error);
    expect(await publication.getReceipt('v0-invalid-result', intent.id)).toBeNull();
    expect(await intents.get('v0-invalid-result', intent.id)).toMatchObject({ state: 'uncertain' });
  }
});

it('does not publish an upload when the same-request completion response is lost', async () => {
  const intents = await setup('v0-owner');
  const intent = await allocate(intents, 'v0-owner');

  let calls = 0;
  const publication = new UploadPublication(env.DB, async () => {
    calls++;
    throw new Error('completion response lost');
  });
  await expect(publication.completeAndPublish('v0-owner', intent.id, 2, null, 'file', parts)).rejects.toThrow('completion response lost');
  expect(calls).toBe(1);
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?')
    .bind(intent.id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?')
    .bind(intent.object_key).first()).toBeNull();
  expect(await intents.get('v0-owner', intent.id)).toMatchObject({ state: 'uncertain' });
  expect(await publication.completeAndPublish('v0-owner', intent.id, 4, null, 'file', parts)).toBeNull();
  expect(calls).toBe(1);
  const retry = await intents.createSized('v0-owner', 7);
  expect(retry.object_key).not.toBe(intent.object_key);
});
