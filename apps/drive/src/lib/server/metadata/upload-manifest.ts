import { completionXml, type CompletedPart } from '../s3/multipart-completion';

// Validation does not establish provenance, dispatch completion, settle part writes,
// or authorize publication. Callers need trusted, fenced provider-operation evidence.
export function sealUploadManifest(parts: readonly CompletedPart[], expectedSize: number): {
  sealedManifest: string;
  sizeBytes: number;
} {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10_000 ||
      !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new TypeError('Invalid upload manifest');
  }
  const snapshot = parts.map((part) => {
    if (!part || typeof part.etag !== 'string') throw new TypeError('Invalid upload manifest');
    return { partNumber: part.partNumber, etag: part.etag, size: part.size };
  });
  // Reuse the exact provider completion constraints, including order, ETag syntax,
  // per-part limits and encoded document size; never reinterpret opaque ETags.
  completionXml(snapshot);
  const sizeBytes = snapshot.reduce((sum, part) => sum + part.size, 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== expectedSize) {
    throw new TypeError('Invalid upload manifest size');
  }
  return { sealedManifest: JSON.stringify(snapshot), sizeBytes };
}
