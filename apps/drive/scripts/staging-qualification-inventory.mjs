import { isDeepStrictEqual } from 'node:util';
import { assertQualificationJob, qualificationFixtureNamespace, qualificationPrefix } from './staging-qualification.mjs';
import { readQualificationR2Prefix } from './staging-qualification-cleanup.mjs';
import { assertNoQualificationD1MigrationFixtures } from './staging-qualification-d1.mjs';
import { verifyQualificationR2Expiry } from './staging-qualification-expiry.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';
import { inspectQualificationWorker, runQualificationPhase, stagingConfigAt } from './staging-qualification-worker.mjs';

// No such compute is approved by the committed staging config.
const absent = ['containers', 'durableObjects', 'alarms', 'scheduledWorkers', 'streamInputs', 'otherCompute'];
const unverified = () => new Error('Qualification estate inventory is unverified.');

function matchScan(scan, expected) {
  // The reader may drain pages within its budget, but must not normalize an
  // incomplete or denied list into an empty scan. No pagination fields remain.
  if (scan?.complete !== true || Object.keys(scan).length !== 2 || !Array.isArray(scan.items) ||
      scan.items.length !== expected.length || !isDeepStrictEqual(scan.items, expected)) throw unverified();
}

// The native lifecycle endpoint is a single policy document, not a list API.
// Reject a partial document before handing it to the existing rule validator.
async function singleLifecycleDocument(response) {
  if (response.status !== 200 || response.headers.has('content-range') || !response.body) {
    await response.body?.cancel();
    throw unverified();
  }
  const buffer = Buffer.alloc(65_536);
  let size = 0;
  for await (const chunk of response.body) {
    if (size + chunk.byteLength > buffer.length) throw unverified();
    buffer.set(chunk, size);
    size += chunk.byteLength;
  }
  const bytes = buffer.subarray(0, size);
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (Object.hasOwn(parsed, 'result_info') || !Array.isArray(parsed.result?.rules) ||
      Object.keys(parsed.result).length !== 1) throw unverified();
  return new Response(bytes);
}

// Unwired. The eventual readers must enumerate the bounded staging estate,
// not filter discovery to expected IDs, and verify D1 is natively on-demand
// (no provisioned compute). readFixtures must cover all staging fixture tags
// in the pinned D1, not just the current attempt or a subset of tables. Both
// readers must bound responses, honor abort and drain before settling.
// This is an observation, not a writer fence, rollback proof or billing audit.
export function createQualificationInventory(env, cwd, { readEstate, readFixtures, request, send } = {}) {
  if ([readEstate, readFixtures, request, send].some(read => typeof read !== 'function')) throw unverified();
  env = { ...env };
  const identity = assertQualificationJob(env, cwd);
  const prefix = qualificationPrefix(identity);
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const { name: worker, d1_databases: [{ database_id: database }] } = stagingConfigAt(cwd, identity.sha, account);
  let nextPhase = 'before', baseline;

  return async (context, signal) => {
    const { phase } = context ?? {};
    if (!nextPhase || phase !== nextPhase || context.prefix !== prefix ||
        Object.keys(identity).some(key => context[key] !== identity[key])) throw unverified();
    nextPhase = null; // No overlapping reads, retries or replacement baseline within this attempt.
    try {
      const observed = await runQualificationPhase(async (_, active) => {
        const { account: storageAccount, settings } = await readQualificationR2Binding(env, cwd, identity.sha);
        const { createS3Listing } = await import('../src/lib/server/s3/listing.ts');
        active.throwIfAborted();
        const estate = await readEstate({ account, storageAccount }, active);
        const expected = { workers: [{ name: worker }], databases: [{ id: database, compute: 'on-demand' }],
          buckets: [{ account: storageAccount, name: settings.bucket }],
          ...Object.fromEntries(absent.map(kind => [kind, []])) };
        if (!estate || Object.keys(estate).length !== Object.keys(expected).length) throw unverified();
        for (const [kind, items] of Object.entries(expected)) matchScan(estate[kind], items);

        active.throwIfAborted();
        matchScan(await readFixtures({ account, database }, active), []);
        await assertNoQualificationD1MigrationFixtures(env, cwd, active, request);
        await verifyQualificationR2Expiry(env, cwd, active, async (...args) => singleLifecycleDocument(await request(...args)));
        // Check all full-v0 fixture attempts. The separate recovery-record and
        // storage-proof namespaces have their own retention/cleanup policies.
        const { keys, uploads } = await readQualificationR2Prefix(qualificationFixtureNamespace, active,
          createS3Listing(settings, { fetch: send, timeoutMs: 8_000 }));
        if (keys.length || uploads.length) throw unverified();
        return inspectQualificationWorker(env, cwd, active, request);
      }, null, signal, 55_000);
      if (phase === 'before') {
        if (observed.attemptRestore) throw unverified();
        baseline = observed;
        nextPhase = 'after';
      } else if (observed.version !== baseline.version ||
          (observed.deployment !== baseline.deployment && !observed.attemptRestore)) {
        throw unverified();
      }
      return true;
    } catch {
      // Do not emit provider identities, fixture rows, or diagnostics.
      throw unverified();
    }
  };
}
