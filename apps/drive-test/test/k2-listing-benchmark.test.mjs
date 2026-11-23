import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { compareK2Entries, compareK2Names } from '../../drive/src/lib/server/metadata/k2-order.ts';

const pageSize = 200;
const tied = ['café 2', 'café 02', 'café ٢', 'café 002'];
const folderRank = (entry) => entry.kind === 'folder' ? 0 : 1;

it('honors pinned numeric and NFC expectations in the Worker collation runtime', () => {
  // Rank materialization and the traversal oracle share the comparator. These
  // independent expectations catch a runtime that falls back to lexical order.
  expect(['file 10', 'file ２', 'file 1'].sort(compareK2Names)).toEqual(['file 1', 'file ２', 'file 10']);
  for (const name of tied) expect(compareK2Names(name, tied[0])).toBe(0);
  expect(compareK2Names('9'.repeat(254), `1${'0'.repeat(254)}`)).toBeLessThan(0);
  expect(compareK2Names(`${'9'.repeat(254)}1`, `${'9'.repeat(254)}2`)).toBeLessThan(0);
});

function fixture(count) {
  const prefixes = ['file', 'File', 'café', 'café', '📁 file', 'file-'];
  // For both fixture counts the folder/file and known/unknown transitions
  // land exactly on page seams, with enough tied zero-byte files to span pages.
  const unknownFrom = (count - 1) * 3 / 4;
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 5 === 0 && i < count - 1 ? 'folder' : 'file';
    return {
      id: `entry-${String(i).padStart(5, '0')}`,
      kind,
      kindLabel: kind === 'folder' ? 'Folder' : 'File',
      name: i < 503 ? tied[i % tied.length] : `${prefixes[i % prefixes.length]} ${count - i}`,
      size: kind === 'folder' || i >= unknownFrom ? null : i < 503 || i % 2 === 0 ? 0 : 4096,
      modified: null,
    };
  });
}

async function seed(db, entries) {
  await db.exec(`DROP TABLE IF EXISTS k2_bench;
    CREATE TABLE k2_bench (scope TEXT NOT NULL, folder_rank INTEGER NOT NULL, asc_rank INTEGER NOT NULL, desc_rank INTEGER NOT NULL, size_unknown INTEGER NOT NULL, asc_size INTEGER NOT NULL, desc_size INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE INDEX k2_bench_name_asc ON k2_bench (scope, folder_rank, asc_rank, id);
    CREATE INDEX k2_bench_name_desc ON k2_bench (scope, folder_rank, desc_rank, id);
    CREATE INDEX k2_bench_size_asc ON k2_bench (scope, folder_rank, size_unknown, asc_size, asc_rank, id);
    CREATE INDEX k2_bench_size_desc ON k2_bench (scope, folder_rank, size_unknown, desc_size, asc_rank, id);`);
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
  for (let i = 0; i < entries.length; i += 11) {
    const chunk = entries.slice(i, i + 11); // 9 columns; stay under D1's 100 bind slots.
    const values = chunk.flatMap((entry) => {
      const asc = ranks.get(entry.name);
      // Non-null seek keys keep unknowns distinct from legitimate zero bytes.
      // Reverse only the known size, not the unknown bucket or the tie keys.
      const size = entry.size ?? 0;
      return ['target', folderRank(entry), asc, -asc, Number(entry.size === null), size, -size, entry.id, entry.name];
    });
    statements.push(db.prepare(`INSERT INTO k2_bench VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`).bind(...values));
  }
  for (let i = 0; i < statements.length; i += 16) await db.batch(statements.slice(i, i + 16));
  await db.exec("INSERT INTO k2_bench VALUES ('other', 0, 0, 0, 1, 0, 0, 'foreign', 'File 2')");
}

