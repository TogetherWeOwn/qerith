import { createHash } from 'node:crypto';

// The qualification minimum is also the current app upload maximum.
export const largeBytes = 5 * 1024 ** 3;

export async function verifyQualificationLargeDownload(response, uploadSha256, signal) {
  await verifyQualificationDownload(response, largeBytes, uploadSha256, signal);
  return { 'large-transfer-hash': 'pass' };
}

// The caller supplies a fresh authenticated download and an independent source digest.
export async function verifyQualificationDownload(response, expectedBytes, uploadSha256, signal) {
  if (!response?.body || response.bodyUsed || response.body.locked) {
    throw new Error('Large transfer requires an unused download body.');
  }
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  let ended = false;
  let cancellation;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > largeBytes ||
        typeof uploadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(uploadSha256) ||
        response.status !== 200 || response.redirected ||
        response.headers.get('content-type') !== 'application/octet-stream' ||
        response.headers.get('content-length') !== String(expectedBytes) ||
        response.headers.has('content-range') || response.headers.has('content-encoding')) {
      throw new Error('Invalid full large-transfer download or upload digest.');
    }
    while (true) {
      const next = await reader.read().catch(() => { throw new Error('Large-transfer download stream failed.'); });
      signal?.throwIfAborted();
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new Error('Invalid large-transfer download chunk.');
      }
      bytes += next.value.byteLength;
      if (bytes > expectedBytes) throw new Error(expectedBytes === largeBytes
        ? 'Large-transfer download exceeded five GiB.' : 'Download exceeded the expected length.');
      hash.update(next.value);
    }
    if (bytes !== expectedBytes || hash.digest('hex') !== uploadSha256) {
      throw new Error('Large-transfer download did not match the upload length and SHA-256.');
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!ended) cancel();
    await cancellation;
    reader.releaseLock();
  }
}
