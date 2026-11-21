import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  qualificationTimeLeft, qualificationWindowMs, readinessHeaders, readinessPath, stagingOrigin,
} from '../src/lib/server/qualification-readiness.ts';
import { stagingStorage, validateStagingConfig, validateStagingTarget } from './staging-publish.mjs';
import { assertQualificationJob } from './staging-qualification.mjs';
import { uploadVersion } from './staging-qualification-upload.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isUuid = value => typeof value === 'string' && uuid.test(value);
const sameDeployment = (left, right) => left.id === right.id && left.version === right.version;
const expiryBinding = 'DRIVE_QUALIFICATION_EXPIRES_AT';
const hasCandidateBinding = bindings => [...bindings.keys()].some(name => name.startsWith('DRIVE_QUALIFICATION_'));
const apiTimeout = 15_000;
const probeBudget = 30_000;
const caseBudget = 18 * 60_000;
const cleanupBudget = 60_000;

const activationBudget = 2 * apiTimeout + probeBudget + caseBudget + cleanupBudget;

export function qualificationMigrationTimeLeft(expiresAt, recordBudget) {
  // After migrations: current deployment, candidate bindings, recovery record,
  // and final deployment check precede the activation write and readback.
  return qualificationTimeLeft(expiresAt) - activationBudget - 3 * apiTimeout - recordBudget;
}

function requireActivationWindow(expiresAt) {
  if (qualificationTimeLeft(expiresAt) <= activationBudget) {
    throw new Error('Staging candidate has insufficient time left to activate.');
  }
}

export async function probeQualificationWorker({ sha, version }, signal, request = fetch) {
  const nonce = randomBytes(16).toString('hex');
  const timeout = 10_000;
  const deadline = performance.now() + timeout;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const bounded = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    bounded.throwIfAborted();
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !isUuid(version)) throw new Error();
    const response = await request(stagingOrigin + readinessPath, {
      method: 'HEAD', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: bounded,
      headers: { [readinessHeaders.nonce]: nonce },
    });
    if (response.body !== null) {
      await response.body.cancel();
      throw new Error();
    }
    bounded.throwIfAborted();
    const actualSha = response.headers.get(readinessHeaders.sha);
    const actualVersion = response.headers.get(readinessHeaders.version);
    if (response.status !== 204 || response.headers.get('cache-control') !== 'private, no-store' ||
        response.headers.get(readinessHeaders.nonce) !== nonce || actualSha !== sha || actualVersion !== version) throw new Error();
    // Fetch can settle after the deadline before the abort timer gets a turn.
    if (performance.now() >= deadline) throw new Error();
    return { ready: true, sha: actualSha, version: actualVersion };
  } catch {
    throw new Error('Staging Worker did not prove fresh exact-SHA runtime readiness.');
  }
}