async function traverse(db, entries, sort, direction) {
  const count = entries.length;
  const prefix = sort === 'size' ? ['size_unknown', `${direction}_size`, 'asc_rank'] : [`${direction}_rank`];
  const tieColumns = ['folder_rank', ...prefix];
  const columns = [...tieColumns, 'id'];
  const tuple = columns.join(', ');
  const sql = `SELECT ${tuple}, name FROM k2_bench
    WHERE scope = ? AND (${tuple}) > (${columns.map(() => '?').join(', ')})
    ORDER BY ${tuple} LIMIT ${pageSize + 1}`;
  const query = db.prepare(sql);
  let boundary = ['target', -1, ...prefix.map(() => 0), ''];
  const { results: plan } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...boundary).all();
  const detail = plan.map((row) => row.detail).join('\n');
  expect(detail).toMatch(new RegExp(`SEARCH k2_bench USING INDEX k2_bench_${sort}_${direction}.*folder_rank`));
  expect(detail).not.toContain('TEMP B-TREE');

  const expected = [...entries].sort((a, b) => compareK2Entries(a, b, sort, direction));
  const folderCount = (count - 1) / 5;
  const firstUnknownOffset = sort === 'size' ? 4 * folderCount : null;
  const deepOffset = (Math.floor(count / pageSize) - 1) * pageSize;
  const samples = new Map([[0, 'first'], [folderCount, 'firstFile'], [deepOffset, 'deep']]);
  if (firstUnknownOffset !== null) samples.set(firstUnknownOffset, 'firstUnknown');
  const metrics = { maxRowsRead: null, pagesWithRowsRead: 0 };
  let splitFileTie = false;
  for (let offset = 0; offset < count; offset += pageSize) {
    const started = performance.now();
    const { results, meta } = await query.bind(...boundary).all();
    const queryMs = performance.now() - started;
    const page = results.slice(0, pageSize);
    const sample = samples.get(offset);
    if (sample) {
      metrics[sample] = {
        offset, queryMs, rowsRead: meta.rows_read ?? null,
        fixtureBytes: new TextEncoder().encode(JSON.stringify(page)).length,
      };
    }
    if (typeof meta.rows_read === 'number') {
      metrics.maxRowsRead = Math.max(metrics.maxRowsRead ?? 0, meta.rows_read);
      metrics.pagesWithRowsRead++;
    }
    const context = `${sort} ${direction}, offset ${offset}`;
    expect(results, context).toHaveLength(Math.min(pageSize + 1, count - offset));
    expect(page.map(({ id }) => id), context).toEqual(expected.slice(offset, offset + pageSize).map(({ id }) => id));
    const last = page.at(-1);
    const lookahead = results[pageSize];
    if (offset === folderCount - pageSize) expect([last.folder_rank, lookahead?.folder_rank]).toEqual([0, 1]);
    if (firstUnknownOffset !== null && offset === firstUnknownOffset - pageSize) {
      expect([last.size_unknown, lookahead?.size_unknown]).toEqual([0, 1]);
    }
    if (last.folder_rank === 1 && (sort === 'name' || last.size_unknown === 0) &&
        lookahead && tieColumns.every((key) => lookahead[key] === last[key])) {
      splitFileTie = true;
    }
    boundary = ['target', ...columns.map((key) => last[key])];
  }
  expect(splitFileTie, `${sort} ${direction} splits a file tie across pages`).toBe(true);
  expect((await query.bind(...boundary).all()).results).toEqual([]);
  // Local D1 diagnostics only, not a production latency/CPU assertion.
  console.info('K2 synthetic D1 benchmark', { count, sort, direction, pages: Math.ceil(count / pageSize), ...metrics });
}

it.each([5_001, 10_001])('benchmarks indexed K2 name and size traversal over %i synthetic entries in Worker/D1', async (count) => {
  const db = env.DB;
  const entries = fixture(count);
  await seed(db, entries);
  for (const sort of ['name', 'size']) {
    for (const direction of ['asc', 'desc']) await traverse(db, entries, sort, direction);
  }
}, 30_000);
