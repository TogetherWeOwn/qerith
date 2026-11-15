import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyEvidence(dir, tested) {
  const names = ['head.txt', ...['1280x800', '390x844'].flatMap(size =>
    [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`])];
  for (const name of names) {
    if (!(await stat(join(dir, name))).size) throw new Error(`Empty evidence: ${name}`);
  }
  if ((await readFile(join(dir, 'head.txt'), 'utf8')).trim() !== tested) {
    throw new Error('Evidence head does not match tested checkout');
  }
  for (const size of ['1280x800', '390x844']) {
    const png = await readFile(join(dir, `${size}.png`));
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error(`Invalid screenshot: ${size}`);
    }
    const axe = JSON.parse(await readFile(join(dir, `axe-${size}.json`), 'utf8'));
    const keyboard = JSON.parse(await readFile(join(dir, `keyboard-${size}.json`), 'utf8'));
    if (!Array.isArray(axe.violations) || axe.violations.length || !keyboard ||
        Array.isArray(keyboard) || typeof keyboard !== 'object' || !Object.keys(keyboard).length) {
      throw new Error(`Invalid axe or keyboard evidence: ${size}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EVIDENCE_DIR: dir, TESTED_SHA: tested, REQUESTED_HEAD: requestedHead,
    BASE_SHA: base, SNAPSHOT_SHA: snapshot, SNAPSHOT_BASE: snapshotBase, COMPATIBILITY_MODE: mode,
    GITHUB_WORKFLOW: workflow, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = process.env;
  if (![dir, tested, requestedHead, snapshot, mode, workflow, runId, runAttempt, server, repository].every(Boolean)) {
    throw new Error('Missing provenance context');
  }
  await verifyEvidence(dir, tested);
  await writeFile(join(dir, 'provenance.json'), JSON.stringify({ requestedHead, testedCheckout: tested,
    base: base || null, snapshotBase: snapshotBase || null, integrationSnapshot: snapshot, mode, workflow, runId, runAttempt,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    coverage: 'synthetic fixture only; not product behavior or sign-in' }, null, 2) + '\n');
}
