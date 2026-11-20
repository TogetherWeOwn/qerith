import { createHash } from 'node:crypto';

// The qualification minimum is also the current app upload maximum.
const largeBytes = 5 * 1024 ** 3;

// The caller must obtain a fresh authenticated app download with the same
// abort signal and hash the upload fixture independently before uploading it.
export async function verifyQualificationLargeDownload(response, uploadSha256, signal) {
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
    if (typeof uploadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(uploadSha256) ||
        response.status !== 200 || response.redirected ||
        response.headers.get('content-type') !== 'application/octet-stream' ||
        response.headers.get('content-length') !== String(largeBytes) ||
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
      if (bytes > largeBytes) throw new Error('Large-transfer download exceeded five GiB.');
      hash.update(next.value);
    }
    if (bytes !== largeBytes || hash.digest('hex') !== uploadSha256) {
      throw new Error('Large-transfer download did not match the upload length and SHA-256.');
    }
    return { 'large-transfer-hash': 'pass' };
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!ended) cancel();
    await cancellation;
    reader.releaseLock();
  }
}
