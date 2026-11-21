import { hashMultipartPart, isMultipartSize, multipartPartCount, partBytes, sha256HexLength } from './multipart-upload-plan';

export interface UploadResumeEvidence {
  readonly declaredSize: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly sizeBytes: number;
    /** Lowercase hexadecimal SHA-256 of the exact acknowledged bytes. */
    readonly sha256: string;
  }[];
}

const nonHex = /[^0-9a-f]/;

type VerifiedUploadPrefix = { readonly parts: number; readonly bytes: number };

function hasFields(value: unknown, ...fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

/**
 * Verify the entire prefix for this Blob and evidence fetched for the caller's chosen intent.
 * Null means invalid or uncertain; { parts: 0, bytes: 0 } is a valid empty prefix.
 * The result proves neither the remaining bytes nor permission to dispatch an upload.
 */
export function verifyUploadResumePrefix(file: Blob, evidence: unknown): Promise<VerifiedUploadPrefix | null> {
  return verify(file, evidence, false);
}

/** Require the immutable full-file expectation as well as a matching acknowledged prefix. */
export function verifyBoundUploadResumePrefix(file: Blob, evidence: unknown): Promise<VerifiedUploadPrefix | null> {
  return verify(file, evidence, true);
}

async function verify(file: Blob, evidence: unknown, bound: boolean): Promise<VerifiedUploadPrefix | null> {
  try {
    const size = file.size;
    const fields = bound ? ['declaredSize', 'parts', 'expectedPartSha256s'] : ['declaredSize', 'parts'];
    if (!isMultipartSize(size) || !hasFields(evidence, ...fields) || evidence.declaredSize !== size) return null;

    const total = multipartPartCount(size);
    const vector = bound ? evidence.expectedPartSha256s : undefined;
    if (bound && (typeof vector !== 'string' || vector.length !== total * sha256HexLength || nonHex.test(vector)))
      return null;

    const parts = evidence.parts;
    if (!Array.isArray(parts)) return null;
    const count = parts.length;
    if (!Number.isInteger(count) || count < 0 || count > total) return null;

    // Validate the whole projection before any reads, keeping only the hashes across awaits.
    const hashes: string[] = [];
    for (let index = 0; index < count; index++) {
      if (!Object.hasOwn(parts, index)) return null;
      const part: unknown = parts[index];
      if (!hasFields(part, 'partNumber', 'sizeBytes', 'sha256')) return null;
      const { partNumber, sizeBytes, sha256 } = part;
      if (partNumber !== index + 1 || sizeBytes !== Math.min(partBytes, size - index * partBytes) ||
          typeof sha256 !== 'string' || sha256.length !== sha256HexLength || nonHex.test(sha256)) return null;
      hashes.push(sha256);
    }

    if (typeof vector === 'string' && !vector.startsWith(hashes.join(''))) return null;
    for (let index = 0; index < (bound ? total : count); index++) {
      const offset = index * partBytes;
      const digestOffset = index * sha256HexLength;
      const expected = typeof vector === 'string' ? vector.slice(digestOffset, digestOffset + sha256HexLength) : hashes[index];
      if (await hashMultipartPart(file, offset, Math.min(offset + partBytes, size)) !== expected) return null;
    }
    return { parts: count, bytes: Math.min(count * partBytes, size) };
  } catch {
    return null;
  }
}
