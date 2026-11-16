import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { OwnerBootstrap } from '../../drive/src/lib/server/identity/owner-bootstrap.ts';
import { OwnerProvisioning } from '../../drive/src/lib/server/identity/owner-provisioning.ts';
import { fixture, rpID, origin } from '../../drive/tests/ceremony-fixture.ts';

it('only completes a verified, one-time owner ceremony and returns no sensitive failure details', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_bound_ceremonies;
    DELETE FROM drive_credentials;
    DELETE FROM drive_invitations;
    DELETE FROM drive_principals;`);
  const adapter = new OwnerProvisioning(new OwnerBootstrap(env.DB, rpID, origin));
  expect(await adapter.execute(null)).toEqual({ ok: false });
  expect(await adapter.execute({ operation: 'challenge', extra: true })).toEqual({ ok: false });
  const issued = await adapter.execute({ operation: 'challenge' });
  expect(issued.ok).toBe(true);
  const invalid = await fixture('registration', { challenge: issued.challenge, uv: false });
  expect(await adapter.execute({ operation: 'enroll', challenge: issued.challenge, response: invalid.registration })).toEqual({ ok: false });
  const signed = await fixture('registration', { challenge: issued.challenge });
  const request = { operation: 'enroll', challenge: issued.challenge, response: signed.registration };
  const results = await Promise.all(Array.from({ length: 4 }, () => adapter.execute(request)));
  expect(results.filter((result) => result.ok)).toEqual([{ ok: true }]);
  expect(await adapter.execute(request)).toEqual({ ok: false });
  expect(await adapter.execute({ operation: 'challenge' })).toEqual({ ok: false });
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'owner'").first()).n).toBe(1);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_credentials').first()).n).toBe(1);
});
