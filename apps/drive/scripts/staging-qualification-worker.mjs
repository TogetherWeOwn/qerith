import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readinessHeaders, readinessPath, stagingOrigin } from '../src/lib/server/qualification-readiness.ts';
import { validateStagingTarget } from './staging-publish.mjs';
import { assertQualificationJob } from './staging-qualification.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isUuid = value => typeof value === 'string' && uuid.test(value);
const sameDeployment = (left, right) => left.id === right.id && left.version === right.version;

export async function probeQualificationWorker({ sha, version }, signal, request = fetch) {
  const nonce = randomBytes(16).toString('hex');
  const deadline = AbortSignal.timeout(10_000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
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
    return { ready: true, sha: actualSha, version: actualVersion };
  } catch {
    throw new Error('Staging Worker did not prove fresh exact-SHA runtime readiness.');
  }
}

function workerApi(base, token, request) {
  async function call(path, signal, body) {
    try {
      const deadline = AbortSignal.timeout(15_000);
      const bounded = signal ? AbortSignal.any([deadline, signal]) : deadline;
      bounded.throwIfAborted();
      const response = await request(`${base}/${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: bounded,
        headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
      if (!response.ok || !response.body) {
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
      return payload.result;
    } catch {
      // Never log provider bodies, headers, or errors.
      throw new Error('Bounded staging Worker API call failed.');
    }
  }
  return {
    async current(signal) {
      const { deployments } = await call('deployments', signal);
      const latest = Array.isArray(deployments) ? deployments[0] : null;
      const version = latest?.versions?.[0];
      if (!isUuid(latest?.id) || !Array.isArray(latest.versions) || latest.versions.length !== 1 ||
          version?.percentage !== 100 || !isUuid(version.version_id)) {
        throw new Error('Staging Worker requires a known single-version deployment.');
      }
      return { id: latest.id, version: version.version_id, message: latest.annotations?.['workers/message'] };
    },
    async assertUploaded(version, tag, signal) {
      const result = await call(`versions/${version}`, signal);
      if (result.id !== version || result.annotations?.['workers/tag'] !== tag) {
        throw new Error('Staging Worker version does not match the tested SHA and attempt.');
      }
    },
    async deploy(version, message, signal) {
      const result = await call('deployments', signal, {
        strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }],
        annotations: { 'workers/message': message },
      });
      if (!isUuid(result.id)) throw new Error('Invalid staging Worker deployment ID.');
      return { id: result.id, version };
    },
  };
}

async function runPhase(task, identity, parentSignal, timeout) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const deadline = performance.now() + timeout;
  const expire = () => controller.abort(new DOMException('Qualification phase timed out.', 'TimeoutError'));
  const timer = setTimeout(expire, timeout);
  try {
    // The callback must stop and drain its work on abort. Racing the promise
    // would allow a still-running case to mutate staging during rollback.
    return await task({ ...identity }, signal);
  } finally {
    // A blocked event loop can settle the callback before the timer gets a turn.
    if (performance.now() >= deadline) expire();
    clearTimeout(timer);
    signal.throwIfAborted();
  }
}

// No workflow caller. The protected runner must upload the immutable exact-SHA
// build with the attempt tag without changing rollback compatibility, hold
// the lifecycle lock, and supply abortable probe and case callbacks.
export async function withQualificationWorker({ candidate, recordRecovery, probe, exercise },
  env, cwd = process.cwd(), signal, request = fetch) {
  const { sha, runId, attempt } = assertQualificationJob(env, cwd);
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } = env;
  if (typeof token !== 'string' || !token.trim() || !isUuid(candidate) ||
      [recordRecovery, probe, exercise].some(fn => typeof fn !== 'function')) {
    throw new Error('Worker lifecycle requires the protected qualification attempt and an uploaded version.');
  }
  const { name } = validateStagingTarget(join(cwd, 'apps/drive'), account);
  const api = workerApi(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`, token, request);
  const tag = `${sha}-${runId}-${attempt}`;
  const previous = await api.current(signal);
  if (previous.version === candidate) throw new Error('The qualification version is already active.');
  await api.assertUploaded(candidate, tag, signal);
  const identity = { sha, runId, attempt, version: candidate };
  await recordRecovery({ ...identity, previousVersion: previous.version, previousDeployment: previous.id });
  if (!sameDeployment(await api.current(signal), previous)) throw new Error('Staging deployment changed before activation.');
  signal?.throwIfAborted();

  let active;
  let restored;
  let cases;
  try {
    active = await api.deploy(candidate, tag, signal);
    if (!sameDeployment(await api.current(signal), active)) throw new Error('Cannot verify the active qualification deployment.');
    const evidence = await runPhase(probe, identity, signal, 30_000);
    if (evidence?.ready !== true || evidence.sha !== sha || evidence.version !== candidate) {
      throw new Error('Staging Worker did not prove exact-SHA runtime readiness.');
    }
    signal?.throwIfAborted();
    cases = await runPhase(exercise, identity, signal, 20 * 60_000);
  } finally {
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
  }
  signal?.throwIfAborted();
  return { ...identity, previousVersion: previous.version, restoredDeployment: restored.id, cases };
}
