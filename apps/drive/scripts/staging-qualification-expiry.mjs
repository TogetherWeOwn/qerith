import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const qualificationNamespace = 'drive-qualification/';
const transitions = [['deleteObjectsTransition', 3 * 86_400], ['abortMultipartUploadsTransition', 7 * 86_400]];

function checkRules({ success, errors, result }, target) {
  if (success !== true || !Array.isArray(errors) || errors.length || !Array.isArray(result?.rules)) throw new Error();
  const covered = new Set();
  for (const rule of result.rules) {
    if (typeof rule?.enabled !== 'boolean') throw new Error();
    if (!rule.enabled) continue;
    const prefix = rule.conditions?.prefix;
    if (typeof prefix !== 'string' || Object.keys(rule.conditions).length !== 1) throw new Error();
    const coversAttempt = target.startsWith(prefix);
    if (!coversAttempt && !prefix.startsWith(target)) continue;
    for (const [name, limit] of transitions) {
      if (!Object.hasOwn(rule, name)) continue;
      const condition = rule[name]?.condition;
      const age = condition?.maxAge;
      // Do not assume a slower overlapping rule loses to the covering rule.
      if (condition?.type !== 'Age' || Object.keys(condition).length !== 2 ||
          !Number.isSafeInteger(age) || age <= 0 || age > limit) throw new Error();
      if (coversAttempt && (name !== 'deleteObjectsTransition' || prefix.startsWith(qualificationNamespace))) covered.add(name);
    }
  }
  if (covered.size !== transitions.length) throw new Error();
}

async function boundedPayload(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 65_536) throw new Error();
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

// Readback only. Age thresholds configure eligibility for native R2 expiry;
// they neither prove deletion has occurred nor replace attempt cleanup.
export async function verifyQualificationR2Expiry(env, cwd, signal, request = fetch) {
  try {
    const identity = assertQualificationJob(env, cwd);
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!token?.trim()) throw new Error();
    return await runQualificationPhase(async (_, active) => {
      const { account, settings: { bucket } } = await readQualificationR2Binding(env, cwd, identity.sha);
      active.throwIfAborted();
      const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/lifecycle`;
      const response = await request(url, { method: 'GET', redirect: 'error', signal: active,
        headers: { authorization: `Bearer ${token}`, 'cf-r2-jurisdiction': 'default' } });
      checkRules(await boundedPayload(response), qualificationPrefix(identity));
      return true;
    }, null, signal, 15_000);
  } catch {
    throw new Error('Qualification R2 native expiry is unverified.');
  }
}
