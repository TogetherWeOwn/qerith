// Reference comparator for K2 conformance. Intl does not expose portable sort
// keys. Do not use this to sort individual pages or to generate persisted keys.
const collator = new Intl.Collator('en', {
  usage: 'sort', numeric: true, sensitivity: 'variant', caseFirst: 'false', ignorePunctuation: false,
});
const utf8 = new TextEncoder();

type Sort = 'name' | 'size' | 'modified' | 'kind';
type Direction = 'asc' | 'desc';
type Entry = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  kindLabel: string;
  size: number | null;
  modified: number | null;
};

export function compareK2Names(a: string, b: string): number {
  return collator.compare(a.normalize('NFC'), b.normalize('NFC'));
}

// Ordinal UTF-8 order matches SQLite BINARY for stored IDs, including IDs
// containing supplementary code points (where UTF-16 string order differs).
function compareIds(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function compareK2Entries(a: Entry, b: Entry, sort: Sort, direction: Direction): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  const order = direction === 'asc' ? 1 : -1;
  if (sort === 'name') return order * compareK2Names(a.name, b.name) || compareIds(a.id, b.id);
  if (sort === 'kind') {
    const comparison = compareK2Names(a.kindLabel, b.kindLabel);
    if (comparison) return order * comparison;
  } else if (sort !== 'size' || a.kind === 'file') {
    const left = a[sort];
    const right = b[sort];
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? -order : order;
    }
  }
  return compareK2Names(a.name, b.name) || compareIds(a.id, b.id);
}
