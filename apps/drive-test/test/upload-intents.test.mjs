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

it('claims attempts atomically, retains late evidence and isolates revoked owners', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const entriesBefore = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('claim-alice', 'member', 'active', 'claim-bob', 'member', 'active', 'claim-revoked', 'member', 'revoked').run();
  const intents = new UploadIntents(env.DB);
  expect(await intents.create('claim-revoked')).toBeNull();
  const initial = await intents.create('claim-alice');
  expect(await intents.get('claim-bob', initial.id)).toBeNull();
  expect(await intents.claim('claim-bob', initial.id, 0, 'allocation')).toBeNull();
  const claims = await Promise.all([
    intents.claim('claim-alice', initial.id, 0, 'allocation'),
    intents.claim('claim-alice', initial.id, 0, 'allocation'),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await intents.recordNotDispatched('claim-alice', initial.id, 1, 'allocation')).toBe(true);
  expect(await intents.recordSuccess('claim-alice', initial.id, 1, { kind: 'allocation', uploadId: 'stale' })).toBe(false);
  expect(await intents.claim('claim-alice', initial.id, 0, 'allocation')).toBeNull();
  expect(await intents.claim('claim-alice', initial.id, 2, 'allocation')).toMatchObject({ state: 'initiating', version: 3 });
  expect(await intents.recordUncertain('claim-alice', initial.id, 3, 'allocation')).toBe(true);
  expect(await intents.claim('claim-alice', initial.id, 4, 'allocation')).toBeNull();
  expect(await intents.recordSuccess('claim-alice', initial.id, 3, { kind: 'allocation', uploadId: 'late-id' })).toBe(true);
  expect(await intents.recordSuccess('claim-alice', initial.id, 3, { kind: 'allocation', uploadId: 'wrong-id' })).toBe(false);
  expect(await intents.get('claim-alice', initial.id)).toMatchObject({ state: 'allocated', upload_id: 'late-id', version: 5 });
  expect(await intents.claim('claim-alice', initial.id, 5, 'completion')).toMatchObject({ state: 'completing', version: 6 });
  expect(await intents.recordSuccess('claim-alice', initial.id, 6, { kind: 'completion' })).toBe(true);

  const completion = await intents.create('claim-alice');
  await intents.claim('claim-alice', completion.id, 0, 'allocation');
  await intents.recordSuccess('claim-alice', completion.id, 1, { kind: 'allocation', uploadId: 'provider-id' });
  expect(await intents.claim('claim-alice', completion.id, 2, 'completion')).toMatchObject({ state: 'completing', version: 3 });
  expect(await intents.recordUncertain('claim-alice', completion.id, 3, 'completion')).toBe(true);
  expect(await intents.recordNotDispatched('claim-alice', completion.id, 3, 'allocation')).toBe(false);
  expect(await intents.recordNotDispatched('claim-alice', completion.id, 3, 'completion')).toBe(true);
  expect(await intents.claim('claim-alice', completion.id, 5, 'completion')).toMatchObject({ version: 6 });
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'claim-alice'").run();
  expect(await intents.get('claim-alice', completion.id)).toBeNull();
  expect(await intents.claim('claim-alice', completion.id, 6, 'completion')).toBeNull();
  expect(await intents.recordUncertain('claim-alice', completion.id, 6, 'completion')).toBe(true);
  expect(await intents.recordSuccess('claim-alice', completion.id, 6, { kind: 'completion' })).toBe(true);
  expect(await env.DB.prepare('SELECT state, upload_id, completion_acknowledged FROM drive_upload_intents WHERE id = ?')
    .bind(completion.id).first()).toEqual({ state: 'acknowledged', upload_id: 'provider-id', completion_acknowledged: 1 });
  expect(await intents.get('claim-bob', completion.id)).toBeNull();
  expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(entriesBefore);
});

