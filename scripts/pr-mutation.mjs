import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

const targetLimit = 4;
const mutantLimit = 4;
const replacements = new Map([
  ['===', '!=='], ['!==', '==='], ['<', '<='], ['<=', '<'], ['>', '>='], ['>=', '>'],
]);
const isTest = path => path.endsWith('.test.mjs') && path !== 'scripts/pr-mutation.test.mjs';
const isWorkers = path => path.startsWith('apps/drive-test/test/');
const isDrive = path => path.startsWith('apps/drive/');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

export function plan(root, base, head) {
  const fields = git(root, ['diff', '--name-status', '-z', '-M', '--diff-filter=AMR', base, head]).split('\0');
  const changes = new Map();
  for (let i = 0; i < fields.length - 1;) {
    const status = fields[i++];
    const path = fields[i++];
    if (status.startsWith('R')) changes.set(fields[i++], path);
    else changes.set(path, status === 'A' ? null : path);
  }
  const targets = [...changes.keys()].filter(isTest).sort();
  return { changes, targets: targets.slice(0, targetLimit), omitted: targets.slice(targetLimit) };
}

// Map an unchanged head line to its base line through zero-context diff hunks.
export function baseLine(diff, line) {
  let offset = 0;
  for (const [, oldStart, oldLength = '1', newStart, newLength = '1'] of
    diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const end = Number(newStart) + Number(newLength);
    if (line < Number(newStart) || (newLength === '0' && line === Number(newStart))) break;
    if (line < end) return null;
    offset = Number(oldStart) + Number(oldLength) - end + Number(oldLength === '0') - Number(newLength === '0');
  }
  return line + offset;
}

function source(root, path) {
  const absolute = join(root, path);
  if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile() || realpathSync(absolute) !== absolute) return null;
  return readFileSync(absolute, 'utf8');
}

function imports(ts, root, path) {
  const text = source(root, path);
  if (text === null) return new Set();
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  return new Set(tree.statements.filter(node => ts.isImportDeclaration(node) &&
    !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier))
    .map(node => node.moduleSpecifier.text)
    .filter(name => /^\.\.?\//.test(name))
    .map(name => posix.join(posix.dirname(path), name))
    .filter(name => /^(?:[\w@.+ -]+\/)*[\w@.+ -]+\.(?:mjs|js|ts)$/.test(name) &&
      !name.startsWith('../') && !/(^|\/)(?:node_modules|fixtures|\.svelte-kit)(?:\/|$)|\.(?:test|spec|d)\.[^.]+$/.test(name)));
}

