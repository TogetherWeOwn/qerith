import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const directory = 'apps/drive/migrations/';
const shaPattern = /^[0-9a-f]{40}$/;

export function migrationLedger({ sha, runId, attempt, git }) {
  if (!shaPattern.test(sha) || !/^[1-9][0-9]*$/.test(runId) || !/^[1-9][0-9]*$/.test(attempt)) {
    throw new Error('invalid source or run provenance');
  }
  if (git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim() !== sha) {
    throw new Error('checkout SHA mismatch');
  }
  const entries = git(['ls-tree', '-rz', '--full-tree', sha, '--', directory]);
  if (!entries.length || entries[entries.length - 1] !== 0) throw new Error('missing or invalid migration tree');
  const records = entries.toString('utf8').slice(0, -1).split('\0');
  const migrations = records.map((record) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\tapps\/drive\/migrations\/([A-Za-z0-9][A-Za-z0-9_.-]*\.sql)$/.exec(record);
    if (!match) throw new Error('invalid tracked migration input');
    const digest = createHash('sha256').update(git(['cat-file', 'blob', match[2]])).digest('hex');
    return { name: match[3], digest };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return [
    '## Staging migration source inputs',
    '',
    'Admission: closed. This is not an applied-migration ledger or an execution order.',
    '',
    `Checkout SHA: ${sha}`,
    `Run ID: ${runId}`,
    `Attempt: ${attempt}`,
    '',
    ...migrations.map(({ name, digest }) => `- ${name}: ${digest}`),
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ledger = migrationLedger({
      sha: process.env.GITHUB_SHA ?? '',
      runId: process.env.GITHUB_RUN_ID ?? '',
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
      git: (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    });
    process.stdout.write(ledger);
  } catch {
    console.error('could not produce migration source ledger');
    process.exitCode = 1;
  }
}