function workerApi(account, name, token, request) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers`;
  const script = `scripts/${name}`;
  async function call(path, signal, body) {
    try {
      const deadline = AbortSignal.timeout(apiTimeout);
      const bounded = signal ? AbortSignal.any([deadline, signal]) : deadline;
      bounded.throwIfAborted();
      const response = await request(`${base}/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: bounded,
        headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
      const complete = body ? response.ok : response.status === 200 && !response.headers.has('content-range');
      if (!complete || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      let size = 0;
      let text = '';
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 65_536) throw new Error();
        text += decoder.decode(chunk, { stream: true });
      }
      const payload = JSON.parse(text + decoder.decode());
      if (payload?.success !== true || !payload.result || !Array.isArray(payload.errors) || payload.errors.length) throw new Error();
      if (path === `${script}/schedules` && Object.hasOwn(payload, 'result_info')) throw new Error();
      return payload.result;
    } catch {
      // Never log provider bodies, headers, or errors.
      throw new Error('Bounded staging Worker API call failed.');
    }
  }
  const version = (id, signal) => call(`${script}/versions/${id}`, signal);
  return {
    version,
    async assertNoSchedules(signal) {
      const result = await call(`${script}/schedules`, signal);
      if (!Array.isArray(result.schedules) || result.schedules.length || Object.keys(result).length !== 1) {
        throw new Error('Cannot verify empty staging Worker schedules.');
      }
    },
    async recentUploads(signal) {
      // Same unfiltered, newest-first list used by Wrangler's secret list --latest-version.
      const { items } = await call(`${script}/versions`, signal);
      if (!Array.isArray(items)) throw new Error('Cannot verify staging Worker upload history.');
      return items.slice(0, 2).map(item => item?.id);
    },
    async assertUploadTarget(signal) {
      const { previews_enabled: preview } = await call(`${script}/subdomain`, signal);
      const { default_environment: environment } = await call(`services/${name}`, signal);
      const tags = environment?.script?.tags ?? [];
      // Pinned Wrangler would remove service/environment tags from an ungrouped
      // config after upload, changing non-versioned settings. Refuse that target.
      if (preview !== false || !environment?.script || !Array.isArray(tags) ||
          tags.some(tag => typeof tag !== 'string' || /^cf:(service|environment)=/.test(tag))) {
        throw new Error('Staging Worker upload requires an ungrouped target with version previews disabled.');
      }
    },
    async current(signal) {
      const { deployments } = await call(`${script}/deployments`, signal);
      const latest = Array.isArray(deployments) ? deployments[0] : null;
      const version = latest?.versions?.[0];
      if (!isUuid(latest?.id) || !Array.isArray(latest.versions) || latest.versions.length !== 1 ||
          version?.percentage !== 100 || !isUuid(version.version_id)) {
        throw new Error('Staging Worker requires a known single-version deployment.');
      }
      return { id: latest.id, version: version.version_id, message: latest.annotations?.['workers/message'] };
    },
    async assertUploaded(id, tag, signal) {
      const result = await version(id, signal);
      if (result.id !== id || result.annotations?.['workers/tag'] !== tag) {
        throw new Error('Staging Worker version does not match the tested SHA and attempt.');
      }
      return result;
    },
    async deploy(version, message, signal) {
      const result = await call(`${script}/deployments`, signal, {
        strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }],
        annotations: { 'workers/message': message },
      });
      if (!isUuid(result.id)) throw new Error('Invalid staging Worker deployment ID.');
      return { id: result.id, version };
    },
  };
}

function checkedBindings(version, config, vars) {
  const raw = version.resources?.bindings;
  const invalid = () => new Error('Staging Worker version has incompatible resource or storage bindings.');
  if (!Array.isArray(raw) || raw.some(binding => typeof binding?.name !== 'string')) throw invalid();
  const bindings = new Map(raw.map(binding => [binding.name, binding]));
  if (bindings.size !== raw.length || bindings.get('DB')?.type !== 'd1' ||
      bindings.get('DB').id !== config.d1_databases[0].database_id || bindings.get('ASSETS')?.type !== 'assets' ||
      raw.some(({ name, type }) => !['plain_text', 'json', 'secret_text'].includes(type) &&
        !(name === 'DB' && type === 'd1') && !(name === 'ASSETS' && type === 'assets') &&
        !(name === 'DRIVE_QUALIFICATION_VERSION' && type === 'version_metadata' && Object.hasOwn(vars, 'DRIVE_QUALIFICATION_SHA'))) ||
      Object.entries(vars).some(([name, text]) => bindings.get(name)?.type !== 'plain_text' || bindings.get(name).text !== text)) {
    throw invalid();
  }
  return bindings;
}

export function stagingConfigAt(cwd, sha, account) {
  const config = JSON.parse(execFileSync('git', ['show', `${sha}:apps/drive/wrangler.staging.json`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65_536, timeout: 5_000 }));
  validateStagingConfig(config, account);
  return config;
}

