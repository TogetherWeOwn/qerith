import { recoveryAgeSeconds, recoveryNamespace, verifyRecoveryR2Expiry } from './staging-qualification-expiry.mjs';
import { maxRecordBytes, qualificationRecoveryKey } from './staging-qualification-recovery-record.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';

const unverified = () => new Error('Qualification R2 recovery storage is unverified.');

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
        if (typeof body !== 'string' || !body.isWellFormed() || !body || Buffer.byteLength(body) > maxRecordBytes ||
            await verifyRetention(signal) !== true) throw unverified();
        signal?.throwIfAborted();
        const response = await request({ method: 'PUT', key: target, body: Buffer.from(body), signal,
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
        const modified = headers.get('last-modified');
        const timestamp = Date.parse(modified ?? '');
        const age = now() - timestamp;
        if (status !== 200 || headers.has('content-range') || headers.has('content-encoding') ||
            !(body instanceof Uint8Array) || !body.byteLength || body.byteLength > maxBytes ||
            headers.get('content-length') !== String(body.byteLength) || !Number.isFinite(age) ||
            new Date(timestamp).toUTCString() !== modified || age < 0 || age >= recoveryAgeSeconds * 1000) throw unverified();
        // Preserve a BOM if present so the canonical byte comparison rejects it.
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
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
