import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { privateRequests } from '../../drive/src/lib/server/request-auth.ts';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';

it('resolves only the session principal and rechecks revocation and expiry on the next request', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare(`INSERT INTO drive_principals (id, role, status) VALUES
    ('owner', 'owner', 'active'), ('member', 'member', 'active')`).run();
  const sessions = new Sessions(env.DB);
  const owner = await sessions.issue('owner');
  const member = await sessions.issue('member');
  const origin = 'https://drive.example.test';
  const handle = privateRequests({ DRIVE_ORIGIN: origin, DB: env.DB });
  const access = (token) => handle({
    event: {
      request: new Request(`${origin}/private?principal=owner`, { headers: { cookie: `__Host-drive-session=${token}` } }),
      locals: {}
    },
    resolve: async ({ locals }) => Response.json(locals.driveSession.principal)
  });

  expect(await (await access(member.token)).json()).toEqual({ id: 'member', role: 'member' });
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
  expect((await access(member.token)).status).toBe(401);
  // Model a stale session row independently of the revocation trigger.
  await env.DB.prepare("INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, 'member', ?)")
    .bind(await tokenHash(member.token), member.expiresAt).run();
  expect((await access(member.token)).status).toBe(401);
  expect(await (await access(owner.token)).json()).toEqual({ id: 'owner', role: 'owner' });
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'owner'").run();
  expect((await access(owner.token)).status).toBe(401);
});
