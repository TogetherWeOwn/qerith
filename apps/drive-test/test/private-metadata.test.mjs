import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('checks live test-only membership through the D1 binding', async () => {
  await env.DB.prepare('CREATE TABLE members (id TEXT PRIMARY KEY, active INTEGER NOT NULL)').run();
  await env.DB.prepare('CREATE VIEW drive_active_members AS SELECT id FROM members WHERE active = 1').run();
  await env.DB.prepare("INSERT INTO members VALUES ('alice', 1), ('bob', 1), ('revoked', 0)").run();
  await applyD1Migrations(env.DB, env.METADATA_MIGRATIONS);
  const service = new PrivateMetadata(env.DB);
  const folder = await service.createFolder('alice', null, 'Documents');
  for (const principal of ['bob', 'revoked', 'absent']) {
    expect(await service.get(principal, folder.id)).toBeNull();
    expect(await service.get(principal, 'missing')).toBeNull();
    expect(await service.move(principal, folder.id, null, 'stolen')).toBeNull();
    expect(await service.list(principal, null)).toEqual({ entries: [], nextCursor: null });
  }
  for (const principal of ['revoked', 'absent']) {
    expect(await service.createFolder(principal, null, 'Denied')).toBeNull();
    expect(await service.usage(principal)).toBeNull();
  }
  await env.DB.prepare("UPDATE members SET active = 0 WHERE id = 'alice'").run();
  expect(await service.get('alice', folder.id)).toBeNull();
  expect(await service.move('alice', folder.id, null, 'Denied')).toBeNull();
  expect(await service.list('alice', null)).toEqual({ entries: [], nextCursor: null });
  expect(await service.createFolder('alice', null, 'Denied')).toBeNull();
  expect(await service.usage('alice')).toBeNull();
});
