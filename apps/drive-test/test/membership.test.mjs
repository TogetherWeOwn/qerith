import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Membership } from '../../drive/src/lib/server/identity/membership.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('alice', 'member', 'active'), ('bob', 'member', 'active')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')"),
  ]);
  const sessions = new Sessions(env.DB);
  return { membership: new Membership(env.DB), sessions,
    owner: (await sessions.issue('owner')).token,
    alice: (await sessions.issue('alice')).token,
    bob: (await sessions.issue('bob')).token };
}

it('authorizes status changes with a live owner session and preserves data without reviving sessions', async () => {
  const { membership, sessions, owner, alice, bob } = await setup();
  const state = await membership.get(owner, 'alice');
  expect(state.status).toBe('active');
  expect(await membership.get(alice, 'bob')).toBeNull();
  expect(await membership.get(owner, 'owner')).toBeNull();
  expect(await membership.get(owner, 'missing')).toBeNull();
  expect(await membership.setStatus(alice, 'bob', state.generation, 'revoked')).toBe(false);
  expect(await membership.setStatus('owner', 'alice', state.generation, 'revoked')).toBe(false);
  expect(await membership.setStatus(owner, 'owner', state.generation, 'revoked')).toBe(false);
  expect(await membership.setStatus(owner, 'missing', state.generation, 'revoked')).toBe(false);
  expect(await membership.setStatus(owner, 'alice', state.generation, 'invalid')).toBe(false);
  expect(await membership.setStatus(owner, 'alice', state.generation, 'revoked')).toBe(true);
  expect(await sessions.lookup(alice)).toBeNull();
  await expect(sessions.issue('alice')).rejects.toThrow('Session unavailable');
  expect(await sessions.lookup(bob)).toEqual({ id: 'bob', role: 'member' });
  const revoked = await membership.get(owner, 'alice');
  expect(revoked.status).toBe('revoked');
  expect(revoked.generation).not.toBe(state.generation);
  expect(await membership.setStatus(owner, 'alice', revoked.generation, 'active')).toBe(true);
  expect(await sessions.lookup(alice)).toBeNull();
  expect((await sessions.issue('alice')).token).not.toBe(alice);
  expect(await env.DB.prepare("SELECT id FROM drive_entries WHERE id = 'folder' AND owner_id = 'alice'").first()).toEqual({ id: 'folder' });
  expect(await membership.setStatus(owner, 'alice', state.generation, 'revoked')).toBe(false);
});

it('serializes competing changes, rejects stale replays and checks owner authorization at use', async () => {
  const { membership, sessions, owner } = await setup();
  const state = await membership.get(owner, 'alice');
  const results = await Promise.all(Array.from({ length: 5 }, () => membership.setStatus(owner, 'alice', state.generation, 'revoked')));
  expect(results.filter(Boolean)).toHaveLength(1);
  const revoked = await membership.get(owner, 'alice');
  expect(await membership.setStatus(owner, 'alice', revoked.generation, 'revoked')).toBe(false);
  await sessions.revoke(owner);
  expect(await membership.get(owner, 'alice')).toBeNull();
  expect(await membership.setStatus(owner, 'alice', revoked.generation, 'active')).toBe(false);
  expect((await env.DB.prepare("SELECT status FROM drive_principals WHERE id = 'alice'").first()).status).toBe('revoked');
});

it('rolls back the transition and invalidations when a trigger aborts', async () => {
  const { membership, sessions, owner, alice } = await setup();
  const state = await membership.get(owner, 'alice');
  await env.DB.exec("CREATE TRIGGER membership_test_abort AFTER UPDATE OF status ON drive_principals BEGIN SELECT RAISE(ABORT, 'test abort'); END;");
  try {
    await expect(membership.setStatus(owner, 'alice', state.generation, 'revoked')).rejects.toThrow();
    expect(await membership.get(owner, 'alice')).toEqual(state);
    expect(await sessions.lookup(alice)).toEqual({ id: 'alice', role: 'member' });
  } finally {
    await env.DB.exec('DROP TRIGGER membership_test_abort');
  }
});
