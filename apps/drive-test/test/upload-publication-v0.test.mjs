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

const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];

async function setup(owner) {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES (?, 'member', 'active')").bind(owner).run();
  sessionToken = (await new Sessions(env.DB).issue(owner)).token;
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
  const pending = await intents.createSized('v0-fenced', 7);
  expect(await publication.completeAndPublish('v0-fenced', pending.id, 0, null, 'pending', parts)).toBeNull();
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 1, null, 'file', parts)).toBeNull();
  expect(await publication.completeAndPublish('wrong-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'v0-fenced'").run();
  expect(await publication.completeAndPublish('v0-fenced', intent.id, 2, null, 'file', parts)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'v0-fenced'").run();
  sessionToken = (await new Sessions(env.DB).issue('v0-fenced')).token;
  await env.DB.prepare('INSERT INTO drive_upload_cleanup_claims VALUES (?)').bind(intent.id).run();
  expect(await intents.claim('v0-fenced', intent.id, 2, 'completion')).toBeNull();
  expect(await new UploadPublication(env.DB, async () => { calls++; }).completeAndPublish('v0-fenced', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publication_attempts WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
  expect(calls).toBe(0);
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
  sessionToken = (await new Sessions(env.DB).issue('v0-conflict')).token;
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

it('requires the initiating live session before dispatch and for receipt access', async () => {
  const intents = await setup('session-owner');
  const sessions = new Sessions(env.DB);
  const intent = await allocate(intents, 'session-owner');
  let calls = 0;
  const complete = async () => { calls++; return { etag: '"complete"', size: 7 }; };
  const missing = new Publication(env.DB, complete, '');
  const original = new Publication(env.DB, complete, sessionToken);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('session-other', 'member', 'active')").run();
  const foreign = new Publication(env.DB, complete, (await sessions.issue('session-other')).token);
  expect(await missing.completeAndPublish('session-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(await foreign.completeAndPublish('session-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(await foreign.completeAndPublish('session-other', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publication_attempts WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
  await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = ?').bind('session-owner').run();
  expect(await original.completeAndPublish('session-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  expect(calls).toBe(0);
  const replacement = (await sessions.issue('session-owner')).token;
  expect(await original.completeAndPublish('session-owner', intent.id, 2, null, 'file', parts)).toBeNull();
  const current = new Publication(env.DB, complete, replacement);
  const entry = await current.completeAndPublish('session-owner', intent.id, 2, null, 'file', parts);
  expect(entry).not.toBeNull();
  expect(await original.getReceipt('session-owner', intent.id)).toBeNull();
  expect(await missing.getReceipt('session-owner', intent.id)).toBeNull();
  expect(await current.getReceipt('session-owner', intent.id)).toEqual(entry);
  await sessions.revoke(replacement);
  expect(await current.getReceipt('session-owner', intent.id)).toBeNull();
});

it('does not publish when the initiating session is lost during provider I/O', async () => {
  const intents = await setup('session-race');
  const sessions = new Sessions(env.DB);
  for (const loss of ['revoked', 'expired', 'replaced', 'membership-reenabled']) {
    const token = (await sessions.issue('session-race')).token;
    const intent = await allocate(intents, 'session-race');
    const publication = new Publication(env.DB, async () => {
      if (loss === 'expired') {
        await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = ?').bind('session-race').run();
      } else if (loss === 'membership-reenabled') {
        await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'session-race'").run();
        await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'session-race'").run();
      } else {
        await sessions.revoke(token);
        if (loss === 'replaced') await sessions.issue('session-race');
      }
      return { etag: '"complete"', size: 7 };
    }, token);
    expect(await publication.completeAndPublish('session-race', intent.id, 2, null, loss, parts)).toBeNull();
    expect(await env.DB.prepare('SELECT intent_id FROM drive_upload_publications WHERE intent_id = ?').bind(intent.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM drive_entries WHERE object_key = ?').bind(intent.object_key).first()).toBeNull();
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
