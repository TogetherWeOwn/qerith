import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrationLedger } from './staging-migrations.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-migrations-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  mkdirSync(join(cwd, 'apps/drive/migrations'), { recursive: true });
  const write = (name, content) => writeFileSync(join(cwd, 'apps/drive/migrations', name), content);
  const commit = () => {
    git(['add', '-A']);
    git(['commit', '-qm', 'fixture']);
    return git(['rev-parse', 'HEAD']).toString().trim();
  };
  const ledger = (sha, overrides = {}) => migrationLedger({ sha, runId: '123', attempt: '2', git, ...overrides });
  return { cwd, git, write, commit, ledger };
}

test('reports sorted committed bytes and provenance, ignoring worktree changes and untracked files', (t) => {
  const f = fixture(t);
  f.write('002.sql', 'second');
  f.write('001.sql', 'first');
  const sha = f.commit();
  const first = f.ledger(sha);
  f.write('001.sql', 'uncommitted');
  f.write('003.sql', 'untracked');
  assert.equal(f.ledger(sha), first);
  const digest = createHash('sha256').update('first').digest('hex');
  assert.match(first, new RegExp(`001\\.sql: ${digest}`));
  assert.ok(first.indexOf('001.sql') < first.indexOf('002.sql'));
  assert.doesNotMatch(first, /003\.sql|uncommitted|second/);
  assert.match(first, new RegExp(`Checkout SHA: ${sha}\\nRun ID: 123\\nAttempt: 2`));
  assert.match(first, /Admission: closed/);
  const changed = f.commit();
  assert.notEqual(changed, sha);
  assert.notEqual(f.ledger(changed), first);
  assert.throws(() => f.ledger(sha), /checkout SHA mismatch/);
});

test('fails closed for missing, invalid and non-regular tracked inputs', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'placeholder'), 'initial');
  let sha = f.commit();
  assert.throws(() => f.ledger(sha), /missing or invalid/);
  f.write('invalid name.sql', 'x');
  sha = f.commit();
  assert.throws(() => f.ledger(sha), /invalid tracked/);
});

test('rejects tracked symlinks and invalid provenance', (t) => {
  const f = fixture(t);
  symlinkSync('target', join(f.cwd, 'apps/drive/migrations/001.sql'));
  const sha = f.commit();
  assert.throws(() => f.ledger(sha), /invalid tracked/);
  for (const overrides of [{ runId: '0' }, { attempt: '1\n' }, { sha: 'HEAD' }]) {
    assert.throws(() => f.ledger(sha, overrides), /invalid source or run provenance/);
  }
});
