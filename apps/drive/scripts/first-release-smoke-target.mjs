import { createHash } from 'node:crypto';
import { readBoundedBody } from '../src/lib/server/bounded-io.ts';
import { firstReleaseSmokeNamespace, firstReleaseSmokePrefix, isQualificationRunNumber } from '../src/lib/server/qualification-scope.mjs';

const namePrefix = 'qerith-drive-first-release-smoke';
const deployWindowMs = 15 * 60_000;
const hex64 = /^[a-f0-9]{64}$/;
const cfId = /^[a-f0-9]{32}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const resourceName = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const digest = value => createHash('sha256').update(value).digest('hex');

export function smokeDispatch(env) {
  const { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: event, GITHUB_REF: ref,
    GITHUB_SHA: sha, EXPECTED_MAIN_SHA: expected, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = env;
  if (repository !== 'TogetherWeOwn/qerith' || event !== 'workflow_dispatch' || ref !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || sha !== expected ||
      !isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt)) throw new Error('Invalid protected smoke dispatch');
  const worker = `${namePrefix}-${runId}-${attempt}`;
  if (!resourceName.test(worker) || !Number.isSafeInteger(Number(attempt))) throw new Error('Smoke Worker name is too long');
  return { sha, runId, runAttempt: Number(attempt), worker, prefix: firstReleaseSmokePrefix({ runId, attempt }) };
}

export function scopedSmokeTarget(env, scope, { cleanup = false, now = Date.now() } = {}) {
  const { QERITH_FIRST_RELEASE_SMOKE_TARGET: declaration, CLOUDFLARE_API_TOKEN: token,
    QERITH_FIRST_RELEASE_SMOKE_R2_ACCESS_KEY_ID: accessKeyId,
    QERITH_FIRST_RELEASE_SMOKE_R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  let target;
  try {
    if (!declaration || declaration.length > 4096) throw new Error();
    target = JSON.parse(declaration);
    const { accountId, databaseId, databaseName, bucket, workerSubdomain, scopeEvidenceDigest, expiresAt,
      deployTokenHash, accessKeyIdHash } = target;
    if ([accountId, databaseId, databaseName, bucket, workerSubdomain, scopeEvidenceDigest, deployTokenHash, accessKeyIdHash]
          .some(value => typeof value !== 'string') ||
        !cfId.test(accountId) || !uuid.test(databaseId) || databaseId === '87ac8041-ad2d-4650-b0d7-05bb78846f60' ||
        !resourceName.test(databaseName) || !databaseName.startsWith(namePrefix + '-') ||
        !resourceName.test(bucket) || !(bucket === namePrefix || bucket.startsWith(namePrefix + '-')) ||
        !resourceName.test(workerSubdomain) || !hex64.test(scopeEvidenceDigest) ||
        !Number.isSafeInteger(expiresAt) || (!cleanup && expiresAt < now + deployWindowMs) ||
        typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token) || deployTokenHash !== digest(token) ||
        typeof accessKeyId !== 'string' || !cfId.test(accessKeyId) || accessKeyIdHash !== digest(accessKeyId) ||
        typeof secretAccessKey !== 'string' || !hex64.test(secretAccessKey)) throw new Error();
    const origin = `https://${scope.worker}.${workerSubdomain}.workers.dev`;
    return { accountId, databaseId, databaseName, bucket, workerSubdomain, scopeEvidenceDigest, origin, token,
      s3: { endpoint: `https://${accountId}.r2.cloudflarestorage.com`, bucket, region: 'auto', accessKeyId, secretAccessKey } };
  } catch {
    throw new Error('Missing or invalid scoped smoke target and matching provider credentials');
  }
}

