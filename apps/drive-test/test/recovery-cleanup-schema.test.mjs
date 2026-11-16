import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('cleans old invalid recovery ceremonies and replays the full migration directory', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0012_recovery_challenge_cleanup.sql'));
  await env.DB.exec(`INSERT INTO drive_principals VALUES ('member', 'member', 'active');
    INSERT INTO drive_recovery_tokens VALUES ('active', 'member', printf('%064x', 1), 9999999999999, NULL, NULL);
    INSERT INTO drive_recovery_tokens VALUES ('cancelled', 'member', printf('%064x', 2), 9999999999999, 1, NULL);
    INSERT INTO drive_recovery_tokens VALUES ('expired', 'member', printf('%064x', 3), 1, NULL, NULL);
    INSERT INTO drive_bound_ceremonies VALUES ('recovery:' || printf('%064x', 1), 'registration', 'active', 9999999999999);
    INSERT INTO drive_bound_ceremonies VALUES ('recovery:' || printf('%064x', 2), 'registration', 'cancelled', 9999999999999);
    INSERT INTO drive_bound_ceremonies VALUES ('recovery:' || printf('%064x', 3), 'registration', 'expired', 9999999999999);
    INSERT INTO drive_bound_ceremonies VALUES ('recovery:' || printf('%064x', 4), 'registration', 'orphan', 9999999999999);
    INSERT INTO drive_bound_ceremonies VALUES ('other', 'registration', 'other', 9999999999999)`);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies ORDER BY challenge').all()).results)
    .toEqual([{ challenge: 'active' }, { challenge: 'other' }]);
  expect((await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(({ name }) => name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
});
