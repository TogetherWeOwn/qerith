import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { intentRow, migrations, sql } from './fixtures/upload-completion.mjs';

const intents = new UploadIntents(env.DB);
const receipt = (id) => sql('SELECT * FROM drive_upload_publications WHERE intent_id = ?', id).first();
const entry = (key) => sql('SELECT * FROM drive_entries WHERE object_key = ?', key).first();
const usage = (owner) => sql('SELECT high, low FROM drive_owner_usage WHERE owner_id = ?', owner).first();
const cleanup = (id) => sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', id).run();
const folder = (id, owner, name = 'folder') => sql('INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, \'folder\')',
  id, owner, name).run();

beforeEach(() => applyD1Migrations(env.DB, migrations));

async function allocated(owner) {
  await sql("INSERT INTO drive_principals VALUES (?, 'member', 'active')", owner).run();
  const intent = await intents.createSized(owner, 7);
  await intents.claim(owner, intent.id, 0, 'allocation');
  expect(await intents.recordSuccess(owner, intent.id, 1, { kind: 'allocation', uploadId: 'upload' })).toBe(true);
  return intent;
}

async function completing(owner) {
  const intent = await allocated(owner);
  await sql(`INSERT INTO drive_upload_publication_attempts (intent_id, object_key, upload_id, version, declared_size)
    SELECT id, object_key, upload_id, version, declared_size FROM drive_upload_intents WHERE id = ?`, intent.id).run();
  expect(await intentRow(intent.id)).toMatchObject({ state: 'completing', version: 3 });
  return intent;
}

