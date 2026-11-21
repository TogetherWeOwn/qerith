import { pathToFileURL } from 'node:url';
import { assertQualificationJob } from './staging-qualification.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';
import { stagingConfigAt } from './staging-qualification-worker.mjs';

// Compare protected settings against the dispatch commit without provider I/O.
export async function assertQualificationSettings(env, cwd) {
  const { sha } = assertQualificationJob(env, cwd);
  try {
    stagingConfigAt(cwd, sha, env.CLOUDFLARE_ACCOUNT_ID);
    await readQualificationR2Binding(env, cwd, sha);
  } catch {
    // No raw subprocess errors or binding details in the Actions log.
    throw new Error('Protected staging target or reviewed storage binding is unverified.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await assertQualificationSettings(process.env, process.cwd());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