it('scans interrupted claims in bounded pages and quarantines without authorizing retries', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('recovery-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const first = await intents.create('recovery-owner');
  const second = await intents.create('recovery-owner');
  await intents.claim('recovery-owner', first.id, 0, 'allocation');
  await intents.claim('recovery-owner', second.id, 0, 'allocation');
  await expect(intents.listInFlight('', 0)).rejects.toThrow();
  await expect(intents.listInFlight('', 101)).rejects.toThrow();
  const page = await intents.listInFlight('', 1);
  expect(page).toHaveLength(1);
  const next = await intents.listInFlight(page[0].id, 1);
  expect(next).toHaveLength(1);
  expect(new Set([page[0].id, next[0].id])).toEqual(new Set([first.id, second.id]));
  expect(await intents.recordUncertain(page[0].owner_id, page[0].id, page[0].version, 'allocation')).toBe(true);
  expect(await intents.claim('recovery-owner', page[0].id, 2, 'allocation')).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'recovery-owner'").run();
  expect(await intents.get('recovery-owner', page[0].id)).toBeNull();
  const [uncertain] = await intents.listUncertain('', 1);
  expect(uncertain).toMatchObject({ id: page[0].id, state: 'uncertain' });
  expect(await intents.listUncertain(uncertain.id, 1)).toEqual([]);
  await expect(intents.listUncertain('', 101)).rejects.toThrow();
  const claimVersion = uncertain.version - 1;
  expect(await intents.recordNotDispatched(uncertain.owner_id, uncertain.id, claimVersion, 'completion')).toBe(false);
  expect(await intents.recordNotDispatched(uncertain.owner_id, uncertain.id, claimVersion, 'allocation')).toBe(true);
  expect(await intents.recordSuccess(page[0].owner_id, page[0].id, page[0].version, { kind: 'allocation', uploadId: 'late' })).toBe(false);
  expect(await intents.listUncertain('', 100)).toEqual([]);
  expect(await intents.listInFlight('', 100)).toHaveLength(1);
});

it('discovers revoked owners’ provider evidence after late success and restart', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('evidence-owner', 'member', 'active')").run();
  let intents = new UploadIntents(env.DB);
  const allocation = await intents.create('evidence-owner');
  const completion = await intents.create('evidence-owner');
  await intents.claim('evidence-owner', allocation.id, 0, 'allocation');
  await intents.claim('evidence-owner', completion.id, 0, 'allocation');
  await intents.recordSuccess('evidence-owner', completion.id, 1, { kind: 'allocation', uploadId: 'complete-id' });
  expect(await intents.listRevokedEvidence('', 100)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: completion.id }),
  ]));
  await intents.claim('evidence-owner', completion.id, 2, 'completion');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'evidence-owner'").run();
  await intents.recordUncertain('evidence-owner', allocation.id, 1, 'allocation');
  expect(await intents.recordSuccess('evidence-owner', allocation.id, 1, { kind: 'allocation', uploadId: 'late-id' })).toBe(true);
  expect(await intents.recordSuccess('evidence-owner', completion.id, 3, { kind: 'completion' })).toBe(true);
  intents = new UploadIntents(env.DB);
  expect(await intents.get('evidence-owner', allocation.id)).toBeNull();
  const rows = [];
  let cursor = '';
  for (;;) {
    const page = await intents.listRevokedEvidence(cursor, 1);
    if (!page.length) break;
    rows.push(page[0]);
    cursor = page[0].id;
  }
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: allocation.id, state: 'allocated', upload_id: 'late-id' }),
    expect.objectContaining({ id: completion.id, state: 'acknowledged', upload_id: 'complete-id', completion_acknowledged: 1 }),
  ]));
  await expect(intents.listRevokedEvidence('', 101)).rejects.toThrow();
});

it('rejects malformed outcomes and treats acknowledgements as terminal', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('terminal-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('terminal-owner');
  await expect(intents.claim('terminal-owner', intent.id, Number.MAX_SAFE_INTEGER - 2, 'allocation')).rejects.toThrow();
  await expect(intents.claim('terminal-owner', intent.id, -1, 'allocation')).rejects.toThrow();
  await intents.claim('terminal-owner', intent.id, 0, 'allocation');
  await expect(intents.recordSuccess('terminal-owner', intent.id, 1, { kind: 'allocation', uploadId: '' })).rejects.toThrow();
  await intents.recordSuccess('terminal-owner', intent.id, 1, { kind: 'allocation', uploadId: 'id' });
  await intents.claim('terminal-owner', intent.id, 2, 'completion');
  expect(await intents.recordSuccess('terminal-owner', intent.id, 3, { kind: 'completion' })).toBe(true);
  expect(await intents.claim('terminal-owner', intent.id, 4, 'completion')).toBeNull();
  expect(await intents.recordUncertain('terminal-owner', intent.id, 3, 'completion')).toBe(false);
  expect(await intents.get('terminal-owner', intent.id)).toMatchObject({ state: 'acknowledged', version: 4 });
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
