import { isDeepStrictEqual } from 'node:util';
import { assertQualificationJob, qualificationFixtureNamespace, qualificationPrefix } from './staging-qualification.mjs';
import { readQualificationR2Prefix } from './staging-qualification-cleanup.mjs';
import {
  assertNoQualificationD1MigrationFixtures, assertQualificationD1Roster, readQualificationD1AppFixtures,
} from './staging-qualification-d1.mjs';
import { verifyQualificationR2Expiry } from './staging-qualification-expiry.mjs';
import { hasDuplicateMembers } from './staging-qualification-json.mjs';
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

async function boundedProviderDocument(response, reviver) {
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
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text, reviver);
  if (hasDuplicateMembers(text)) throw unverified();
  return { bytes, parsed };
}

// The native lifecycle endpoint is a single policy document, not a list API.
async function singleLifecycleDocument(response) {
  const { bytes, parsed } = await boundedProviderDocument(response);
  if (Object.hasOwn(parsed, 'result_info') || !Array.isArray(parsed.result?.rules) ||
      Object.keys(parsed.result).length !== 1) throw unverified();
  return new Response(bytes);
}

async function assertR2Roster(account, bucket, token, request, signal) {
  if (!token?.trim()) throw unverified();
  const pageSize = 10;
  await runQualificationPhase(async (_, active) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets?per_page=${pageSize}`;
    // Keep the headerless, name-unfiltered read, but don't rely on it for jurisdiction coverage.
    for (const jurisdiction of [null, 'default', 'eu', 'us', 'fedramp', 'fedramp-high']) {
      active.throwIfAborted();
      const expected = !jurisdiction || jurisdiction === 'default' ? 1 : 0;
      const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
        headers: { authorization: `Bearer ${token}`, ...(jurisdiction && { 'cf-r2-jurisdiction': jurisdiction }) } });
      if (response.headers.has('link')) {
        await response.body?.cancel();
        throw unverified();
      }
      const { parsed } = await boundedProviderDocument(response);
      const { success, errors, messages, result, result_info: page } = parsed;
      if (success !== true || !Array.isArray(errors) || errors.length ||
          (messages !== undefined && (!Array.isArray(messages) || messages.some(message => typeof message !== 'string'))) ||
          Object.keys(parsed).some(key => !['success', 'errors', 'messages', 'result', 'result_info'].includes(key)) ||
          !Array.isArray(result?.buckets) || Object.keys(result).length !== 1 || result.buckets.length !== expected ||
          (expected && (result.buckets[0]?.name !== bucket || result.buckets[0]?.jurisdiction !== 'default')) ||
          page?.total_count !== expected || (Object.hasOwn(page, 'per_page') && page.per_page !== pageSize) ||
          (Object.hasOwn(page, 'cursor') && page.cursor !== '') ||
          Object.keys(page).some(key => !['total_count', 'per_page', 'cursor'].includes(key))) throw unverified();
    }
  }, null, signal, 15_000);
}

// Shared for native page-number lists with an explicitly empty terminal page.
async function assertEmptyNativePage(account, path, token, request, signal, { pageSize = 10 } = {}) {
  if (!token?.trim()) throw unverified();
  await runQualificationPhase(async (_, active) => {
    // Queues uses the provider's default page size, as in pinned Wrangler.
    const query = pageSize === null ? 'page=1' : `page=1&per_page=${pageSize}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/${path}?${query}`;
    const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
      headers: { authorization: `Bearer ${token}` } });
    if (response.headers.has('link')) {
      await response.body?.cancel();
      throw unverified();
    }
    const { parsed } = await boundedProviderDocument(response, (_key, value, context) => {
      // Compare the original token so fractional or underflowed counts cannot
      // round to an allowed pagination integer.
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || context?.source !== String(value))) {
        throw unverified();
      }
      return value;
    });
    const { success, errors, messages, result, result_info: page } = parsed;
    const validPage = { page: [1], count: [0], total_count: [0], total_pages: [0, 1] };
    if (success !== true || !Array.isArray(errors) || errors.length || !Array.isArray(messages) || messages.length ||
        Object.keys(parsed).some(key => !['success', 'errors', 'messages', 'result', 'result_info'].includes(key)) ||
        !Array.isArray(result) || result.length || page?.total_count !== 0 ||
        Object.entries(page).some(([key, value]) => key === 'per_page'
          ? !Number.isSafeInteger(value) || value < 1 || (pageSize !== null && value !== pageSize)
          : !Object.hasOwn(validPage, key) || !validPage[key].includes(value))) {
      throw unverified();
    }
  }, null, signal, 5_000);
}

// Read the native list without filters; only a terminal response proves absence.
async function assertNoContainerApplications(account, token, request, signal) {
  if (!token?.trim()) throw unverified();
  await runQualificationPhase(async (_, active) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`;
    const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
      headers: { authorization: `Bearer ${token}` } });
    if (response.headers.has('link')) {
      await response.body?.cancel();
      throw unverified();
    }
    const { parsed } = await boundedProviderDocument(response);
    const { success, errors, messages, result, result_info: page } = parsed;
    if (success !== true || !Array.isArray(errors) || errors.length ||
        (Object.hasOwn(parsed, 'messages') && (!Array.isArray(messages) || messages.length)) ||
        Object.keys(parsed).some(key => !['success', 'errors', 'messages', 'result', 'result_info'].includes(key)) ||
        !Array.isArray(result) || result.length ||
        (Object.hasOwn(parsed, 'result_info') && (!page || typeof page !== 'object' || Array.isArray(page) ||
          Object.entries(page).some(([key, value]) => key !== 'next_page_token' || value !== '')))) throw unverified();
  }, null, signal, 5_000);
}

