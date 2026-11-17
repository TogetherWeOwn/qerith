import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';

it('upgrades existing metadata with a private upload intent journal', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0016_upload_intents.sql'));
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')").run();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await env.DB.prepare("SELECT name FROM drive_entries WHERE id = 'folder'").first()).toEqual({ name: 'folder' });
  expect((await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((row) => row.name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  await env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('intent', 'alice', 'key', 'created')").run();
  expect(await env.DB.prepare('SELECT state, version, upload_id FROM drive_upload_intents WHERE id = ?').bind('intent').first())
    .toEqual({ state: 'created', version: 0, upload_id: null });
  await expect(env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('invalid', 'alice', 'other', 'acknowledged')").run()).rejects.toThrow();
  expect((await env.DB.prepare('SELECT id FROM drive_entries').all()).results).toEqual([{ id: 'folder' }]);
});

it('scans interrupted and uncertain operations in bounded restartable pages', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?)')
    .bind('recovery-active', 'member', 'active', 'recovery-revoked', 'member', 'revoked').run();
  const insert = env.DB.prepare(`INSERT INTO drive_upload_intents
    (id, owner_id, object_key, upload_id, state, version) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of [
    ['a', 'recovery-active', 'key-a', null, 'initiating', 1],
    ['b', 'recovery-revoked', 'key-b', 'upload-b', 'completing', 3],
    ['c', 'recovery-revoked', 'key-c', null, 'uncertain', 2],
    ['d', 'recovery-active', 'key-d', 'upload-d', 'uncertain', 4],
    ['e', 'recovery-active', 'key-e', null, 'created', 0],
    ['f', 'recovery-revoked', 'key-f', 'upload-f', 'allocated', 2],
    ['g', 'recovery-active', 'key-g', 'upload-g', 'acknowledged', 4],
  ]) await insert.bind(...row).run();

  const intents = new UploadIntents(env.DB);
  for (const scan of [intents.listInFlight.bind(intents), intents.listUncertain.bind(intents)]) {
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      await expect(scan('', limit)).rejects.toThrow('Invalid recovery limit');
    }
  }
  const first = await intents.listInFlight('', 1);
  const second = await intents.listInFlight(first[0].id, 1);
  expect(first.map(({ id }) => id)).toEqual(['a']);
  expect(second).toEqual([expect.objectContaining({ id: 'b', owner_id: 'recovery-revoked', state: 'completing', version: 3 })]);
  expect(await intents.listInFlight(second[0].id, 100)).toEqual([]);
  expect((await intents.listInFlight('', 100)).map(({ id }) => id)).toEqual(['a', 'b']);

  const uncertain = await intents.listUncertain('', 1);
  const next = await intents.listUncertain(uncertain[0].id, 1);
  expect(uncertain).toEqual([expect.objectContaining({ id: 'c', owner_id: 'recovery-revoked', upload_id: null, version: 2 })]);
  expect(next).toEqual([expect.objectContaining({ id: 'd', upload_id: 'upload-d', version: 4 })]);
  expect(uncertain[0].version - 1).toBe(1); // allocation claim before quarantine
  expect(next[0].version - 1).toBe(3); // completion claim before quarantine
  expect(await intents.listUncertain(next[0].id, 100)).toEqual([]);
  expect((await intents.listUncertain('', 100)).map(({ id }) => id)).toEqual(['c', 'd']);
  expect(await intents.get('recovery-revoked', 'c')).toBeNull();
  await env.DB.prepare("DELETE FROM drive_upload_intents WHERE owner_id IN ('recovery-active', 'recovery-revoked')").run();
});

it('scans inactive owners’ provider evidence in bounded pages', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?)')
    .bind('scan-active', 'member', 'active', 'scan-revoked', 'member', 'revoked').run();
  const insert = env.DB.prepare(`INSERT INTO drive_upload_intents
    (id, owner_id, object_key, upload_id, state, completion_acknowledged)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of [
    ['scan-a', 'scan-revoked', 'scan-key-a', 'upload-a', 'allocated', 0],
    ['scan-b', 'scan-revoked', 'scan-key-b', 'upload-b', 'acknowledged', 1],
    ['scan-c', 'scan-active', 'scan-key-c', 'upload-c', 'allocated', 0],
    ['scan-d', 'scan-revoked', 'scan-key-d', null, 'created', 0],
    ['scan-e', 'scan-missing', 'scan-key-e', 'upload-e', 'allocated', 0],
  ]) await insert.bind(...row).run();

  const intents = new UploadIntents(env.DB);
  for (const limit of [0, -1, 101, 1.5, NaN]) {
    await expect(intents.listRevokedEvidence('', limit)).rejects.toThrow('Invalid recovery limit');
  }
  const page = await intents.listRevokedEvidence('', 2);
  expect(page.map(({ id }) => id)).toEqual(['scan-a', 'scan-b']);
  expect(page).toEqual([
    expect.objectContaining({ owner_id: 'scan-revoked', state: 'allocated', upload_id: 'upload-a' }),
    expect.objectContaining({ owner_id: 'scan-revoked', state: 'acknowledged', upload_id: 'upload-b', completion_acknowledged: 1 }),
  ]);
  const next = await intents.listRevokedEvidence(page[1].id, 2);
  expect(next.map(({ id }) => id)).toEqual(['scan-e']);
  expect(await intents.listRevokedEvidence(next[0].id, 100)).toEqual([]);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'scan-active'").run();
  expect((await intents.listRevokedEvidence('', 100)).map(({ id }) => id)).toEqual(['scan-a', 'scan-b', 'scan-c', 'scan-e']);
});

it('atomically claims only the active owner’s matching version and state', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('claim-owner', 'member', 'active', 'claim-other', 'member', 'active', 'claim-revoked', 'member', 'revoked').run();
  const insert = env.DB.prepare(`INSERT INTO drive_upload_intents
    (id, owner_id, object_key, upload_id, state, version) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of [
    ['claim-a', 'claim-owner', 'claim-key-a', null, 'created', 0],
    ['claim-b', 'claim-owner', 'claim-key-b', 'provider-id', 'allocated', 4],
    ['claim-c', 'claim-revoked', 'claim-key-c', null, 'created', 0],
    ['claim-d', 'claim-missing', 'claim-key-d', null, 'created', 0],
  ]) await insert.bind(...row).run();
  const entriesBefore = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  const intents = new UploadIntents(env.DB);
  expect(await intents.claim('claim-other', 'claim-a', 0, 'allocation')).toBeNull();
  expect(await intents.claim('claim-owner', 'claim-a', 1, 'allocation')).toBeNull();
  expect(await intents.claim('claim-owner', 'claim-a', 0, 'completion')).toBeNull();
  expect(await intents.claim('claim-revoked', 'claim-c', 0, 'allocation')).toBeNull();
  expect(await intents.claim('claim-missing', 'claim-d', 0, 'allocation')).toBeNull();
  const claims = await Promise.all([
    intents.claim('claim-owner', 'claim-a', 0, 'allocation'),
    intents.claim('claim-owner', 'claim-a', 0, 'allocation'),
  ]);
  expect(claims.filter(Boolean)).toEqual([expect.objectContaining({ state: 'initiating', version: 1 })]);
  expect(await intents.claim('claim-owner', 'claim-a', 1, 'allocation')).toBeNull();
  expect(await intents.claim('claim-owner', 'claim-b', 4, 'completion'))
    .toMatchObject({ state: 'completing', version: 5, upload_id: 'provider-id' });
  expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(entriesBefore);
});

it('quarantines only the matching in-flight attempt, including after revocation', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('quarantine-owner', 'member', 'active')").run();
  await env.DB.prepare(`INSERT INTO drive_upload_intents
    (id, owner_id, object_key, upload_id, state, version) VALUES
    ('quarantine-a', 'quarantine-owner', 'quarantine-key-a', NULL, 'initiating', 1),
    ('quarantine-b', 'quarantine-owner', 'quarantine-key-b', 'provider-id', 'completing', 3)`).run();
  const intents = new UploadIntents(env.DB);
  expect(await intents.recordUncertain('other', 'quarantine-a', 1, 'allocation')).toBe(false);
  expect(await intents.recordUncertain('quarantine-owner', 'quarantine-a', 0, 'allocation')).toBe(false);
  expect(await intents.recordUncertain('quarantine-owner', 'quarantine-a', 1, 'completion')).toBe(false);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'quarantine-owner'").run();
  expect(await intents.get('quarantine-owner', 'quarantine-a')).toBeNull();
  expect(await intents.claim('quarantine-owner', 'quarantine-a', 1, 'allocation')).toBeNull();
  expect(await intents.recordUncertain('quarantine-owner', 'quarantine-a', 1, 'allocation')).toBe(true);
  expect(await intents.recordUncertain('quarantine-owner', 'quarantine-a', 1, 'allocation')).toBe(false);
  expect(await intents.recordUncertain('quarantine-owner', 'quarantine-b', 3, 'completion')).toBe(true);
  expect(await env.DB.prepare('SELECT id, state, version, upload_id FROM drive_upload_intents WHERE owner_id = ? ORDER BY id')
    .bind('quarantine-owner').all()).toMatchObject({ results: [
    { id: 'quarantine-a', state: 'uncertain', version: 2, upload_id: null },
    { id: 'quarantine-b', state: 'uncertain', version: 4, upload_id: 'provider-id' },
  ] });
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'quarantine-owner'").run();
  expect(await intents.claim('quarantine-owner', 'quarantine-a', 2, 'allocation')).toBeNull();
  expect(await intents.claim('quarantine-owner', 'quarantine-b', 4, 'completion')).toBeNull();
});

it('validates versions and operation before transition queries', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const intents = new UploadIntents(env.DB);
  for (const version of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    await expect(intents.claim('owner', 'id', version, 'allocation')).rejects.toThrow('Invalid upload version');
    await expect(intents.recordUncertain('owner', 'id', version, 'allocation')).rejects.toThrow('Invalid upload version');
  }
  await expect(intents.claim('owner', 'id', Number.MAX_SAFE_INTEGER - 2, 'allocation')).rejects.toThrow('Invalid upload version');
  expect(await intents.claim('owner', 'id', Number.MAX_SAFE_INTEGER - 3, 'allocation')).toBeNull();
  expect(await intents.recordUncertain('owner', 'id', Number.MAX_SAFE_INTEGER - 2, 'allocation')).toBe(false);
  await expect(intents.claim('owner', 'id', 0, 'invalid')).rejects.toThrow('Invalid upload operation');
  await expect(intents.recordUncertain('owner', 'id', 0, 'invalid')).rejects.toThrow('Invalid upload operation');
});

it('creates private intents only for active members and isolates owners', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('alice', 'member', 'active', 'bob', 'member', 'active', 'revoked', 'member', 'revoked').run();
  const entriesBefore = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  const intentsBefore = (await env.DB.prepare('SELECT id FROM drive_upload_intents').all()).results;
  const intents = new UploadIntents(env.DB);
  expect(await intents.create('revoked')).toBeNull();
  expect(await intents.create('missing')).toBeNull();
  const intent = await intents.create('alice');
  expect(intent).toMatchObject({ owner_id: 'alice', state: 'created', version: 0, upload_id: null, completion_acknowledged: 0 });
  expect(intent.id).toBeTruthy();
  expect(intent.object_key).toBeTruthy();
  expect(await intents.get('alice', intent.id)).toEqual(intent);
  expect(await intents.get('bob', intent.id)).toBeNull();
  expect(await intents.get('alice', 'missing')).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await intents.get('alice', intent.id)).toBeNull();
  expect(await intents.create('alice')).toBeNull();
  const intentsAfter = (await env.DB.prepare('SELECT id FROM drive_upload_intents').all()).results;
  expect(intentsAfter).toEqual(expect.arrayContaining([...intentsBefore, { id: intent.id }]));
  expect(intentsAfter).toHaveLength(intentsBefore.length + 1);
  expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(entriesBefore);
});
