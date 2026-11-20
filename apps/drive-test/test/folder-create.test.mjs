import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { postFolder } from '../../drive/src/lib/server/folder-route.ts';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';

const origin = 'https://drive.example.test';
const fixture = { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
const sessions = new Sessions(env.DB);
const entries = async () => (await env.DB.prepare('SELECT id, owner_id, parent_id, name, kind FROM drive_entries ORDER BY id').all()).results;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('alice', 'member', 'active'), ('bob', 'member', 'active')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder:bob', 'bob', 'Private', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('child:bob', 'bob', 'folder:bob', 'Nested', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES ('file:alice', 'alice', 'File', 'file', 'test-key', 0)"),
  ]);
});

function post(token, name, parentId, overrides = {}) {
  return postFolder(new Request(`${origin}/api/folders`, {
    method: 'POST', body: JSON.stringify({ name, parentId }),
    headers: { origin, 'content-type': 'application/json', cookie: `__Host-drive-session=${token}` },
    ...overrides,
  }), fixture);
}

async function deny(response, status) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.text()).toBe('');
}

it('creates at own root and under an owned folder, returning only the client projection', async () => {
  const { token } = await sessions.issue('alice');
  const rootResponse = await post(token, 'Private', null);
  const root = await rootResponse.json();
  expect(rootResponse.status).toBe(201);
  expect(rootResponse.headers.get('cache-control')).toBe('private, no-store');
  expect(root).toEqual({ id: expect.any(String), name: 'Private', parentId: null, kind: 'folder' });

  const nestedResponse = await post(token, 'Nested', root.id);
  const nested = await nestedResponse.json();
  expect(nestedResponse.status).toBe(201);
  expect(nested).toEqual({ id: expect.any(String), name: 'Nested', parentId: root.id, kind: 'folder' });
  expect(await entries()).toContainEqual({ id: nested.id, owner_id: 'alice', parent_id: root.id, name: 'Nested', kind: 'folder' });

  const { token: bob } = await sessions.issue('bob');
  expect((await post(bob, 'Opaque parent', 'folder:bob')).status).toBe(201);
  const before = await entries();
  await deny(await post(token, 'Private', null), 409);
  await deny(await post(token, 'File', null), 409);
  await deny(await post(token, 'Nested', root.id), 409);
  expect(await entries()).toEqual(before);
});

it('commits one row when two requests race for the same name', async () => {
  const { token } = await sessions.issue('alice');
  const name = `${'é'.repeat(127)}a`; // Exactly 255 UTF-8 bytes.
  const responses = await Promise.all([post(token, name, null), post(token, name, null)]);
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  expect((await entries()).filter(entry => entry.name === name)).toHaveLength(1);
});

it('does not disclose or write under foreign, missing or file parents', async () => {
  const { token } = await sessions.issue('alice');
  const before = await entries();
  for (const parentId of ['folder:bob', 'missing', 'file:alice']) {
    await deny(await post(token, 'Nested', parentId), 404);
  }
  expect(await entries()).toEqual(before);
});

it('does not write with a revoked or expired session or a session for an inactive member', async () => {
  const { token: revoked } = await sessions.issue('alice');
  const { token: expired } = await sessions.issue('alice');
  const { token: inactive, expiresAt } = await sessions.issue('bob');
  await sessions.revoke(revoked);
  await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?').bind(await tokenHash(expired)).run();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'").run();
  // Keep a session row independently of the revocation trigger to exercise the membership predicate itself.
  await env.DB.prepare("INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, 'bob', ?)")
    .bind(await tokenHash(inactive), expiresAt).run();
  const before = await entries();
  for (const token of [revoked, expired, inactive]) await deny(await post(token, 'Private', null), 401);
  expect(await entries()).toEqual(before);
});