async function assertNoStreamInputs(account, token, request, signal) {
  if (!token?.trim()) throw unverified();
  await runQualificationPhase(async (_, active) => {
    // Ask for counts, but do not filter by status, name or cursor.
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/stream/live_inputs?include_counts=true`;
    const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
      headers: { authorization: `Bearer ${token}` } });
    if (response.headers.has('link')) {
      await response.body?.cancel();
      throw unverified();
    }
    const { parsed } = await boundedProviderDocument(response);
    const { success, errors, messages, result } = parsed;
    if (success !== true || !Array.isArray(errors) || errors.length || !Array.isArray(messages) || messages.length ||
        Object.keys(parsed).length !== 4 || !isDeepStrictEqual(result, { liveInputs: [], range: 0, total: 0 })) {
      throw unverified();
    }
  }, null, signal, 5_000);
}

// Offline composition. The estate reader must enumerate all resources within
// its bounded scope, verify native D1 compute mode, and drain on abort. The same
// reviewed, fully migrated D1 profile is required before and after the attempt.
export function createQualificationInventory(env, cwd, { readEstate, request, send } = {}) {
  if ([readEstate, request, send].some(read => typeof read !== 'function')) throw unverified();
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

        await assertQualificationD1Roster(env, cwd, active, request);
        active.throwIfAborted();
        matchScan(await readQualificationD1AppFixtures({ ...identity, account, database }, env, cwd, active, request), []);
        await assertNoQualificationD1MigrationFixtures(env, cwd, active, request);
        await assertEmptyNativePage(account, 'workers/durable_objects/namespaces', env.CLOUDFLARE_API_TOKEN, request, active);
        await assertNoContainerApplications(account, env.CLOUDFLARE_API_TOKEN, request, active);
        await assertNoStreamInputs(account, env.CLOUDFLARE_API_TOKEN, request, active);
        await assertEmptyNativePage(account, 'workflows', env.CLOUDFLARE_API_TOKEN, request, active);
        await assertEmptyNativePage(account, 'queues', env.CLOUDFLARE_API_TOKEN, request, active, { pageSize: null });
        await assertR2Roster(storageAccount, settings.bucket, env.CLOUDFLARE_API_TOKEN, request, active);
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
