import { listingChildren, listingText, parseListingXml } from './listing-xml';
import { createS3Transport } from './transport';

/** List one bounded page; continuation tokens and object keys remain opaque. */
export function createS3Listing(...args: Parameters<typeof createS3Transport>) {
  const { bucket } = args[0];
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
        const keys = listingChildren(root, 'Contents').map((item) => decodeURIComponent(listingText(item, 'Key')!.replace(/\+/g, '%20')));
        if (keys.some((key) => !key)) throw new Error();
        return { keys, nextContinuationToken: next };
      } catch { throw new Error('Invalid S3 listing response'); }
    },
    async parts(key: string, uploadId: string, options: { partNumberMarker?: number; signal?: AbortSignal } = {}) {
      try {
        if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error();
        encodeURIComponent(key);
      } catch { throw new Error('Invalid or unsupported S3 key'); }
      const marker = options.partNumberMarker;
      if (!uploadId || (marker !== undefined && (!Number.isInteger(marker) || marker < 0 || marker > 10000))) throw new Error('Invalid S3 listing cursor');
      const query: Record<string, string> = { uploadId };
      if (marker !== undefined) query['part-number-marker'] = String(marker);
      const body = await page(key, query, options.signal);
      try {
        const root = parseListingXml(body, 'ListPartsResult');
        // ListParts does not request URL encoding; compare the XML text without URL decoding.
        if (listingText(root, 'Bucket') !== bucket || listingText(root, 'Key') !== key ||
            listingText(root, 'UploadId') !== uploadId) throw new Error();
        const truncated = listingText(root, 'IsTruncated');
        if (truncated !== 'true' && truncated !== 'false') throw new Error();
        const rawNext = listingText(root, 'NextPartNumberMarker', false);
        const next = rawNext === undefined ? undefined : Number(rawNext);
        if (rawNext !== undefined && (!/^[0-9]+$/.test(rawNext) || !Number.isInteger(next) || next! < 0 || next! > 10000)) throw new Error();
        if (truncated === 'true' && (next === undefined || next <= (marker ?? 0))) throw new Error();
        let previous = marker ?? 0;
        const parts = listingChildren(root, 'Part').map((part) => {
          const rawNumber = listingText(part, 'PartNumber')!;
          const rawSize = listingText(part, 'Size')!;
          const partNumber = Number(rawNumber), size = Number(rawSize);
          const etag = listingText(part, 'ETag')!;
          if (!/^[0-9]+$/.test(rawNumber) || !Number.isInteger(partNumber) || partNumber <= previous || partNumber > 10000 ||
              !/^[0-9]+$/.test(rawSize) || !Number.isSafeInteger(size) || !etag) throw new Error();
          previous = partNumber;
          return { partNumber, size, etag };
        });
        if (truncated === 'true' && (!parts.length || next !== previous)) throw new Error();
        return { parts, nextPartNumberMarker: truncated === 'true' ? next : undefined };
      } catch { throw new Error('Invalid S3 listing response'); }
    },
    async uploads(options: { prefix?: string; keyMarker?: string; uploadIdMarker?: string; signal?: AbortSignal } = {}) {
      const { prefix, keyMarker, uploadIdMarker, signal } = options;
      if ((uploadIdMarker !== undefined && keyMarker === undefined) || keyMarker === '' || uploadIdMarker === '') throw new Error('Invalid S3 listing cursor');
      const query: Record<string, string> = { uploads: '', 'encoding-type': 'url' };
      if (prefix !== undefined) query.prefix = prefix;
      if (keyMarker !== undefined) query['key-marker'] = keyMarker;
      if (uploadIdMarker !== undefined) query['upload-id-marker'] = uploadIdMarker;
      const body = await page('', query, signal);
      try {
        const root = parseListingXml(body, 'ListMultipartUploadsResult');
        if (listingText(root, 'EncodingType') !== 'url') throw new Error();
        const truncated = listingText(root, 'IsTruncated');
        if (truncated !== 'true' && truncated !== 'false') throw new Error();
        const rawKey = listingText(root, 'NextKeyMarker', false);
        const nextKeyMarker = rawKey === undefined ? undefined : decodeURIComponent(rawKey.replace(/\+/g, '%20'));
        const nextUploadIdMarker = listingText(root, 'NextUploadIdMarker', false);
        if (truncated === 'true' && (!nextKeyMarker || !nextUploadIdMarker || (nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker))) throw new Error();
        const uploads = listingChildren(root, 'Upload').map((item) => {
          const key = decodeURIComponent(listingText(item, 'Key')!.replace(/\+/g, '%20'));
          const uploadId = listingText(item, 'UploadId')!;
          if (!key || !uploadId) throw new Error();
          return { key, uploadId };
        });
        return { uploads, nextKeyMarker: truncated === 'true' ? nextKeyMarker : undefined, nextUploadIdMarker: truncated === 'true' ? nextUploadIdMarker : undefined };
      } catch { throw new Error('Invalid S3 listing response'); }
    }
  };
}
