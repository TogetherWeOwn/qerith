import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_read_grants'),
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('alice', 'member', 'active'), ('bob', 'member', 'active'), ('disabled', 'member', 'revoked')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder'), ('private', 'bob', 'private', 'folder'), ('root', 'owner', 'root', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES ('file', 'alice', 'folder', 'file', 'file', 'key', 1)"),
  ]);
  const sessions = new Sessions(env.DB);
  return { grants: new ReadGrants(env.DB), sessions,
    owner: (await sessions.issue('owner')).token,
    alice: (await sessions.issue('alice')).token,
    bob: (await sessions.issue('bob')).token };
}

it('allows only the entry owner to create and revoke exact-entry grants', async () => {
  const { grants, owner, alice, bob } = await setup();
  expect(await grants.create(owner, 'folder', 'bob')).toBe(false);
  expect(await grants.create(bob, 'folder', 'bob')).toBe(false);
  expect(await grants.create('alice', 'folder', 'bob')).toBe(false);
  expect(await grants.create(alice, 'missing', 'bob')).toBe(false);
  expect(await grants.create(alice, 'folder', 'missing')).toBe(false);
  expect(await grants.create(alice, 'folder', 'disabled')).toBe(false);
  expect(await grants.create(alice, 'folder', 'owner')).toBe(false);
  expect(await grants.create(alice, 'folder', 'alice')).toBe(false);
  expect(await grants.create(alice, 'folder', 'bob')).toBe(true);
  expect(await grants.create(alice, 'folder', 'bob')).toBe(false);
  expect(await grants.has(bob, 'folder')).toBe(true);
  expect(await grants.has(bob, 'file')).toBe(false);
  expect(await grants.has(owner, 'folder')).toBe(false);
  expect(await grants.revoke(owner, 'folder', 'bob')).toBe(false);
  expect(await grants.has(bob, 'folder')).toBe(true);
  expect(await grants.revoke(alice, 'folder', 'bob')).toBe(true);
  expect(await grants.revoke(alice, 'folder', 'bob')).toBe(false);
  expect(await grants.has(bob, 'folder')).toBe(false);
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  expect(await grants.has(bob, 'file')).toBe(true);
});

it('invalidates grants across membership changes and expired or revoked sessions', async () => {
  const { grants, sessions, alice, bob } = await setup();
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'").run();
  expect(await grants.has(bob, 'file')).toBe(false);
  expect(await grants.create(alice, 'file', 'bob')).toBe(false);
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'bob'").run();
  const newBob = (await sessions.issue('bob')).token;
  expect(await grants.has(newBob, 'file')).toBe(false);
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await grants.has(newBob, 'file')).toBe(false);
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'alice'").run();
  const newAlice = (await sessions.issue('alice')).token;
  expect(await grants.has(newBob, 'file')).toBe(false);
  expect(await grants.create(alice, 'file', 'bob')).toBe(false);
  expect(await grants.create(newAlice, 'file', 'bob')).toBe(true);
  await sessions.revoke(newAlice);
  expect(await grants.revoke(newAlice, 'file', 'bob')).toBe(false);
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'bob'").run();
  expect(await grants.has(newBob, 'file')).toBe(false);
});
