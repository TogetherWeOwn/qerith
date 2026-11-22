import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { baseLine, isNewSurvivor, plan } from './pr-mutation.mjs';

function repository(t) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'pr-mutation-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Mutation fixture');
  const commit = (files) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'Synthetic change');
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

test('selection caps changed test targets and orders them by path', t => {
  const { dir, commit } = repository(t);
  const base = commit({ 'same.test.mjs': '// unchanged', 'other.md': 'original' });
  const unrelated = commit({ 'other.md': 'changed' });
  assert.deepEqual(plan(dir, base, unrelated).targets, []);
  const head = commit(Object.fromEntries(['e', 'a', 'd', 'b', 'c'].map(name => [`${name}.test.mjs`, '// new'])));
  const { targets, omitted } = plan(dir, base, head);
  assert.deepEqual(targets, ['a.test.mjs', 'b.test.mjs', 'c.test.mjs', 'd.test.mjs']);
  assert.deepEqual(omitted, ['e.test.mjs']);
});

test('only surviving mutants without a matching survivor in base fail', () => {
  assert.deepEqual([isNewSurvivor(false, false), isNewSurvivor(true, false), isNewSurvivor(true, true)],
    [false, true, false]);
});

test('zero-context hunks distinguish edited from shifted lines', () => {
  const diff = '@@ -2,0 +3 @@\n+added\n@@ -5,2 +5,0 @@\n-old\n-old\n@@ -8 +7 @@\n-old\n+edited\n';
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(line => baseLine(diff, line)),
    [1, 2, null, 3, 4, 7, null, 9]);
});

test('hosted Git diffs exercise the mutation verdict', { skip: process.env.MUTATION_PROOF !== '1' }, async t => {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  const { dir, git, commit } = repository(t);
  const module = 'export const existing = n => n >= 2;\nexport const legacy = n => n === 10;\n';
  const testFile = "import assert from 'node:assert/strict';\nimport { existing } from './source.mjs';\n";
  const base = commit({ 'source.mjs': module, 'behavior.test.mjs': testFile + 'assert.equal(existing(2), true);\n' });
  const baseline = join(dir, '.git', 'baseline');
  git('worktree', 'add', '--quiet', '--detach', baseline, base);
  const parser = 'apps/drive/node_modules/typescript';
  writeFileSync(join(dir, '.git/info/exclude'), '/apps/drive/node_modules/\n');
  mkdirSync(join(dir, 'apps/drive/node_modules'), { recursive: true });
  symlinkSync(join(process.env.MUTATION_HEAD, parser), join(dir, parser));
  const source = '// Shift existing operators.\n' + module + 'export const added = n => n <= 7;\n';
  const changedTest = testFile.replace('{ existing }', '{ existing, added }');
  const cli = fileURLToPath(new URL('./pr-mutation.mjs', import.meta.url));

  for (const [name, files, status, expected] of [
    ['strong new assertion', { 'source.mjs': source, 'behavior.test.mjs': changedTest +
      'assert.equal(existing(2), true);\nassert.equal(added(7), true);\n' }, 0,
    ['"line":4,"from":"<=","to":"<","result":"killed"', '"result":"baseline survivor"']],
    ['weak new assertion', { 'source.mjs': source, 'behavior.test.mjs': changedTest +
      "assert.equal(existing(2), true);\nassert.equal(typeof added(7), 'boolean');\n" }, 1, ['"line":4', '1 new survivor(s)']],
    ['weakened existing assertion', { 'behavior.test.mjs': testFile +
      "assert.equal(typeof existing(2), 'boolean');\n" }, 1, ['"line":1', '1 new survivor(s)']],
    ['unrelated diff', { 'other.md': 'unrelated' }, 0, ['0 target(s), 0 new survivor(s)']],
  ]) {
    await t.test(name, () => {
      git('switch', '--quiet', '--detach', base);
      const head = commit(files);
      const run = spawnSync(process.execPath, [cli, 'run', dir, base, head, baseline], { encoding: 'utf8' });
      console.log(`${name} (exit ${run.status}):\n${run.stdout}`);
      assert.equal(run.status, status, run.stderr);
      for (const fragment of expected) assert.ok(run.stdout.includes(fragment), fragment);
      assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
    });
  }
});
