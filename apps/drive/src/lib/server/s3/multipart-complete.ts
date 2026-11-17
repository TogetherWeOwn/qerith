import { completionXml, type CompletedPart } from './multipart-completion';
import { parseMultipartCompletionResponse } from './multipart-response';
import { createS3Transport } from './transport';

/** Complete an upload once; ambiguous responses must be reconciled by the caller. */
export function createMultipartComplete(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);
  return async (key: string, uploadId: string, parts: readonly CompletedPart[], signal?: AbortSignal) => {
    if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid S3 object key');
    if (!uploadId) throw new Error('Invalid multipart upload');
    try { encodeURIComponent(key); encodeURIComponent(uploadId); } catch { throw new Error('Invalid multipart upload'); }
    const body = completionXml(parts);
    if (signal?.aborted) throw new Error('S3 request cancelled');
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request({ method: 'POST', key, query: { uploadId }, body, headers: { 'content-type': 'application/xml', 'if-none-match': '*' }, signal, maxResponseBytes: 64 * 1024 });
    } catch {
      throw new Error('S3 multipart completion outcome uncertain');
    }
    if (response.status === 200) {
      let result: ReturnType<typeof parseMultipartCompletionResponse>;
      try { result = parseMultipartCompletionResponse(response.body); } catch { throw new Error('S3 multipart completion outcome uncertain'); }
      if (result.kind === 'error') {
        // Only known request rejections prove failure; internal and unknown errors need reconciliation.
        if (['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder', 'NoSuchUpload'].includes(result.code)) throw new Error('S3 multipart completion failed');
        throw new Error('S3 multipart completion outcome uncertain');
      }
      return result;
    }
    if (response.status === 408 || response.status >= 500 || (response.status >= 200 && response.status < 300)) throw new Error('S3 multipart completion outcome uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  };
}
