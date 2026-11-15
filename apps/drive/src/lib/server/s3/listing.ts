import { listingChildren, listingText, parseListingXml } from './listing-xml';
import { createS3Transport } from './transport';

/** List one bounded page; continuation tokens and object keys remain opaque. */
export function createS3Listing(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);
  async function page(key: string, query: Record<string, string>, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('S3 request cancelled');
    let response: Awaited<ReturnType<typeof request>>;
    try { response = await request({ method: 'GET', key, query, signal, maxResponseBytes: 8 * 1024 * 1024 }); }
    catch { throw new Error(signal?.aborted ? 'S3 request cancelled' : 'S3 request failed'); }
    if (response.status !== 200) throw new Error(`S3 request failed with status ${response.status}`);
    return response.body;
  }
  return {
    async objects(options: { prefix?: string; continuationToken?: string; signal?: AbortSignal } = {}) {
      const { prefix, continuationToken, signal } = options;
      if (continuationToken === '') throw new Error('Invalid S3 listing cursor');
      const query: Record<string, string> = { 'list-type': '2', 'encoding-type': 'url' };
      if (prefix !== undefined) query.prefix = prefix;
      if (continuationToken !== undefined) query['continuation-token'] = continuationToken;
      const body = await page('', query, signal);
      try {
        const root = parseListingXml(body, 'ListBucketResult');
        if (listingText(root, 'EncodingType') !== 'url') throw new Error();
        const truncated = listingText(root, 'IsTruncated');
        if (truncated !== 'true' && truncated !== 'false') throw new Error();
        const next = listingText(root, 'NextContinuationToken', false);
        if (truncated === 'true' ? !next || next === continuationToken : next !== undefined) throw new Error();
        const keys = listingChildren(root, 'Contents').map((item) => decodeURIComponent(listingText(item, 'Key')!));
        if (keys.some((key) => !key)) throw new Error();
        return { keys, nextContinuationToken: next };
      } catch { throw new Error('Invalid S3 listing response'); }
    }
  };
}