export function smokeProvider(target, scope, request = fetch) {
  const account = `/accounts/${target.accountId}`;
  const d1 = `${account}/d1/database/${target.databaseId}`;
  const r2 = `${account}/r2/buckets/${target.bucket}`;
  const worker = `${account}/workers/scripts/${scope.worker}`;
  async function call(path, { method = 'GET', body, absence } = {}) {
    try {
      const signal = AbortSignal.timeout(15_000);
      const response = await request('https://api.cloudflare.com/client/v4' + path, { method, redirect: 'error', signal,
        headers: { authorization: `Bearer ${target.token}`, ...(path.startsWith(r2) && { 'cf-r2-jurisdiction': 'default' }),
          ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
      if (!response.body || response.headers.has('content-range')) throw new Error();
      const bytes = await readBoundedBody(response.body, { signal, maxBytes: 128 * 1024, timeoutMs: 10_000 });
      if (!bytes) throw new Error();
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (response.status === 404 && absence !== undefined && data.success === false &&
          data.errors?.length === 1 && data.errors[0].code === absence) return null;
      if (!response.ok || data.success !== true || !Array.isArray(data.errors) || data.errors.length) throw new Error();
      return data.result;
    } catch {
      // Never expose request headers or provider error bodies.
      throw new Error('Scoped Cloudflare API request could not be verified');
    }
  }
  const readDb = () => call(d1, { absence: 7404 });
  function checkDb(db) {
    if (db?.uuid !== target.databaseId || db.name !== target.databaseName) throw new Error('Disposable D1 identity mismatch');
  }
  const workerSettings = () => call(worker + '/settings', { absence: 10007 });
  function checkRules(rules) {
    const transitions = [['deleteObjectsTransition', 3 * 86_400], ['abortMultipartUploadsTransition', 7 * 86_400]];
    if (!Array.isArray(rules) || rules.length > 100) throw new Error('R2 expiry rules could not be verified');
    for (const [field, limit] of transitions) {
      const applicable = rules.filter(rule => rule?.enabled === true && typeof rule.conditions?.prefix === 'string' &&
        (scope.prefix.startsWith(rule.conditions.prefix) || rule.conditions.prefix.startsWith(scope.prefix)) && rule[field]);
      const expiry = applicable.every(rule => {
        const condition = rule[field].condition;
        return condition?.type === 'Age' && Number.isSafeInteger(condition.maxAge) && condition.maxAge > 0 && condition.maxAge <= limit;
      });
      if (!expiry || !applicable.some(rule => rule.conditions.prefix.startsWith(firstReleaseSmokeNamespace) &&
          scope.prefix.startsWith(rule.conditions.prefix))) throw new Error('R2 attempt expiry is absent or out of bounds');
    }
  }
  return {
    async preflight() {
      checkDb(await readDb());
      const queries = await call(d1 + '/query', { method: 'POST', body: {
        sql: "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name != '_cf_KV' LIMIT 1",
      } });
      const schema = Array.isArray(queries) && queries.length === 1 ? queries[0] : null;
      if (schema?.success !== true || !Array.isArray(schema.results) || schema.results.length) throw new Error('Disposable D1 must be fresh and empty');
      if (await workerSettings() !== null) throw new Error('Attempt Worker already exists');
      const subdomain = await call(account + '/workers/subdomain');
      if (subdomain?.subdomain !== target.workerSubdomain) throw new Error('Smoke Worker subdomain mismatch');
      const bucket = await call(r2);
      if (bucket?.name !== target.bucket || bucket.jurisdiction !== 'default') throw new Error('Disposable R2 identity mismatch');
      const managed = await call(r2 + '/domains/managed');
      const custom = await call(r2 + '/domains/custom');
      if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.length) throw new Error('Disposable R2 bucket privacy unverified');
      checkRules((await call(r2 + '/lifecycle'))?.rules);
    },
    async stopWorker(buildDigest) {
      const settings = await workerSettings();
      if (settings === null) return;
      const bindings = settings?.bindings;
      const text = (name, value) => bindings.filter(binding =>
        binding.name === name && binding.type === 'plain_text' && binding.text === value).length === 1;
      if (!Array.isArray(bindings) || !text('DRIVE_QUALIFICATION_SHA', scope.sha) ||
          !text('DRIVE_FIRST_RELEASE_BUILD_DIGEST', buildDigest) ||
          !text('DRIVE_QUALIFICATION_RUN_ID', scope.runId) || !text('DRIVE_QUALIFICATION_RUN_ATTEMPT', String(scope.runAttempt)) ||
          !bindings.some(binding => binding.name === 'DB' && binding.type === 'd1' && binding.id === target.databaseId)) {
        throw new Error('Cannot verify cleanup ownership of smoke Worker');
      }
      await call(worker, { method: 'DELETE' });
      if (await workerSettings() !== null) throw new Error('Smoke Worker removal could not be verified');
    },
    async removeDb() {
      const live = await readDb();
      if (live === null) return;
      checkDb(live);
      await call(d1, { method: 'DELETE' });
      if (await readDb() !== null) throw new Error('Disposable D1 removal could not be verified');
    },
  };
}
