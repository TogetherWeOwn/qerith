const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;

export type CompletedPart = { partNumber: number; etag: string; size: number };

/** Build a completion document without interpreting or reordering opaque ETags. */
export function completionXml(parts: readonly CompletedPart[]): Uint8Array {
  if (!parts.length || parts.length > MAX_PARTS) throw new Error('Invalid multipart part count');
  let previous = 0;
  let remaining = MAX_PART_BYTES - '<CompleteMultipartUpload></CompleteMultipartUpload>'.length;
  const entries = parts.map(({ partNumber, etag, size }, index) => {
    if (!Number.isInteger(partNumber) || partNumber <= previous || partNumber > MAX_PARTS) {
      throw new Error('Invalid multipart part order');
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PART_BYTES ||
        (index < parts.length - 1 && size < MIN_PART_BYTES)) {
      throw new Error('Invalid multipart part size');
    }
    // ETags are HTTP quoted opaque validators. XML 1.0 cannot represent controls
    // or unpaired surrogates, and an embedded quote is not valid etagc.
    if (etag.length > remaining) throw new Error('Multipart completion exceeds limit');
    if (!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) throw new Error('Invalid multipart ETag');
    previous = partNumber;
    const escaped = etag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const entry = `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escaped}</ETag></Part>`;
    remaining -= new TextEncoder().encode(entry).byteLength;
    if (remaining < 0) throw new Error('Multipart completion exceeds limit');
    return entry;
  });
  const body = new TextEncoder().encode(`<CompleteMultipartUpload>${entries.join('')}</CompleteMultipartUpload>`);
  if (body.byteLength > MAX_PART_BYTES) throw new Error('Multipart completion exceeds limit');
  return body;
}
