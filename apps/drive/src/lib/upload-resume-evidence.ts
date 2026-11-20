export interface UploadResumeEvidence {
  readonly declaredSize: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly sizeBytes: number;
    /** Lowercase hexadecimal SHA-256 of the exact acknowledged bytes. */
    readonly sha256: string;
  }[];
}

// Match the sequential picker and its server evidence projection.
const partBytes = 16 * 1024 * 1024;
const maxBytes = 5 * 1024 ** 3;
const sha256Pattern = /^[0-9a-f]{64}$/;

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
export async function verifyUploadResumePrefix(file: Blob, evidence: unknown): Promise<VerifiedUploadPrefix | null> {
  try {
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes ||
        !hasFields(evidence, 'declaredSize', 'parts') || evidence.declaredSize !== size) return null;

    const parts = evidence.parts;
    if (!Array.isArray(parts)) return null;
    const count = parts.length;
    if (!Number.isInteger(count) || count < 0 || count > Math.max(1, Math.ceil(size / partBytes))) return null;

    // Validate the whole projection before any reads, keeping only the hashes across awaits.
    const hashes: string[] = [];
    for (let index = 0; index < count; index++) {
      if (!Object.hasOwn(parts, index)) return null;
      const part: unknown = parts[index];
      if (!hasFields(part, 'partNumber', 'sizeBytes', 'sha256')) return null;
      const { partNumber, sizeBytes, sha256 } = part;
      if (partNumber !== index + 1 || sizeBytes !== Math.min(partBytes, size - index * partBytes) ||
          typeof sha256 !== 'string' || sha256.length !== 64 || !sha256Pattern.test(sha256)) return null;
      hashes.push(sha256);
    }

    let offset = 0;
    for (const expected of hashes) {
      const end = Math.min(offset + partBytes, size);
      const bytes = await file.slice(offset, end).arrayBuffer();
      if (bytes.byteLength !== end - offset) return null;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== expected) return null;
      offset = end;
    }
    return { parts: hashes.length, bytes: offset };
  } catch {
    return null;
  }
}
