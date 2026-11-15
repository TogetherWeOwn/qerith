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
  introducedBase = true, onMain = true, parents = `${base} ${head}` } = {}) {
  return (...args) => {
    if (args[0] === 'show') return parents;
    if (args[0] === 'ls-tree') return (args[2] === head ? hasHead : hasSnapshot) ? 'fixture' : '';
    if (args[0] === 'is-ancestor') return args[2] === 'origin/main' ? onMain : args[2] === head ? introducedHead : introducedBase;
    throw new Error('Unexpected git operation');
  };
}

test('legacy fixture selects the bound integration snapshot', () => {
  assert.deepEqual(selectCheckout(input, graph()), { tested: snapshot, mode: 'legacy-integration-fixture', snapshotBase: base });
});
test('fixture-bearing head remains exact-head', () => {
  assert.deepEqual(selectCheckout(input, graph({ hasHead: true })), { tested: head, mode: 'head', snapshotBase: base });
});
test('deleted fixture after introduction and missing snapshot fail closed', () => {
  assert.throws(() => selectCheckout(input, graph({ introducedHead: true })), /not eligible/);
  assert.throws(() => selectCheckout(input, graph({ hasSnapshot: false })), /missing the fixture/);
  assert.throws(() => selectCheckout(input, graph({ introducedBase: false })), /not eligible/);
});
test('main can move after the event base was recorded', () => {
  const movedBase = 'd'.repeat(40);
  assert.deepEqual(selectCheckout(input, graph({ parents: `${movedBase} ${head}` })),
    { tested: snapshot, mode: 'legacy-integration-fixture', snapshotBase: movedBase });
});
test('wrong parent count, head, main ancestry and mutable refs fail closed', () => {
  for (const parents of [`${head} ${base}`, `${base} ${'d'.repeat(40)}`, base, `${base} ${head} ${snapshot}`]) {
    assert.throws(() => selectCheckout(input, graph({ parents })), /does not bind/);
  }
  assert.throws(() => selectCheckout(input, graph({ onMain: false })), /does not bind/);
  assert.throws(() => selectCheckout(input, (...args) => {
    if (args[0] === 'is-ancestor') throw new Error('missing main ref');
    return graph()(...args);
  }), /missing main ref/);
  assert.throws(() => selectCheckout({ ...input, head: 'main' }, graph()), /immutable/);
  assert.throws(() => selectCheckout({ ...input, event: 'push' }, graph()), /must match/);
});
test('evidence fails when missing, empty or bound to the wrong checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
  try {
    const files = ['head.txt', ...['1280x800', '390x844'].flatMap(size =>
      [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`])];
    await assert.rejects(verifyEvidence(dir, head));
    for (const file of files) {
      const content = file === 'head.txt' ? head : file.endsWith('.png')
        ? Buffer.from('89504e470d0a1a0a', 'hex') : file.startsWith('axe-')
          ? '{"violations":[]}' : '{"tab":true}';
      await writeFile(join(dir, file), content);
    }
    await verifyEvidence(dir, head);
    await assert.rejects(verifyEvidence(dir, base), /does not match/);
    await writeFile(join(dir, 'axe-1280x800.json'), '{"violations":[{}]}');
    await assert.rejects(verifyEvidence(dir, head), /Invalid axe/);
    await writeFile(join(dir, 'axe-1280x800.json'), '{"violations":[]}');
    await writeFile(join(dir, 'keyboard-1280x800.json'), '{}');
    await assert.rejects(verifyEvidence(dir, head), /Invalid axe/);
    await writeFile(join(dir, 'keyboard-1280x800.json'), '{"tab":true}');
    await writeFile(join(dir, '390x844.png'), '');
    await assert.rejects(verifyEvidence(dir, head), /Empty evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