function operators(ts, path, text) {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const result = [];
  function visit(node) {
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const start = token.getStart(tree);
      const original = token.getText(tree);
      if (replacements.has(original)) {
        const { line, character } = tree.getLineAndCharacterOfPosition(start);
        result.push({ start, line: line + 1, character, original, replacement: replacements.get(original) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result.sort((a, b) => a.start - b.start);
}

function candidates(ts, root, baseline, base, head, target, changes, tracked) {
  const oldTarget = changes.get(target);
  const oldImports = oldTarget ? imports(ts, baseline, oldTarget) : new Set();
  const modified = [], comparable = [];
  for (const path of [...imports(ts, root, target)].sort()) {
    if (!tracked.has(path)) continue;
    const text = source(root, path);
    if (text === null) continue;
    const oldPath = changes.has(path) ? changes.get(path) : path;
    const paths = path === oldPath || !oldPath ? [path] : [oldPath, path];
    const diff = changes.has(path)
      ? git(root, ['diff', '--no-ext-diff', '--no-textconv', '-U0', '-M', base, head, '--',
        ...paths.map(name => `:(literal)${name}`)])
      : '';
    const oldText = oldImports.has(oldPath) ? source(baseline, oldPath) : null;
    const oldOperators = oldText === null ? [] : operators(ts, oldPath, oldText);
    for (const mut of operators(ts, path, text)) {
      const candidate = { ...mut, path, text };
      const line = oldPath ? baseLine(diff, mut.line) : null;
      if (line === null) modified.push(candidate);
      else {
        const old = oldOperators.find(op => op.line === line && op.character === mut.character && op.original === mut.original);
        if (old) comparable.push({ ...candidate, old: { ...old, path: oldPath, text: oldText } });
      }
    }
  }
  return [...modified, ...comparable];
}

export function testVerdict({ status, stdout }, workers, file) {
  if (status !== 0 && status !== 1) return null;
  if (workers) {
    const report = stdout.split('\n').find(line => line.startsWith('{"numTotalTestSuites":'));
    const result = report && JSON.parse(report);
    if (result?.testResults?.length !== 1 || result.testResults[0].name !== file || result.testResults[0].message) return null;
    if (status === 0 && result.numPassedTests > 0 && result.success) return true;
    if (status === 1 && result.numFailedTests > 0) return false;
  } else if (/^# cancelled 0$/m.test(stdout) && !/^ +(?:exitCode|signal):/m.test(stdout)) {
    if (status === 0 && /^# pass [1-9]\d*$/m.test(stdout)) return true;
    if (status === 1 && /^# fail [1-9]\d*$/m.test(stdout)) return false;
  }
  return null;
}

function runTest(root, target, clean) {
  const cwd = isWorkers(target) ? join(root, 'apps/drive-test') : isDrive(target) ? join(root, 'apps/drive') : root;
  const file = join(root, target);
  const args = isWorkers(target)
    ? ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--reporter=json', file]
    : [...(isDrive(target) ? ['--import', 'tsx'] : []), '--test', '--test-reporter=tap', file];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (target === 'apps/drive/scripts/staging-qualification-migrations.test.mjs') env.DRIVE_QUALIFICATION_WRANGLER_LOCAL = '1';
  const run = spawnSync('timeout', ['--kill-after=2s', '30s', process.execPath, ...args],
    { cwd, env, encoding: 'utf8', maxBuffer: 2 ** 20 });
  const verdict = testVerdict(run, isWorkers(target), file);
  if (verdict === true || (!clean && verdict === false)) return verdict;
  throw new Error(`Test execution failed for ${target} (exit ${run.status}): ${JSON.stringify((run.stdout + run.stderr).slice(-2000))}`);
}

function survives(root, target, mutant) {
  const { path, text, start, original, replacement } = mutant;
  const file = join(root, path);
  writeFileSync(file, text.slice(0, start) + replacement + text.slice(start + original.length));
  try {
    return runTest(root, target, false);
  } finally {
    writeFileSync(file, text);
  }
}

export function audit(ts, root, baseline, base, head) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Mutation execution requires GitHub Actions');
  const { changes, targets, omitted } = plan(root, base, head);
  const tracked = new Set(git(root, ['ls-files', '-z']).split('\0'));
  if (omitted.length) console.log('Targets beyond the cap:', JSON.stringify(omitted));
  let newSurvivors = 0;
  for (const target of targets) {
    const eligible = candidates(ts, root, baseline, base, head, target, changes, tracked);
    const oldTarget = changes.get(target);
    console.log(JSON.stringify({ target, eligible: eligible.length, sampled: Math.min(eligible.length, mutantLimit) }));
    if (!eligible.length) continue;
    runTest(root, target, true);
    let baselineChecked = false;
    for (const mutant of eligible.slice(0, mutantLimit)) {
      const headSurvives = survives(root, target, mutant);
      let baseSurvives = false;
      if (headSurvives && mutant.old) {
        if (!baselineChecked) runTest(baseline, oldTarget, true);
        baselineChecked = true;
        baseSurvives = survives(baseline, oldTarget, mutant.old);
      }
      const isNew = headSurvives && !baseSurvives;
      if (isNew) newSurvivors++;
      console.log(JSON.stringify({ target, source: mutant.path, line: mutant.line, from: mutant.original,
        to: mutant.replacement, result: isNew ? 'new survivor' : headSurvives ? 'baseline survivor' : 'killed' }));
    }
  }
  console.log(`Mutation pass: ${targets.length} target(s), ${newSurvivors} new survivor(s)`);
  return newSurvivors;
}

if (import.meta.main) {
  const [mode, root, base, head, baseline] = process.argv.slice(2);
  if (mode === 'plan') {
    const { changes, targets } = plan(root, base, head);
    const proof = ['scripts/pr-mutation.mjs', 'scripts/pr-mutation.test.mjs'].some(path => changes.has(path));
    console.log([targets.length, targets.some(isWorkers) ? 1 : 0,
      targets.some(path => isWorkers(path) || isDrive(path)) ? 1 : 0, proof ? 1 : 0].join(' '));
  } else if (mode === 'run') {
    const ts = await import(join(root, 'apps/drive/node_modules/typescript/lib/typescript.js'));
    process.exitCode = Number(audit(ts.default, root, baseline, base, head) > 0);
  } else {
    throw new Error('Expected mutation plan or run');
  }
}
