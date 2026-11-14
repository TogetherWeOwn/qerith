import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyLock } from '../scripts/verify-lock-age.mjs';

const now = Date.parse('2026-11-14T00:00:00Z');
const lock = () => ({
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/example': {
      version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-example'
    }
  }
});
const metadata = () => ({
  name: 'example', time: { '1.0.0': '2026-11-11T00:00:00Z' },
  versions: { '1.0.0': { dist: { integrity: 'sha512-example' } } }
});

test('accepts a matching package at the minimum age', async () => {
  assert.equal(await verifyLock(lock(), async () => metadata(), now), 1);
});

test('rejects recent, missing and mismatched publication metadata', async () => {
  for (const change of [
    (m) => { m.time['1.0.0'] = '2026-11-11T00:00:00.001Z'; },
    (m) => { delete m.time['1.0.0']; },
    (m) => { m.versions['1.0.0'].dist.integrity = 'sha512-other'; },
    (m) => { m.name = 'other'; }
  ]) {
    const m = metadata();
    change(m);
    await assert.rejects(verifyLock(lock(), async () => m, now));
  }
});

test('rejects non-registry sources and metadata failures', async () => {
  const l = lock();
  l.packages['node_modules/example'].resolved = 'https://example.com/example.tgz';
  await assert.rejects(verifyLock(l, async () => metadata(), now));
  await assert.rejects(verifyLock(lock(), async () => { throw new Error('unavailable'); }, now));
  await assert.rejects(verifyLock({ lockfileVersion: 3, packages: { '': {} } }, async () => metadata(), now));
});
