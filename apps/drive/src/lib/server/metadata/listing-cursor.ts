export type ListingDirection = 'asc' | 'desc';
export interface ListingBoundary { kind: 'file' | 'folder'; name: string }

const maxCursorLength = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64url(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid encoding');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new TypeError('Noncanonical encoding');
  return bytes;
}

// This is a scope discriminator, not proof of authorization. Do not serialize
// unrestricted folder IDs or depend on the boundary row still existing.
export async function folderScope(folderId: string): Promise<string> {
  const preimage = encoder.encode(JSON.stringify(['drive:list:scope:v2', 'folder', folderId]));
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', preimage)));
}

export function encodeCursor(boundary: ListingBoundary, scope: string, direction: ListingDirection): string {
  const n = base64url(encoder.encode(boundary.name));
  const token = base64url(encoder.encode(JSON.stringify({ v: 2, s: scope, o: 'binary-name', d: direction, k: boundary.kind, n })));
  if (token.length > maxCursorLength) throw new TypeError('Cursor too large');
  return token;
}

export function decodeCursor(cursor: string, scope: string, direction: ListingDirection): ListingBoundary | null {
  try {
    if (typeof cursor !== 'string' || cursor.length > maxCursorLength) return null;
    const value = JSON.parse(decoder.decode(decodeBase64url(cursor)));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'd,k,n,o,s,v' || value.v !== 2 || value.s !== scope ||
        value.o !== 'binary-name' || value.d !== direction || (value.k !== 'file' && value.k !== 'folder')) return null;
    const bytes = decodeBase64url(value.n);
    if (bytes.length > 255) return null;
    const name = decoder.decode(bytes);
    if (!name.replace(/^[ .]+|[ .]+$/g, '') || name.includes('/') || name.includes('\0')) return null;
    return { kind: value.k, name };
  } catch {
    return null;
  }
}