// Unwired: the protected caller must authenticate the completed source attempt
// and its pre-activation record, exclude pending writes, and hold the lifecycle lock.
export async function recoverQualificationWorker(source, record, env, cwd, signal, request = fetch) {
  const { sha, runId, attempt } = source ?? {};
  const { kind, version, expiresAt, previousVersion, previousDeployment } = record ?? {};
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  try {
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) ||
        ![runId, attempt].every(value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)) ||
        kind !== 'worker' || record.sha !== sha || record.runId !== runId || record.attempt !== attempt ||
        ![version, previousVersion, previousDeployment].every(isUuid) || version === previousVersion ||
        typeof expiresAt !== 'string' || !/^[1-9][0-9]{12}$/.test(expiresAt) ||
        typeof token !== 'string' || !token.trim()) throw new Error();
    signal?.throwIfAborted();
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'],
      { cwd, stdio: 'ignore', timeout: 5_000 });
    const config = stagingConfigAt(cwd, sha, account);
    const api = workerApi(account, config.name, token, request);
    const tag = `${sha}-${runId}-${attempt}`;
    const restoreTag = `restore-${tag}`;
    const before = await api.current(signal);
    const original = sameDeployment(before, { id: previousDeployment, version: previousVersion });
    const alreadyRestored = before.version === previousVersion && before.message === restoreTag;
    if (!original && !alreadyRestored && (before.version !== version || before.message !== tag)) throw new Error();

    const baseline = await api.version(previousVersion, signal);
    if (baseline.id !== previousVersion || hasCandidateBinding(checkedBindings(baseline, config, {}))) throw new Error();
    if (!original && !alreadyRestored) {
      const bindings = checkedBindings(await api.assertUploaded(version, tag, signal), config, {
        DRIVE_QUALIFICATION_SHA: sha, [expiryBinding]: expiresAt,
      });
      if (bindings.get('DRIVE_QUALIFICATION_VERSION')?.type !== 'version_metadata') throw new Error();
    }
    const confirmed = await api.current(signal);
    if (!sameDeployment(before, confirmed) || before.message !== confirmed.message) throw new Error();
    if (original || alreadyRestored) {
      signal?.throwIfAborted();
      return { status: original ? 'baseline-observed' : 'restored', deployment: before.id, version: previousVersion };
    }
    const restored = await api.deploy(previousVersion, restoreTag, signal);
    const after = await api.current(signal);
    if (!sameDeployment(restored, after) || after.message !== restoreTag) throw new Error();
    signal?.throwIfAborted();
    return { status: 'restored', deployment: after.id, version: previousVersion };
  } catch {
    throw new Error('Staging Worker recovery is unverified; reconcile the recorded deployment before retrying.');
  }
}

// Only Worker cron/binding evidence, not a whole-estate inventory or an atomic fence.
export async function inspectQualificationWorker(env, cwd, signal, request = fetch) {
  try {
    const { sha, runId, attempt } = assertQualificationJob(env, cwd);
    const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
    if (typeof token !== 'string' || !token.trim()) throw new Error();
    const config = stagingConfigAt(cwd, sha, account);
    const api = workerApi(account, config.name, token, request);
    const timeout = 15_000;
    const deadline = performance.now() + timeout;
    const timer = AbortSignal.timeout(timeout);
    const bounded = signal ? AbortSignal.any([signal, timer]) : timer;
    const before = await api.current(bounded);
    const deployed = await api.version(before.version, bounded);
    const bindings = checkedBindings(deployed, config, {});
    if (deployed.id !== before.version || hasCandidateBinding(bindings)) {
      throw new Error();
    }
    await api.assertNoSchedules(bounded);
    const confirmed = await api.current(bounded);
    if (!sameDeployment(before, confirmed) || before.message !== confirmed.message) throw new Error();
    bounded.throwIfAborted();
    if (performance.now() >= deadline) throw new Error();
    return { version: before.version, deployment: before.id, schedules: 0, resources: ['DB', 'ASSETS'],
      attemptRestore: before.message === `restore-${sha}-${runId}-${attempt}` };
  } catch {
    throw new Error('Cannot verify staging Worker cron and resource bindings.');
  }
}

