import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { baseLine, integrationBase, plan, testVerdict } from './pr-mutation.mjs';

function repository(t) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'pr-mutation-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Mutation fixture');
  const commit = (files) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    git('add', '--', ...Object.keys(files));
    git('commit', '--quiet', '-m', 'Synthetic change');
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

test('selection caps changed targets and excludes changes already on base', t => {
  const { dir, git, commit } = repository(t);
  const base = commit({ 'same.test.mjs': '// unchanged', 'other.md': 'original' });
  const unrelated = commit({ 'other.md': 'changed' });
  assert.deepEqual(plan(dir, base, unrelated).targets, []);
  const head = commit(Object.fromEntries(['e', 'a', 'd', 'b', 'c'].map(name => [`${name}.test.mjs`, '// new'])));
  const { targets, omitted } = plan(dir, base, head);
  assert.deepEqual(targets, ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs']);
  assert.deepEqual(omitted, ['e.test.mjs']);
  git('switch', '--quiet', '--detach', unrelated);
  const advanced = commit({ 'a.test.mjs': '// new' });
  git('merge', '--quiet', '--no-edit', head);
  git('update-ref', 'refs/remotes/origin/main', advanced);
  const snapshot = git('rev-parse', 'HEAD');
  const parent = integrationBase(dir, snapshot, unrelated, head, 'main');
  assert.equal(parent, advanced);
  assert.deepEqual(plan(dir, parent, snapshot).targets, ['b.test.mjs', 'c.test.mjs', 'd.test.mjs', 'e.test.mjs']);
});

test('only completed test runs give a mutant verdict', () => {
  const tap = '# pass 0\n# fail 1\n# cancelled 0\n';
  assert.equal(testVerdict({ status: 1, stdout: tap }, false), false);
  assert.equal(testVerdict({ status: 1, stdout: `  exitCode: 1\n${tap}` }, false), null);
  assert.equal(testVerdict({ status: 0, stdout: '# pass 0\n# cancelled 0\n' }, false), null);
});

test('zero-context hunks distinguish edited from shifted lines', () => {
  const diff = '@@ -2,0 +3 @@\n+added\n@@ -5,2 +5,0 @@\n-old\n-old\n@@ -8 +7 @@\n-old\n+edited\n';
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(line => baseLine(diff, line)),
    [1, 2, null, 3, 4, 7, null, 9]);
});

for (const runner of ['node:test', 'vitest']) test(`hosted Git diffs via ${runner}`, { skip: process.env.MUTATION_PROOF !== '1' }, async t => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const { dir, git, commit } = repository(t);
  const path = runner === 'vitest' ? 'apps/drive-test/test/' : '';
  const target = path + 'behavior.test.mjs', sourceModule = path + 'source.mjs';
  const module = 'export const existing = n => n >= 2;\nexport const legacy = n => n === 10;\n';
  const testFile = `import assert from 'node:assert/strict';\nimport { test } from '${runner}';\nimport { existing } from './source.mjs';\n`;
  const strong = "test('existing threshold', () => assert.equal(existing(2), true));\n";
  const base = commit({ [sourceModule]: module, [target]: testFile + strong });
  const baseline = join(dir, '.git', 'baseline');
  git('worktree', 'add', '--quiet', '--detach', baseline, base);
  mkdirSync(join(dir, 'apps/drive'), { recursive: true });
  const linkModules = (root, app) => symlinkSync(join(process.env.MUTATION_HEAD, app, 'node_modules'), join(root, app, 'node_modules'));
  linkModules(dir, 'apps/drive');
  if (runner === 'vitest') for (const root of [dir, baseline]) linkModules(root, 'apps/drive-test');
  const source = '// Shift existing operators.\n' + module + 'export const added = n => n <= 7;\n';
  const changedTest = testFile.replace('{ existing }', '{ existing, added }');
  const cli = fileURLToPath(new URL('./pr-mutation.mjs', import.meta.url));

  for (const [name, files, status, expected] of [
    ['strong new assertion', { [sourceModule]: source, [target]: changedTest +
      strong + "test('new threshold', () => assert.equal(added(7), true));\n" }, 0,
    ['"line":4,"from":"<=","to":"<","result":"killed"', '"result":"baseline survivor"']],
    ['weak new assertion', { [sourceModule]: source, [target]: changedTest +
      strong + "test('new type', () => assert.equal(typeof added(7), 'boolean'));\n" }, 1, ['"line":4', '1 new survivor(s)']],
    ['weakened existing assertion', { [target]: testFile +
      "test('existing type', () => assert.equal(typeof existing(2), 'boolean'));\n" }, 1, ['"line":1', '1 new survivor(s)']],
    ['unrelated diff', { 'other.md': 'unrelated' }, 0, ['0 target(s), 0 new survivor(s)']],
  ]) {
    await t.test(name, () => {
      git('switch', '--quiet', '--detach', base);
      const head = commit(files);
      const run = spawnSync(process.execPath, [cli, 'run', dir, base, head, baseline], { encoding: 'utf8' });
      console.log(`${runner}: ${name} (exit ${run.status}):\n${run.stdout}`);
      assert.equal(run.status, status, run.stderr);
      for (const fragment of expected) assert.ok(run.stdout.includes(fragment), fragment);
      assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
    });
  }
});
