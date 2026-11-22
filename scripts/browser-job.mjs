import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import registry from '../apps/drive/browser/scenarios.json' with { type: 'json' };
import { browserPath, generatedCommands, isolatedSchedule, planBrowser, verifyBrowserInventory, viewports } from './browser-registry.mjs';
import { verifyEvidence, verifyRoutedShareEvidence } from './browser-evidence.mjs';

const {
  BROWSER_GIT_DIR: gitDir, BROWSER_TESTED_DIR: testedDir, EVIDENCE_DIR: dir, TESTED_SHA: tested,
  REQUESTED_HEAD: requestedHead, BASE_SHA: base, SNAPSHOT_SHA: snapshot, SNAPSHOT_BASE: snapshotBase,
  BROWSER_POLICY_SHA: policy, COMPATIBILITY_MODE: mode, GITHUB_WORKFLOW: workflow, GITHUB_RUN_ID: runId,
  GITHUB_RUN_ATTEMPT: runAttempt, GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository,
} = process.env;

function git(...args) {
  return execFileSync('git', args, { cwd: gitDir, encoding: 'utf8' }).trimEnd();
}

function tree(revision, validateCoverage = false) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Expected immutable browser checkout SHA');
  const entries = git('ls-tree', '-rz', revision).split('\0').filter(Boolean);
  const paths = new Set();
  for (const entry of entries) {
    const path = entry.slice(entry.indexOf('\t') + 1);
    if (/^100(?:644|755) blob /.test(entry)) paths.add(path);
    else if (validateCoverage && path.startsWith(browserPath) && (path.endsWith('.mjs') || path === browserPath + 'scenarios.json')) {
      throw new Error(`Expected regular browser source: ${JSON.stringify(path)}`);
    }
  }
  return paths;
}

if (!gitDir || !tested || !requestedHead) throw new Error('Missing browser checkout context');
const exactHead = tested === requestedHead;
const command = process.argv[2];
const validateCoverage = command === 'coverage';
const paths = tree(tested, validateCoverage);
const proposedPath = browserPath + 'scenarios.json';

function readRegistration() {
  return paths.has(proposedPath) ? JSON.parse(git('show', `${tested}:${proposedPath}`)) : {};
}

if (command === 'isolated') {
  console.log(JSON.stringify(isolatedSchedule(paths, readRegistration())));
} else if (command === 'capture') {
  if (!testedDir || !dir || !exactHead) throw new Error('Generated browser fixtures require the exact requested head');
  for (const args of generatedCommands(paths, registry, exactHead)) {
    execFileSync('timeout', ['--signal=TERM', '--kill-after=10s', '90s', process.execPath, ...args], {
      cwd: join(testedDir, browserPath), stdio: 'inherit',
      env: { ...process.env, DRIVE_BROWSER_EVIDENCE_DIR: dir },
    });
  }
} else {
  if (![dir, snapshot, policy, mode, workflow, runId, runAttempt, server, repository].every(Boolean)) {
    throw new Error('Missing provenance context');
  }
  const proposed = validateCoverage && exactHead ? readRegistration() : {};
  const previousPaths = validateCoverage ? tree(git('merge-base', requestedHead, snapshotBase || policy)) : new Set();
  const options = { validateCoverage, previousPaths };
  const { checks, claimed } = planBrowser(paths, proposed, exactHead, registry, options);
  if (command === 'baseline') {
    await verifyEvidence(dir, tested, checks);
    for (const [id, check] of [['root-share', 'rootShare'], ['nested-share', 'nestedShare']]) {
      if (checks[check]) await verifyRoutedShareEvidence(dir, id, {
        states: registry[id].states, viewports: registry[id].widths.map(width => [width, viewports[width]]),
      });
    }
    const generated = checks.root ? 'generated sign-in and My Drive (disposable D1)' : 'generated sign-in (disposable D1)';
    const coverage = exactHead ? `synthetic fixture; ${generated}${checks.folder
      ? '; generated staging-origin SSR folder (opt-in, disposable D1)' : ''}` : 'synthetic fixture only; not product behavior or sign-in';
    await writeFile(join(dir, 'provenance.json'), JSON.stringify({ requestedHead, testedCheckout: tested, base: base || null,
      snapshotBase: snapshotBase || null, integrationSnapshot: snapshot, policy, mode, workflow, runId, runAttempt,
      runUrl: `${server}/${repository}/actions/runs/${runId}`, coverage }, null, 2) + '\n');
  } else if (command === 'coverage') {
    const proof = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8'));
    if (proof.requestedHead !== requestedHead || proof.testedCheckout !== tested || proof.integrationSnapshot !== snapshot ||
        proof.mode !== mode || proof.policy !== policy || proof.runId !== runId) throw new Error('Evidence provenance does not match browser job');
    claimed.set('provenance.json', null);
    await verifyBrowserInventory(dir, claimed);
  } else {
    throw new Error('Expected isolated, capture, baseline, or coverage');
  }
}
