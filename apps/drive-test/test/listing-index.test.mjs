import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('installs both folder listing indexes with the intended order', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  for (const [index, nameDescending] of [
    ['drive_entries_listing_asc', 0],
    ['drive_entries_listing_desc', 1],
  ]) {
    const { results } = await env.DB.prepare(`PRAGMA index_xinfo('${index}')`).all();
    expect(results.filter((column) => column.key === 1).map(({ name, desc, coll }) => [name, desc, coll])).toEqual([
      ['owner_id', 0, 'BINARY'],
      ['parent_id', 0, 'BINARY'],
      ['kind', 1, 'BINARY'],
      ['name', nameDescending, 'BINARY'],
      ['id', 0, 'BINARY'],
    ]);
  }
});
