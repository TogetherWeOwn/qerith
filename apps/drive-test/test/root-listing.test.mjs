import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { stagingOrigin } from '../../drive/src/lib/server/request-auth.ts';
import { loadRootListing } from '../../drive/src/lib/server/root-listing.ts';

const origin = 'https://drive.example.test';
const auth = { DB: env.DB, DRIVE_ORIGIN: origin };
function request(token, source, url = origin, method = 'GET') {
  const headers = new Headers();
  if (token) headers.set('cookie', `__Host-drive-session=${token}`);
  if (source) headers.set('origin', source);
  // A caller-supplied identity has no effect on the owner being listed.
  return new Request(`${url}/?principal=other`, { headers, method });
}

it('lists bounded pages of only the session owner’s root and projects client-safe fields', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals (id, role, status) VALUES ('member', 'member', 'active'), ('other', 'owner', 'active')");
  const insert = (id, owner, parent, name, key = null) => env.DB.prepare(`INSERT INTO drive_entries
    (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, owner, parent, name, key ? 'file' : 'folder', key, key ? 1 : null);
  const boundaryId = crypto.randomUUID();
  const nestedId = crypto.randomUUID();
  await env.DB.batch([
    ...Array.from({ length: 99 }, (_, n) => insert(`f${n}`, 'member', null, `folder-${String(n).padStart(2, '0')}`)),
    insert(boundaryId, 'member', null, 'á-👩🏽‍💻'),
    insert('last-folder', 'member', null, 'Ω folder'),
    insert('file', 'member', null, 'first.txt', 'test-storage-key'),
    insert('last', 'member', null, 'Ω.txt', 'test-last-key'),
    insert(nestedId, 'member', 'f0', 'hidden'),
    insert('other-file', 'other', null, '界.txt', 'test-other-key')
  ]);
  const sessions = new Sessions(env.DB);
  const { token } = await sessions.issue('member');
  const { token: otherToken } = await sessions.issue('other');
  const first = await loadRootListing(request(token), auth, []);
  expect(first.status).toBe('ok');
  expect(first.folder.entries).toHaveLength(100);
  expect(first.folder.entries[0]).toEqual({ id: 'f0', name: 'folder-00', kind: 'folder' });
  expect(first.folder.entries.at(-1)).toEqual({ id: boundaryId, name: 'á-👩🏽‍💻', kind: 'folder' });
  expect(first.folder.nextPage).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(JSON.stringify(first)).not.toContain(token);
  expect(JSON.stringify(first)).not.toContain('hidden');

  const page = first.folder.nextPage;
  expect(page).toBe(boundaryId); // The URL needs only the random ID, not the boundary name.
  expect(await loadRootListing(request(token), auth, [page])).toEqual({
    status: 'ok', folder: { entries: [
      { id: 'last-folder', name: 'Ω folder', kind: 'folder' },
      { id: 'file', name: 'first.txt', kind: 'file' }, { id: 'last', name: 'Ω.txt', kind: 'file' }
    ], nextPage: null }
  });
  expect(await loadRootListing(request(otherToken), auth, [page])).toEqual({ status: 'invalid-page' });
  expect(await loadRootListing(request(), auth, [page])).toEqual({ status: 'unavailable' });
  await env.DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind('f0', boundaryId).run();
  for (const invalid of [[''], ['not+url-safe'], ['a'.repeat(4097)], [page, page], [nestedId], [page], [crypto.randomUUID()]]) {
    expect(await loadRootListing(request(token), auth, invalid)).toEqual({ status: 'invalid-page' });
  }
  const failedDb = { prepare(sql) {
    if (sql.includes('WITH authorized AS')) throw new Error('synthetic listing outage');
    return env.DB.prepare(sql);
  } };
  expect(await loadRootListing(request(token), { ...auth, DB: failedDb }, [page])).toEqual({ status: 'unavailable' });
});

it('denies absent, wrong-origin, and revoked sessions rather than returning an empty drive', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const principalId = 'revocation-member';
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')")
    .bind(principalId).run();
  const { token } = await new Sessions(env.DB).issue(principalId);
  const unavailable = { status: 'unavailable' };
  expect(await loadRootListing(request(token), auth, [])).toEqual({ status: 'ok', folder: { entries: [], nextPage: null } });
  expect(await loadRootListing(request(token), {}, [])).toEqual(unavailable);
  for (const denied of [request(), request(token, 'https://other.example.test'), request(token, origin, 'https://other.example.test'), request(token, origin, origin, 'POST')]) {
    expect(await loadRootListing(denied, auth, [])).toEqual(unavailable);
  }
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(principalId).run();
  expect(await loadRootListing(request(token), auth, [])).toEqual(unavailable);
});

it.each(['session revoked', 'session expired', 'membership revoked', 'owner demoted'])('denies a listing when %s after session lookup', async (change) => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const principalId = `listing-${change}`;
  const demoted = change === 'owner demoted', DRIVE_ORIGIN = demoted ? stagingOrigin : origin;
  await env.DB.batch([
    ...(demoted ? [env.DB.prepare("UPDATE drive_principals SET role = 'member' WHERE id = 'other'")] : []),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, ?, 'active')").bind(principalId, demoted ? 'owner' : 'member'),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'Private', 'folder')")
      .bind(principalId, principalId)
  ]);
  const sessions = new Sessions(env.DB);
  const { token, expiresAt } = await sessions.issue(principalId);
  let lookedUp;
  let listed = false;
  const db = { prepare: (sql) => ({ bind(...values) {
    const statement = env.DB.prepare(sql).bind(...values);
    return {
      async all() {
        const result = await statement.all();
        listed = true;
        return result;
      },
      async first() {
        const row = await statement.first();
        lookedUp = row?.id;
        if (change === 'session revoked') await sessions.revoke(token);
        else if (change === 'session expired') {
          await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = ?').bind(principalId).run();
        } else if (demoted) {
          await env.DB.prepare("UPDATE drive_principals SET role = 'member' WHERE id = ?").bind(principalId).run();
        } else {
          await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(principalId).run();
          // Restore the fixture session so only the membership check can deny the read.
          await env.DB.prepare('INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)')
            .bind(await tokenHash(token), principalId, expiresAt).run();
        }
        return row;
      }
    };
  } }) };
  expect(await loadRootListing(request(token, undefined, DRIVE_ORIGIN), { DB: db, DRIVE_ORIGIN }, [])).toEqual({ status: 'unavailable' });
  expect(lookedUp).toBe(principalId);
  expect(listed).toBe(true);
});
