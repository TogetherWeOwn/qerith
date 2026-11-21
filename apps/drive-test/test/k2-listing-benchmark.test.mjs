import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { compareK2Entries, compareK2Names } from '../../drive/src/lib/server/metadata/k2-order.ts';

const pageSize = 200;
const folderRank = (entry) => entry.kind === 'folder' ? 0 : 1;

function fixture(count) {
  const tied = ['café 2', 'café 02', 'café ٢', 'café 002'];
  const prefixes = ['file', 'File', 'café', 'café', '📁 file', 'file-'];
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${String(i).padStart(5, '0')}`,
    kind: i % 5 === 0 ? 'folder' : 'file',
    kindLabel: i % 5 === 0 ? 'Folder' : 'File',
    name: i < 503 ? tied[i % tied.length] : `${prefixes[i % prefixes.length]} ${count - i}`,
    size: null,
    modified: null,
  }));
}

async function seed(db, entries) {
  await db.exec(`DROP TABLE IF EXISTS k2_bench;
    CREATE TABLE k2_bench (scope TEXT NOT NULL, folder_rank INTEGER NOT NULL, asc_rank INTEGER NOT NULL, desc_rank INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE INDEX k2_bench_asc ON k2_bench (scope, folder_rank, asc_rank, id);
    CREATE INDEX k2_bench_desc ON k2_bench (scope, folder_rank, desc_rank, id);`);
  // Dense ranks model already-materialized keys on an immutable synthetic
  // dataset. They are not a key encoder: real writes cannot rely on these ranks.
  const names = [...new Set(entries.map(({ name }) => name))].sort(compareK2Names);
  const ranks = new Map();
  let rank = 0;
  for (let i = 0; i < names.length; i++) {
    if (i > 0 && compareK2Names(names[i - 1], names[i])) rank++;
    ranks.set(names[i], rank);
  }
  const statements = [];
  for (let i = 0; i < entries.length; i += 16) {
    const chunk = entries.slice(i, i + 16);
    const values = chunk.flatMap((entry) => {
      const asc = ranks.get(entry.name);
      return ['target', folderRank(entry), asc, -asc, entry.id, entry.name];
    });
    statements.push(db.prepare(`INSERT INTO k2_bench VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`).bind(...values));
  }
  for (let i = 0; i < statements.length; i += 16) await db.batch(statements.slice(i, i + 16));
  await db.exec("INSERT INTO k2_bench VALUES ('other', 0, 0, 0, 'foreign', 'File 2')");
}

it.each([5_001, 10_001])('benchmarks indexed K2 name traversal over %i synthetic entries in Worker/D1', async (count) => {
  const db = env.DB;
  const entries = fixture(count);
  await seed(db, entries);
  for (const direction of ['asc', 'desc']) {
    const key = `${direction}_rank`;
    const sql = `SELECT folder_rank, ${key} AS name_rank, id, name FROM k2_bench
      WHERE scope = ? AND (folder_rank, ${key}, id) > (?, ?, ?)
      ORDER BY folder_rank, ${key}, id LIMIT ${pageSize + 1}`;
    const query = db.prepare(sql);
    const firstBoundary = ['target', -1, 0, ''];
    const { results: plan } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...firstBoundary).all();
    const detail = plan.map((row) => row.detail).join('\n');
    expect(detail).toMatch(new RegExp(`SEARCH k2_bench USING INDEX k2_bench_${direction}.*folder_rank`));
    expect(detail).not.toContain('TEMP B-TREE');

    let boundary = firstBoundary;
    const expected = [...entries].sort((a, b) => compareK2Entries(a, b, 'name', direction));
    const metrics = {};
    for (let offset = 0; offset < count; offset += pageSize) {
      const started = performance.now();
      const { results, meta } = await query.bind(...boundary).all();
      const page = results.slice(0, pageSize);
      const ids = page.map(({ id }) => id);
      if (offset === 0) {
        metrics.firstPageMs = performance.now() - started;
        metrics.firstPageRowsRead = meta.rows_read ?? null;
        metrics.firstPageFixtureBytes = new TextEncoder().encode(JSON.stringify(page)).length;
      }
      if (typeof meta.rows_read === 'number') {
        metrics.maxRowsRead = Math.max(metrics.maxRowsRead ?? 0, meta.rows_read);
      }
      expect(results).toHaveLength(Math.min(pageSize + 1, count - offset));
      expect(ids).toEqual(expected.slice(offset, offset + pageSize).map(({ id }) => id));
      const last = page.at(-1);
      boundary = ['target', last.folder_rank, last.name_rank, last.id];
    }
    // Local D1 diagnostics only, not a production latency/CPU assertion.
    console.info('K2 synthetic D1 benchmark', { count, direction, ...metrics });
  }
}, 30_000);