function publish(intent, overrides = {}, conflict = '') {
  const values = { version: 3, entry: `entry-${intent.owner_id}`, key: intent.object_key,
    owner: intent.owner_id, parent: null, name: 'file', size: 7, ...overrides };
  return sql(`INSERT ${conflict} INTO drive_upload_publications
    (intent_id, intent_version, entry_id, owner_id, object_key, parent_id, name, size_bytes, object_etag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, intent.id, values.version, values.entry,
    values.owner, values.key, values.parent, values.name, values.size, '"complete"').run();
}

async function expectUnpublished(intent, journal) {
  expect(await receipt(intent.id)).toBeNull();
  expect(await entry(intent.object_key)).toBeNull();
  expect(await usage(intent.owner_id)).toBeNull();
  expect(await intentRow(intent.id)).toMatchObject({ completion_acknowledged: 0, ...journal });
}

it('commits the file, receipt, accounting and journal transition together', async () => {
  const owner = 'transaction-success';
  const intent = await completing(owner);
  await folder('success-folder', owner);
  await publish(intent, { parent: 'success-folder', name: '文件' });
  expect(await receipt(intent.id)).toMatchObject({ object_etag: '"complete"', size_bytes: 7, intent_version: 3 });
  expect(await entry(intent.object_key)).toMatchObject({ id: `entry-${owner}`, owner_id: owner, kind: 'file',
    name: '文件', parent_id: 'success-folder', size_bytes: 7 });
  expect(await sql('SELECT item_count FROM drive_folder_counts WHERE folder_id = ?', 'success-folder').first())
    .toEqual({ item_count: 1 });
  expect(await usage(owner)).toEqual({ high: 0, low: 7 });
  expect(await intentRow(intent.id)).toMatchObject({ state: 'acknowledged', version: 4, completion_acknowledged: 1 });
  await expect(cleanup(intent.id)).rejects.toThrow();

  await sql('DELETE FROM drive_entries WHERE id = ?', `entry-${owner}`).run();
  await expect(sql('UPDATE drive_upload_publications SET size_bytes = 8 WHERE intent_id = ?', intent.id).run())
    .rejects.toThrow('upload publications are immutable');
  await expect(sql('DELETE FROM drive_upload_publications WHERE intent_id = ?', intent.id).run())
    .rejects.toThrow('upload publications are permanent');
  const next = await completing('transaction-replacement');
  await expect(publish(next, { entry: `entry-${owner}` }, 'OR REPLACE')).rejects.toThrow('duplicate upload publication');
  await expectUnpublished(next, { state: 'completing', version: 3 });
  await sql('DELETE FROM drive_upload_intents WHERE id = ?', intent.id).run();
  expect(await intentRow(intent.id)).toBeNull();
  expect(await receipt(intent.id)).toMatchObject({ entry_id: `entry-${owner}`, size_bytes: 7 });
  await expect(cleanup(intent.id)).rejects.toThrow();
});

it.each(['revoked', 'owner', 'version', 'state', 'size', 'key', 'tombstone'])(
  'rolls back a publication fenced by %s', async (veto) => {
    const owner = `transaction-${veto}`;
    const intent = await completing(owner);
    const overrides = {};
    let journal = { state: 'completing', version: 3 };
    if (veto === 'revoked') await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner).run();
    if (veto === 'owner') overrides.owner = (await allocated('transaction-other-owner')).owner_id;
    if (veto === 'version') overrides.version = 2;
    if (veto === 'state') {
      expect(await intents.recordNotDispatched(owner, intent.id, 3, 'completion')).toBe(true);
      journal = { state: 'allocated', version: 4 };
      overrides.version = 4;
    }
    if (veto === 'size') overrides.size = 8;
    if (veto === 'key') overrides.key = 'another-key';
    if (veto === 'tombstone') await sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent.id).run();
    await expect(publish(intent, overrides)).rejects.toThrow('upload publication not admitted');
    expect(await entry(overrides.key ?? intent.object_key)).toBeNull();
    await expectUnpublished(intent, journal);
  });

it('does not treat a legacy completion claim as a publication attempt', async () => {
  const owner = 'transaction-legacy';
  const intent = await allocated(owner);
  expect(await intents.claim(owner, intent.id, 2, 'completion')).toMatchObject({ state: 'completing', version: 3 });
  await expect(publish(intent)).rejects.toThrow('upload publication not admitted');
  await expectUnpublished(intent, { state: 'completing', version: 3 });
});

it('requires a publication receipt to acknowledge an attempt', async () => {
  const owner = 'transaction-unreceipted';
  const intent = await completing(owner);
  await expect(intents.recordSuccess(owner, intent.id, 3, { kind: 'completion' }))
    .rejects.toThrow('upload attempt requires publication');
  await expectUnpublished(intent, { state: 'completing', version: 3 });
  await publish(intent);
  expect(await intentRow(intent.id)).toMatchObject({ state: 'acknowledged', version: 4, completion_acknowledged: 1 });
});

it('does not publish when cleanup claimed the intent first', async () => {
  const intent = await allocated('transaction-cleanup');
  await cleanup(intent.id);
  // 0027 will not allow an attempt or completing journal to coexist with this claim.
  await expect(publish(intent, { version: 2 })).rejects.toThrow('upload publication not admitted');
  await expectUnpublished(intent, { state: 'allocated', version: 2 });
  expect(await sql('SELECT intent_id FROM drive_upload_cleanup_claims WHERE intent_id = ?', intent.id).first())
    .toEqual({ intent_id: intent.id });
});

it.each(['OR IGNORE', 'OR FAIL'])('rolls back invalid metadata even with %s', async (conflict) => {
  const intent = await completing(`transaction-${conflict}`);
  await expect(publish(intent, { name: '/' }, conflict)).rejects.toThrow('invalid publication metadata');
  await expectUnpublished(intent, { state: 'completing', version: 3 });
});

it.each(['overflow', 'missing'])('rolls back receipt and entry for %s folder accounting', async (problem) => {
  const owner = `transaction-count-${problem}`;
  const parent = `folder-${problem}`;
  const intent = await completing(owner);
  await folder(parent, owner);
  if (problem === 'overflow') {
    await sql('UPDATE drive_folder_counts SET item_count = ? WHERE folder_id = ?', Number.MAX_SAFE_INTEGER, parent).run();
  } else {
    await sql('DELETE FROM drive_folder_counts WHERE folder_id = ?', parent).run();
  }
  await expect(publish(intent, { parent }, 'OR FAIL'))
    .rejects.toThrow(problem === 'overflow' ? 'folder count overflow' : 'missing folder count');
  await expectUnpublished(intent, { state: 'completing', version: 3 });
  expect(await sql('SELECT item_count FROM drive_folder_counts WHERE folder_id = ?', parent).first())
    .toEqual(problem === 'overflow' ? { item_count: Number.MAX_SAFE_INTEGER } : null);
});

it.each(['missing-parent', 'conflicting-name'])('rolls back the transaction for %s', async (conflict) => {
  const owner = `transaction-${conflict}`;
  const intent = await completing(owner);
  const missing = conflict === 'missing-parent';
  if (!missing) await folder(`existing-${owner}`, owner, 'file');
  await expect(publish(intent, { parent: missing ? 'missing' : null }))
    .rejects.toThrow(missing ? 'invalid parent' : 'conflicting metadata');
  await expectUnpublished(intent, { state: 'completing', version: 3 });
  if (!missing) {
    expect(await sql('SELECT kind FROM drive_entries WHERE id = ?', `existing-${owner}`).first()).toEqual({ kind: 'folder' });
  }
});
