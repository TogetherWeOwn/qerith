import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateName } from '../src/lib/entry-name.ts';
import { compareK2Entries, compareK2Names } from '../src/lib/server/metadata/k2-order.ts';

type Entry = Parameters<typeof compareK2Entries>[0];
const file = (id: string, name: string, fields: Partial<Entry> = {}): Entry =>
  ({ id, name, kind: 'file', kindLabel: 'File', size: null, modified: null, ...fields });

const directions = ['asc', 'desc'] as const;
const sorts = ['name', 'size', 'modified', 'kind'] as const;
const ids = (rows: Entry[], sort: typeof sorts[number], direction: typeof directions[number]) =>
  [...rows].sort((a, b) => compareK2Entries(a, b, sort, direction)).map((row) => row.id);

test('English numeric collation handles Unicode digits, long numbers and NFC without folding case or punctuation', () => {
  assert.ok(compareK2Names('file 2', 'file 10') < 0);
  assert.equal(compareK2Names('file ٢', 'file 002'), 0);
  const shorter = '9'.repeat(254), longer = `1${'0'.repeat(254)}`, next = `${longer.slice(0, -1)}1`;
  [shorter, longer, next].forEach(validateName);
  assert.ok(compareK2Names(shorter, longer) < 0);
  assert.ok(compareK2Names(longer, next) < 0);
  assert.equal(compareK2Names(`${'٠'.repeat(127)}1`, '1'), 0);
  assert.equal(compareK2Names('📁 café 2', '📁 café 02'), 0);
  assert.notEqual(compareK2Names('café', 'cafe'), 0);
  assert.notEqual(compareK2Names('File', 'file'), 0);
  assert.notEqual(compareK2Names('file-2', 'file 2'), 0);
});

test('orders multiple numeric runs and uses stable IDs for equivalent spellings', () => {
  const rows = [file('b', 'café ０２ item ٢'), file('first', 'café 1 item 99'), file('last', 'café 10 item 1'),
    file('next', 'café 2 item 10'), file('a', 'café 2 item 02')];
  assert.deepEqual(ids(rows, 'name', 'asc'), ['first', 'a', 'b', 'next', 'last']);
  assert.deepEqual(ids(rows.reverse(), 'name', 'desc'), ['last', 'next', 'a', 'b', 'first']);
});

test('uses ascending binary IDs for collation ties, even in descending order', () => {
  const rows = [file('𐀀', 'café 002'), file('later', 'café 10'), file('', 'café 2'),
    file('a\0b', 'café 2'), file('a', 'café 02')];
  const tied = ['a', 'a\0b', '', '𐀀'];
  assert.deepEqual(ids(rows, 'name', 'asc'), [...tied, 'later']);
  assert.deepEqual(ids(rows, 'name', 'desc'), ['later', ...tied]);
});

test('folders stay first across all sorts and directions; folder size is never a file length', () => {
  const folders = [file('f10', 'folder 10', { kind: 'folder', kindLabel: 'Folder', size: 1 }),
    file('f2', 'folder 2', { kind: 'folder', kindLabel: 'Folder', size: 100 })];
  const rows = [file('file', 'a', { size: 0, modified: 1 }), ...folders];
  for (const sort of sorts) {
    for (const direction of directions) assert.equal(ids(rows, sort, direction).at(-1), 'file');
  }
  for (const direction of directions) assert.deepEqual(ids(rows, 'size', direction), ['f2', 'f10', 'file']);
});

test('metadata sorts keep unknowns last and tie by ascending name then ID', () => {
  const rows = [file('unknown', 'a'), file('zero', 'z', { size: 0, modified: 0 }),
    file('b', 'file 2', { size: 8, modified: 8 }), file('a', 'file 02', { size: 8, modified: 8 }),
    file('ten', 'file 10', { size: 8, modified: 8 })];
  for (const sort of ['size', 'modified'] as const) {
    assert.deepEqual(ids(rows, sort, 'asc'), ['zero', 'a', 'b', 'ten', 'unknown']);
    assert.deepEqual(ids(rows, sort, 'desc'), ['a', 'b', 'ten', 'zero', 'unknown']);
  }
  const kinds = [file('pdf10', 'file 10', { kindLabel: 'PDF' }), file('file', 'z'),
    file('pdf2', 'file 2', { kindLabel: 'PDF' })];
  assert.deepEqual(ids(kinds, 'kind', 'asc'), ['file', 'pdf2', 'pdf10']);
  assert.deepEqual(ids(kinds, 'kind', 'desc'), ['pdf2', 'pdf10', 'file']);
});
