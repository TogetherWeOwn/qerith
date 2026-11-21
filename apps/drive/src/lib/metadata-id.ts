const encoder = new TextEncoder();

// Stored IDs are opaque, not paths or necessarily UUIDs. Reject malformed text, never normalize it.
export function isMetadataId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 512 &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id) && encoder.encode(id).length <= 512;
}

export function entryChangePath(id: string): string | undefined {
  // Dot segments would be normalized by the browser even if percent-encoded.
  if (isMetadataId(id) && id !== '.' && id !== '..') return `/api/entries/${encodeURIComponent(id).replaceAll("'", '%27')}`;
}