// Unwired: the protected caller must hold the lifecycle lock and supply a fresh
// build of the checked-out SHA. This prepares a version, not a deployment.
export async function uploadQualificationWorker(env, cwd = process.cwd(), signal, request = fetch, run = spawn) {
  const { sha, runId, attempt } = assertQualificationJob(env, cwd);
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  if (typeof token !== 'string' || !token.trim()) throw new Error('Staging Worker upload requires the protected credentials.');
  const root = join(cwd, 'apps/drive');
  const config = validateStagingTarget(root, account);
  const receipt = JSON.parse(execFileSync('git', ['show', `${sha}:apps/drive/scripts/staging-storage-qualification.json`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 65_536 }));
  const storage = await stagingStorage(env, receipt);
  const api = workerApi(account, config.name, token, request);
  await api.assertUploadTarget(signal);
  const previous = await api.current(signal);
  const baseline = await api.version(previous.version, signal);
  const baselineBindings = checkedBindings(baseline, config, storage.vars);
  const secretNames = bindings => [...bindings.values()].filter(({ type }) => type === 'secret_text').map(({ name }) => name).sort();
  const secrets = secretNames(baselineBindings);
  if (baseline.id !== previous.version || hasCandidateBinding(baselineBindings) ||
      Object.keys(storage.secrets).some(name => !secrets.includes(name))) {
    throw new Error('Staging baseline must already bind the reviewed storage secrets without candidate identity.');
  }

  const tag = `${sha}-${runId}-${attempt}`;
  // Wrangler inherits from the latest upload, not the deployment serving traffic.
  if ((await api.recentUploads(signal))[0] !== previous.version) {
    throw new Error('Staging baseline is not the latest uploaded version; refusing to inherit secrets. Reconcile staging before retrying.');
  }
  const expiresAt = String(Date.now() + qualificationWindowMs);
  const vars = { ...storage.vars, DRIVE_ORIGIN: config.vars.DRIVE_ORIGIN, DRIVE_QUALIFICATION_SHA: sha,
    [expiryBinding]: expiresAt, DRIVE_SIGN_IN_FIXTURE: '0', DRIVE_STAGING_INVITE_ACCEPTANCE: '0',
    DRIVE_OWNER_ENROLLMENT_RELEASE: 'disabled' };
  const version = await uploadVersion(root, config, vars, tag, secrets, account, token, signal, run);
  if (!isUuid(version) || version === previous.version) throw new Error('Staging Worker upload did not return a new version ID.');
  const candidate = checkedBindings(await api.assertUploaded(version, tag, signal), config, vars);
  const [latest, predecessor] = await api.recentUploads(signal);
  if (latest !== version || predecessor !== previous.version) {
    throw new Error('The candidate did not immediately follow the staging baseline in upload history.');
  }
  if (candidate.get('DRIVE_QUALIFICATION_VERSION')?.type !== 'version_metadata' ||
      candidate.size !== Object.keys(vars).length + secrets.length + 3 ||
      secretNames(candidate).join('\n') !== secrets.join('\n') || !sameDeployment(await api.current(signal), previous)) {
    throw new Error('Cannot prove isolated candidate upload with unchanged staging baseline.');
  }
  signal?.throwIfAborted();
  requireActivationWindow(expiresAt);
  return { version, expiresAt, previousDeployment: previous.id, previousVersion: previous.version };
}

export async function runQualificationPhase(task, identity, parentSignal, timeout, wallTimeLeft) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const deadline = performance.now() + timeout;
  const expire = () => controller.abort(new DOMException('Qualification phase timed out.', 'TimeoutError'));
  const checkWall = () => { if (wallTimeLeft && !(wallTimeLeft() > 0)) expire(); };
  const timer = setTimeout(expire, timeout);
  // Relative timers do not see a forward wall-clock step during pending I/O.
  const wallTimer = wallTimeLeft && setInterval(checkWall, 1_000);
  try {
    checkWall();
    signal.throwIfAborted();
    // The callback must stop and drain its work on abort. Racing the promise
    // would allow a still-running case to mutate staging during rollback.
    return await task({ ...identity }, signal);
  } finally {
    clearTimeout(timer);
    clearInterval(wallTimer);
    // A blocked event loop can settle the callback before the timer gets a turn.
    if (performance.now() >= deadline) expire();
    checkWall();
    signal.throwIfAborted();
  }
}

