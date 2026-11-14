import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { synthesizeIntegration } from './synthesize-browser-integration.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const commit = 'd'.repeat(40);

function fakeGit({ mergeOutput = tree, parents = `${base} ${head}`, secondTree = tree } = {}) {
  let merges = 0;
  return (args, input) => {
    if (args[0] === 'rev-parse') return args[2].slice(0, 40);
    if (args[0] === 'merge-tree') return ++merges === 1 ? mergeOutput : secondTree;
    if (args[0] === 'hash-object') {
      assert.match(input, new RegExp(`^tree ${tree}\\nparent ${base}\\nparent ${head}\\n`));
      return commit;
    }
    if (args[0] === 'show') return `${tree}\n${parents}\n`;
    throw new Error('Unexpected Git command');
  };
}

test('constructs and verifies an ordered immutable integration object', () => {
  assert.deepEqual(synthesizeIntegration(base, head, fakeGit()), { tree, commit });
});

test('rejects invalid inputs, ambiguous merge output, wrong parents and tree drift', () => {
  assert.throws(() => synthesizeIntegration('main', head, fakeGit()), /immutable/);
  assert.throws(() => synthesizeIntegration(base, head, fakeGit({ mergeOutput: `${tree}\nconflict` })), /clean tree/);
  assert.throws(() => synthesizeIntegration(base, head, fakeGit({ parents: `${head} ${base}` })), /identity mismatch/);
  assert.throws(() => synthesizeIntegration(base, head, fakeGit({ secondTree: 'e'.repeat(40) })), /differs/);
});
