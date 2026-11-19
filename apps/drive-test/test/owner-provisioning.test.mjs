import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { OwnerBootstrap } from '../../drive/src/lib/server/identity/owner-bootstrap.ts';
import { OwnerProvisioning } from '../../drive/src/lib/server/identity/owner-provisioning.ts';
import worker from '../../drive/src/worker.ts';
import { fixture, rpID, origin } from '../../drive/tests/ceremony-fixture.ts';

it('only completes a verified, one-time owner ceremony and returns no sensitive failure details', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_owner_registration;
    DELETE FROM drive_credentials;
    DELETE FROM drive_invitations;
    DELETE FROM drive_principals;`);
  const adapter = new OwnerProvisioning(new OwnerBootstrap(env.DB, rpID, origin));
  expect(await adapter.execute(null)).toEqual({ ok: false });
  expect(await adapter.execute({ operation: 'challenge', extra: true })).toEqual({ ok: false });
  const issued = await adapter.execute({ operation: 'challenge' });
  expect(issued.ok).toBe(true);
  const { challenge } = issued.options;
  const invalid = await fixture('registration', { challenge, uv: false });
  expect(await adapter.execute({ operation: 'enroll', challenge, response: invalid.registration })).toEqual({ ok: false });
  const signed = await fixture('registration', { challenge });
  const request = { operation: 'enroll', challenge, response: signed.registration };
  expect(await adapter.execute({ ...request, user: issued.options.user })).toEqual({ ok: false });
  const results = await Promise.all(Array.from({ length: 4 }, () => adapter.execute(request)));
  expect(results.filter((result) => result.ok)).toEqual([{ ok: true }]);
  expect(await adapter.execute(request)).toEqual({ ok: false });
  expect(await adapter.execute({ operation: 'challenge' })).toEqual({ ok: false });
  expect(await env.DB.prepare("SELECT webauthn_user_handle FROM drive_principals WHERE role = 'owner'").first())
    .toEqual({ webauthn_user_handle: issued.options.user.id });
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_credentials').first()).n).toBe(1);
});

it('does not expose owner provisioning through Worker fetch', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  for (const path of ['/', '/owner/bootstrap', '/api/owner/provisioning']) {
    const request = new Request(`${origin}${path}`, { method: 'POST', body: JSON.stringify({ operation: 'challenge' }) });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(await env.DB.prepare('SELECT challenge FROM drive_owner_registration').first()).toBeNull();
});
