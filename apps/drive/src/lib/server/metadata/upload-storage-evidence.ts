import { validateConfig, type S3Config } from '../s3/config';

export function uploadStorageEvidence(config: S3Config, epoch: string) {
  if (typeof epoch !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(epoch)) throw new TypeError('Invalid storage epoch');
  const settings = validateConfig(config);
  const { endpoint, bucket } = settings;
  if (endpoint.length > 2048) throw new TypeError('Invalid storage identity');
  return { settings, storageConfigId: JSON.stringify([endpoint, bucket, epoch]) };
}

export function uploadCompletionBudget(verifier: { completionTimeoutMs?(id: string): number | null }, id: string): number | null {
  const ms = verifier.completionTimeoutMs?.(id);
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= 0x7fffffff ? ms : null;
}

export function uploadIdentityBytes(value: string): ArrayBuffer {
  if (typeof value !== 'string' || !value || value.length > 196608 || !value.isWellFormed() || value.includes('\0')) throw new TypeError('Invalid upload identity');
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > 196608) throw new TypeError('Invalid upload identity');
  return bytes.buffer;
}

// D1 TEXT decoding can replace malformed bytes. Fail closed rather than pass a
// different identity to the verifier or signer; preserve a leading UTF-8 BOM.
const identityDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeUploadIdentity(hex: string): string {
  return identityDecoder.decode(Uint8Array.fromHex(hex));
}
