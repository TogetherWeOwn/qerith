import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { ReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';

const sql = (text, ...args) => env.DB.prepare(text).bind(...args);
const sessions = () => new Sessions(env.DB);
const entry = (id, owner, parent = null, key = null) => sql('INSERT INTO drive_entries VALUES (?, ?, ?, ?, ?, ?, ?)',
  id, owner, parent, id, key ? 'file' : 'folder', key, key ? 7 : null).run();
const evidence = (owner) => sql('SELECT entry_id, object_key FROM drive_deleted_entries WHERE owner_id = ? ORDER BY entry_id', owner).all();

async function member(id, role = 'member') {
  await sql("INSERT INTO drive_principals VALUES (?, ?, 'active')", id, role).run();
  return (await sessions().issue(id)).token;
}

it('requires a live session belonging to the entry owner, not a recipient or administrator', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const owner = 'delete-owner';
  const token = await member(owner);
  const recipient = await member('delete-recipient');
  const admin = await member('delete-admin', 'owner');
  await entry('private-file', owner, null, 'private-key');
  const grants = new ReadGrants(env.DB);
  const deleteEntry = new PrivateDeletion(env.DB);
  const read = new ReadAccess(env.DB);
  expect(await grants.create(token, 'private-file', 'delete-recipient')).toBe(true);
  expect(await read.resolveObject(recipient, 'private-file')).toMatchObject({ sizeBytes: 7 });
  for (const invalid of [recipient, admin, '', 'a'.repeat(43)]) {
    expect(await deleteEntry.delete(invalid, 'private-file')).toBe(false);
    expect(await deleteEntry.delete(invalid, 'missing')).toBe(false);
  }
  await sql('UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = ?', owner).run();
  expect(await deleteEntry.delete(token, 'private-file')).toBe(false);
  const current = (await sessions().issue(owner)).token;
  await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner).run();
  expect(await deleteEntry.delete(current, 'private-file')).toBe(false);
  expect((await evidence(owner)).results).toEqual([]);
  await sql("UPDATE drive_principals SET status = 'active' WHERE id = ?", owner).run();
  const restored = (await sessions().issue(owner)).token;
  expect(await read.get(restored, 'private-file')).not.toBeNull();
  expect(await deleteEntry.delete(restored, 'private-file')).toBe(true);
  expect(await read.resolveObject(restored, 'private-file')).toBeNull();
});

it('atomically deletes a recursive tree, denies shared reads and retains non-reusable evidence', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const owner = 'tree-owner';
  const token = await member(owner);
  const recipient = await member('tree-recipient');
  await entry('tree-parent', owner);
  await entry('tree-a', owner, 'tree-parent');
  await entry('tree-b', owner, 'tree-a');
  await entry('tree-c', owner, 'tree-b');
  await entry('tree-file', owner, 'tree-c', 'tree-key');
  await entry('tree-survivor', owner, 'tree-a', 'survivor-key');
  const metadata = new PrivateMetadata(env.DB);
  const grants = new ReadGrants(env.DB);
  const read = new ReadAccess(env.DB);
  await metadata.move(owner, 'tree-survivor', 'tree-parent', 'moved');
  expect(await grants.create(token, 'tree-b', 'tree-recipient')).toBe(true);
  expect(await read.resolveObject(recipient, 'tree-file')).not.toBeNull();
  const outcomes = await Promise.all([1, 2].map(() => new PrivateDeletion(env.DB).delete(token, 'tree-a')));
  expect(outcomes.sort()).toEqual([false, true]);
  expect(await read.list(recipient, 'tree-b')).toBeNull();
  expect(await read.resolveObject(recipient, 'tree-file')).toBeNull();
  expect(await grants.create(token, 'tree-b', 'tree-recipient')).toBe(false);
  expect(await metadata.list(owner, 'tree-parent')).toMatchObject({ entries: [{ id: 'tree-survivor' }] });
  expect(await metadata.list(owner, null)).toMatchObject({ entries: [{ id: 'tree-parent', item_count: 1 }] });
  expect(await metadata.usage(owner)).toEqual({ bytes: '7' });
  await expect(metadata.move(owner, 'tree-survivor', 'tree-b', 'moved')).rejects.toThrow(/invalid parent/);
  await expect(entry('tree-b', owner)).rejects.toThrow(/deleted entry identity/);
  await expect(entry('tree-new', owner, null, 'tree-key')).rejects.toThrow(/deleted entry identity/);
  await expect(sql('DELETE FROM drive_deleted_entries WHERE entry_id = ?', 'tree-file').run()).rejects.toThrow(/permanent/);
  expect((await evidence(owner)).results).toEqual(['tree-a', 'tree-b', 'tree-c', 'tree-file'].map(entry_id =>
    ({ entry_id, object_key: entry_id === 'tree-file' ? 'tree-key' : null })));
});

it('rolls back the deletion ledger when removal fails', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const owner = 'rollback-owner';
  const token = await member(owner);
  await entry('rollback-file', owner, null, 'rollback-key');
  await sql('DELETE FROM drive_owner_usage WHERE owner_id = ?', owner).run();
  await expect(new PrivateDeletion(env.DB).delete(token, 'rollback-file')).rejects.toThrow(/missing owner usage/);
  expect((await evidence(owner)).results).toEqual([]);
  expect(await new ReadAccess(env.DB).get(token, 'rollback-file')).not.toBeNull();
});

it('fences an in-flight upload whose destination is deleted without creating cleanup authority', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const owner = 'race-owner';
  const token = await member(owner);
  await entry('race-folder', owner);
  const intents = new UploadIntents(env.DB);
  const intent = await intents.createSized(owner, 7);
  await intents.claim(owner, intent.id, 0, 'allocation');
  await intents.recordSuccess(owner, intent.id, 1, { kind: 'allocation', uploadId: 'race-upload' });
  const publication = new UploadPublication(env.DB, async () => {
    expect(await new PrivateDeletion(env.DB).delete(token, 'race-folder')).toBe(true);
    return { etag: '"completed"', size: 7 };
  }, token);
  await expect(publication.completeAndPublish(owner, intent.id, 2, 'race-folder', 'late-file',
    [{ partNumber: 1, etag: '"part"', size: 7 }])).rejects.toThrow(/invalid parent/);
  expect(await publication.getReceipt(owner, intent.id)).toBeNull();
  expect(await intents.get(owner, intent.id)).toMatchObject({ object_key: intent.object_key, state: 'completing' });
  expect((await evidence(owner)).results).toEqual([{ entry_id: 'race-folder', object_key: null }]);
  const ready = await intents.createSized(owner, 7);
  await intents.claim(owner, ready.id, 0, 'allocation');
  await intents.recordSuccess(owner, ready.id, 1, { kind: 'allocation', uploadId: 'ready-upload' });
  const completed = new UploadPublication(env.DB, async () => ({ etag: '"completed"', size: 7 }), token);
  const published = await completed.completeAndPublish(owner, ready.id, 2, null, 'ready-file',
    [{ partNumber: 1, etag: '"part"', size: 7 }]);
  expect(await new PrivateDeletion(env.DB).delete(token, published.id)).toBe(true);
  expect(await completed.getReceipt(owner, ready.id)).toEqual(published);
  expect((await evidence(owner)).results).toContainEqual({ entry_id: published.id, object_key: ready.object_key });
  await expect(sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', ready.id).run()).rejects.toThrow(/published/);
});