export async function withQualificationRecovery(task, recover) {
  let failure;
  try {
    return await task();
  } catch (error) {
    failure = [error];
    throw error;
  } finally {
    try {
      await recover();
    } catch (error) {
      if (!failure) throw error;
      throw new AggregateError([...failure, error], 'Qualification and recovery both failed.');
    }
  }
}

// No workflow caller. Hold the lifecycle lock from upload through restore and
// supply abortable probe, case and scoped cleanup callbacks.
export async function withQualificationWorker({ upload, recordRecovery, probe, exercise, cleanup },
  env, cwd = process.cwd(), signal, request = fetch) {
  const { sha, runId, attempt } = assertQualificationJob(env, cwd);
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  const { version: candidate, expiresAt, previousDeployment, previousVersion } = upload ?? {};
  if (typeof token !== 'string' || !token.trim() || ![candidate, previousDeployment, previousVersion].every(isUuid) ||
      candidate === previousVersion || [recordRecovery, probe, exercise, cleanup].some(fn => typeof fn !== 'function')) {
    throw new Error('Worker lifecycle requires the protected qualification attempt and an uploaded version.');
  }
  requireActivationWindow(expiresAt);
  const config = validateStagingTarget(join(cwd, 'apps/drive'), account);
  const api = workerApi(account, config.name, token, request);
  const tag = `${sha}-${runId}-${attempt}`;
  const previous = await api.current(signal);
  if (!sameDeployment(previous, { id: previousDeployment, version: previousVersion })) {
    throw new Error('Staging baseline changed since candidate upload.');
  }
  checkedBindings(await api.assertUploaded(candidate, tag, signal), config, {
    DRIVE_QUALIFICATION_SHA: sha, [expiryBinding]: expiresAt,
  });
  const identity = { sha, runId, attempt, version: candidate };
  await recordRecovery({ ...identity, expiresAt, previousVersion: previous.version, previousDeployment: previous.id });
  if (!sameDeployment(await api.current(signal), previous)) throw new Error('Staging deployment changed before activation.');
  signal?.throwIfAborted();
  requireActivationWindow(expiresAt);

  let active;
  let restored;
  const cases = await withQualificationRecovery(async () => {
    active = await api.deploy(candidate, tag, signal);
    if (!sameDeployment(await api.current(signal), active)) throw new Error('Cannot verify the active qualification deployment.');
    const evidence = await runQualificationPhase(probe, identity, signal, probeBudget);
    if (evidence?.ready !== true || evidence.sha !== sha || evidence.version !== candidate) {
      throw new Error('Staging Worker did not prove exact-SHA runtime readiness.');
    }
    signal?.throwIfAborted();
    return withQualificationRecovery(() => runQualificationPhase(exercise, identity, signal, caseBudget), async () => {
      // Cleanup must finish before rollback and has its own budget after cancellation.
      if (await runQualificationPhase(cleanup, { ...identity, expiresAt }, undefined, cleanupBudget) !== true) {
        throw new Error('Qualification prefix cleanup is unverified.');
      }
    });
  }, async () => {
    // Recovery has its own bounded requests, even if the exercise was cancelled.
    // With an ambiguous activation response, recover only an observed attempt-owned deployment.
    try {
      const current = await api.current();
      if (active ? !sameDeployment(current, active) : current.version !== candidate || current.message !== tag) throw new Error();
      restored = await api.deploy(previous.version, `restore-${tag}`);
      if (!sameDeployment(await api.current(), restored)) throw new Error();
    } catch {
      throw new Error('Staging Worker rollback is unverified; reconcile the recorded deployment before retrying.');
    }
  });
  signal?.throwIfAborted();
  return { ...identity, previousVersion: previous.version, restoredDeployment: restored.id, cases };
}
