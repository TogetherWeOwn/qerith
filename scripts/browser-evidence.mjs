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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EVIDENCE_DIR: dir, TESTED_SHA: tested, REQUESTED_HEAD: requestedHead,
    BASE_SHA: base, SNAPSHOT_SHA: snapshot, COMPATIBILITY_MODE: mode,
    GITHUB_WORKFLOW: workflow, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = process.env;
  if (![dir, tested, requestedHead, snapshot, mode, workflow, runId, runAttempt, server, repository].every(Boolean)) {
    throw new Error('Missing provenance context');
  }
  await verifyEvidence(dir, tested);
  await writeFile(join(dir, 'provenance.json'), JSON.stringify({ requestedHead, testedCheckout: tested,
    base: base || null, integrationSnapshot: snapshot, mode, workflow, runId, runAttempt,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    coverage: 'synthetic fixture only; not product behavior or sign-in' }, null, 2) + '\n');
}
