import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyEvidence } from './browser-evidence.mjs';
import { selectCheckout } from './select-browser-checkout.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), snapshot = 'c'.repeat(40);
const input = { event: 'pull_request', head, base, snapshot };
function graph({ hasHead = false, hasSnapshot = true, introducedHead = false,
  introducedBase = true, parents = `${base} ${head}` } = {}) {
  return (...args) => {
    if (args[0] === 'show') return parents;
    if (args[0] === 'ls-tree') return (args[2] === head ? hasHead : hasSnapshot) ? 'fixture' : '';
    if (args[0] === 'is-ancestor') return args[2] === head ? introducedHead : introducedBase;
    throw new Error('Unexpected git operation');
  };
}

test('legacy fixture selects the bound integration snapshot', () => {
  assert.deepEqual(selectCheckout(input, graph()), { tested: snapshot, mode: 'legacy-integration-fixture' });
});
test('fixture-bearing head remains exact-head', () => {
  assert.deepEqual(selectCheckout(input, graph({ hasHead: true })), { tested: head, mode: 'head' });
});
test('deleted fixture after introduction and missing snapshot fail closed', () => {
  assert.throws(() => selectCheckout(input, graph({ introducedHead: true })), /not eligible/);
  assert.throws(() => selectCheckout(input, graph({ hasSnapshot: false })), /missing the fixture/);
  assert.throws(() => selectCheckout(input, graph({ introducedBase: false })), /not eligible/);
});
test('mismatched snapshot, base, head and mutable refs fail closed', () => {
  for (const parents of [`${head} ${base}`, `${base} ${'d'.repeat(40)}`, base]) {
    assert.throws(() => selectCheckout(input, graph({ parents })), /does not bind/);
  }
  assert.throws(() => selectCheckout({ ...input, head: 'main' }, graph()), /immutable/);
  assert.throws(() => selectCheckout({ ...input, event: 'push' }, graph()), /must match/);
});
test('evidence fails when missing, empty or bound to the wrong checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
  try {
    const files = ['head.txt', ...['1280x800', '390x844'].flatMap(size =>
      [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`])];
    await assert.rejects(verifyEvidence(dir, head));
    for (const file of files) await writeFile(join(dir, file), file === 'head.txt' ? head : 'x');
    await verifyEvidence(dir, head);
    await assert.rejects(verifyEvidence(dir, base), /does not match/);
    await writeFile(join(dir, '390x844.png'), '');
    await assert.rejects(verifyEvidence(dir, head), /Empty evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
