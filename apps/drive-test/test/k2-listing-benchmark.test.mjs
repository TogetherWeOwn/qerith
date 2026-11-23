import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { compareK2Entries, compareK2Names } from '../../drive/src/lib/server/metadata/k2-order.ts';

const pageSize = 200;
const tied = ['café 2', 'café 02', 'café ٢', 'café 002'];
const folderRank = (entry) => entry.kind === 'folder' ? 0 : 1;
const sorts = ['name', 'size', 'modified', 'kind'];
const directions = ['asc', 'desc'];
const unknownColumn = (sort) => sort === 'size' || sort === 'modified' ? `${sort}_unknown` : null;
function seekColumns(sort, direction) {
  const primary = `${direction}_${sort}`;
  const unknown = unknownColumn(sort);
  return ['folder_rank', ...(unknown ? [unknown] : []), primary, ...(sort === 'name' ? [] : ['asc_name']), 'id'];
}

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
  const labels = ['Type ２', 'Type 02', 'Type 10', 'PDF'];
  // For both fixture counts the folder/file and known/unknown file transitions
  // land exactly on page seams, with enough fully tied files to span pages.
  const unknownFrom = (count - 1) * 3 / 4;
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 5 === 0 && i < count - 1 ? 'folder' : 'file';
    const sizeUnknown = kind === 'folder' || i >= unknownFrom;
    // Keep the unknown count equal while separating the size and time order.
    const modifiedUnknown = i % 5 === 1 || i === count - 1;
    const zeroSize = i < 503 || i % 2 === 0;
    const zeroModified = i < 503 || i % 3 === 0;
    return {
      id: `entry-${String(i).padStart(5, '0')}`,
      kind,
      kindLabel: kind === 'folder' ? 'Folder' : labels[i < 503 ? i % 2 : i % labels.length],
      name: i < 503 ? tied[i % tied.length] : `${prefixes[i % prefixes.length]} ${count - i}`,
      size: sizeUnknown ? null : zeroSize ? 0 : 4096,
      modified: modifiedUnknown ? null : zeroModified ? 0 : 1_800_000_000_000,
    };
  });
}

// Dense ranks model already-materialized keys on an immutable synthetic
// dataset. They are not a key encoder: real writes cannot rely on these ranks.
function denseRanks(values) {
  const ordered = [...new Set(values)].sort(compareK2Names);
  let rank = 0;
  return new Map(ordered.map((value, i) => {
    if (i > 0 && compareK2Names(ordered[i - 1], value)) rank++;
    return [value, rank];
  }));
}

async function seed(db, entries) {
  const keys = ['folder_rank', 'asc_name', 'desc_name', 'size_unknown', 'asc_size', 'desc_size',
    'modified_unknown', 'asc_modified', 'desc_modified', 'asc_kind', 'desc_kind'];
  const indexes = sorts.flatMap((sort) => directions.map((direction) =>
    `CREATE INDEX k2_bench_${sort}_${direction} ON k2_bench (scope, ${seekColumns(sort, direction).join(', ')});`));
  const columns = ['scope TEXT NOT NULL', ...keys.map((key) => `${key} INTEGER NOT NULL`),
    'id TEXT NOT NULL COLLATE BINARY', 'name TEXT NOT NULL'];
  await db.exec(`DROP TABLE IF EXISTS k2_bench;
    CREATE TABLE k2_bench (${columns.join(', ')});
    ${indexes.join('\n')}`);
  const names = denseRanks(entries.map(({ name }) => name));
  const kinds = denseRanks(entries.map(({ kindLabel }) => kindLabel));
  const valuesFor = (scope, entry) => {
    const name = names.get(entry.name);
    const kind = kinds.get(entry.kindLabel);
    // Only the known primary key reverses, not the unknown bucket or tie keys.
    const size = entry.size ?? 0;
    const modified = entry.modified ?? 0;
    return [scope, folderRank(entry), name, -name, Number(entry.size === null), size, -size,
      Number(entry.modified === null), modified, -modified, kind, -kind, entry.id, entry.name];
  };
  const row = `(${Array(keys.length + 3).fill('?').join(', ')})`;
  const chunkSize = Math.floor(100 / (keys.length + 3)); // D1 bind limit.
  const statements = [db.prepare(`INSERT INTO k2_bench VALUES ${row}`).bind(...valuesFor('other', { ...entries[0], id: 'foreign' }))];
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    statements.push(db.prepare(`INSERT INTO k2_bench VALUES ${chunk.map(() => row).join(', ')}`)
      .bind(...chunk.flatMap((entry) => valuesFor('target', entry))));
  }
  for (let i = 0; i < statements.length; i += 16) await db.batch(statements.slice(i, i + 16));
}

async function traverse(db, entries, sort, direction) {
  const count = entries.length;
  const unknown = unknownColumn(sort);
  const columns = seekColumns(sort, direction);
  const tieColumns = columns.slice(0, -1);
  const tuple = columns.join(', ');
  const sql = `SELECT ${tuple}, name FROM k2_bench
    WHERE scope = ? AND (${tuple}) > (${columns.map(() => '?').join(', ')})
    ORDER BY ${tuple} LIMIT ${pageSize + 1}`;
  const query = db.prepare(sql);
  let boundary = ['target', -1, ...columns.slice(1, -1).map(() => 0), ''];
  const { results: plan } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...boundary).all();
  const detail = plan.map((row) => row.detail).join('\n');
  expect(detail).toMatch(new RegExp(`SEARCH k2_bench USING INDEX k2_bench_${sort}_${direction}.*folder_rank`));
  expect(detail).not.toContain('TEMP B-TREE');

  const expected = [...entries].sort((a, b) => compareK2Entries(a, b, sort, direction));
  const folderCount = (count - 1) / 5;
  const firstUnknownOffset = unknown ? 4 * folderCount : null;
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
      expect([last[unknown], lookahead?.[unknown]]).toEqual([0, 1]);
    }
    if (last.folder_rank === 1 && (!unknown || last[unknown] === 0) &&
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

it.each([5_001, 10_001])('benchmarks all indexed K2 sorts over %i synthetic entries in Worker/D1', async (count) => {
  const db = env.DB;
  const entries = fixture(count);
  await seed(db, entries);
  for (const sort of sorts) {
    for (const direction of directions) await traverse(db, entries, sort, direction);
  }
}, 30_000);
