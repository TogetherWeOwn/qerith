// The sequential upload contract uses one empty part for a zero-byte file.
export const partBytes = 16 * 1024 ** 2;
export const multipartFileLimit = 5 * 1024 ** 3;
export const sha256HexLength = 64;

export function multipartPartCount(size: number): number {
  return Math.max(1, Math.ceil(size / partBytes));
}

export function isMultipartSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= multipartFileLimit;
}

export async function hashMultipartPart(file: Blob, offset: number, end: number): Promise<string> {
  const bytes = await file.slice(offset, end).arrayBuffer();
  if (bytes.byteLength !== end - offset) throw new Error('incomplete part read');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Hash one slice at a time; only the packed hex vector survives between parts. */
export async function hashMultipartFile(file: Blob): Promise<string> {
  const size = file.size;
  if (!isMultipartSize(size)) throw new Error('invalid multipart size');
  let packed = '';
  for (let index = 0; index < multipartPartCount(size); index++) {
    const offset = index * partBytes;
    packed += await hashMultipartPart(file, offset, Math.min(offset + partBytes, size));
  }
  return packed;
}
