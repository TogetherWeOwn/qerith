import { types } from 'node:util';
import { recoveryAgeSeconds, recoveryNamespace, verifyRecoveryR2Expiry } from './staging-qualification-expiry.mjs';
import { maxRecordBytes, qualificationRecoveryKey } from './staging-qualification-recovery-record.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';

const unverified = () => new Error('Qualification R2 recovery storage is unverified.');
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const sizeOf = body => types.isUint8Array(body) ? byteLength.call(body) : 0;
const maxClockDifferenceMs = 30_000;

function httpTime(value) {
  const ms = Date.parse(value ?? '');
  if (!Number.isFinite(ms) || new Date(ms).toUTCString() !== value) throw unverified();
  return ms;
}

// Only the two exact keys are addressable. No list, replace, delete or retry.
export function qualificationR2RecoveryStore(source, { request, verifyRetention, now = Date.now }) {
  const keys = ['d1', 'worker'].map(kind => qualificationRecoveryKey(source, kind));
  const objectKey = key => {
    if (!keys.includes(key)) throw unverified();
    return recoveryNamespace + key;
  };
  return {
    async create(key, body, signal) {
      try {
        const target = objectKey(key);
        signal?.throwIfAborted();
        const size = sizeOf(body);
        if (!size || size > maxRecordBytes) throw unverified();
        const bytes = new Uint8Array(size);
        bytes.set(body);
        if (await verifyRetention(signal) !== true) throw unverified();
        signal?.throwIfAborted();
        const response = await request({ method: 'PUT', key: target, body: bytes, signal,
          headers: { 'if-none-match': '*', 'content-type': 'application/json', 'cache-control': 'private, no-store' },
          maxResponseBytes: 0 });
        signal?.throwIfAborted();
        if (response.status !== 200 || !/^"[\x21\x23-\x7e]+"$/.test(response.headers.get('etag') ?? '')) throw unverified();
        return true;
      } catch {
        throw unverified();
      }
    },
    async read(key, { maxBytes, signal }) {
      try {
        const target = objectKey(key);
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > maxRecordBytes) throw unverified();
        const { status, headers, body } = await request({ method: 'GET', key: target, signal,
          headers: { 'cache-control': 'no-cache, no-store' }, maxResponseBytes: maxBytes });
        signal?.throwIfAborted();
        const size = sizeOf(body);
        if (status !== 200 || headers.has('content-range') || headers.has('content-encoding') ||
            !size || size > maxBytes || headers.get('content-length') !== String(size)) throw unverified();
        const providerTime = httpTime(headers.get('date'));
        const modified = httpTime(headers.get('last-modified'));
        const runnerTime = now();
        // Allow clock skew for freshness, but never extend expiry on either clock.
        if (!Number.isFinite(runnerTime) || Math.abs(providerTime - runnerTime) > maxClockDifferenceMs ||
            modified > providerTime || Math.max(providerTime, runnerTime) - modified >= recoveryAgeSeconds * 1000) throw unverified();
        return body;
      } catch {
        throw unverified();
      }
    },
  };
}

// Unwired: source must be authenticated by the protected caller. The source
// SHA pins the existing storage receipt even when recovering a prior attempt.
export async function createQualificationR2RecoveryStore({ sha, runId, attempt }, env, cwd, { send = fetch } = {}) {
  try {
    const source = { sha, runId, attempt };
    qualificationRecoveryKey(source, 'd1');
    const binding = await readQualificationR2Binding(env, cwd, sha);
    const { createS3Transport } = await import('../src/lib/server/s3/transport.ts');
    return qualificationR2RecoveryStore(source, {
      request: createS3Transport(binding.settings, { fetch: send, timeoutMs: 5000 }),
      verifyRetention: signal => verifyRecoveryR2Expiry(binding, env.CLOUDFLARE_API_TOKEN, signal, send),
    });
  } catch {
    throw unverified();
  }
}
