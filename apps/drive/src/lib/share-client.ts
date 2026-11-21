export type ShareRecipient = { recipientId: string; displayName: string | null };
type DirectGrant = Pick<ShareRecipient, 'recipientId'>;
type Page<T> = { recipients: T[]; nextCursor: string | null };

type ReadOptions = { cursor?: string; signal?: AbortSignal };

const pageSize = 100;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value) && new TextEncoder().encode(value).length <= 512;
}

function encodeId(id: string, pathSegment = false): string {
  if (!isId(id) || (pathSegment && (id === '.' || id === '..'))) throw new TypeError('Invalid Share ID');
  return encodeURIComponent(id).replaceAll("'", '%27');
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Share response');
  return value as Record<string, unknown>;
}

// Bind every read and write to one entry; names are labels, never mutation targets.
export function entryShare(entryId: string, fetcher: typeof fetch = fetch) {
  const path = `/api/entries/${encodeId(entryId, true)}`;
  const request = { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store' } as const;

  async function readPage<T extends DirectGrant>(resource: string, { cursor, signal }: ReadOptions,
    project: (recipientId: string, row: Record<string, unknown>) => T): Promise<Page<T>> {
    const query = cursor === undefined ? '' : `?cursor=${encodeId(cursor)}`;
    const response = await fetcher(`${path}/${resource}${query}`, { ...request, signal });
    if (response.status !== 200) throw new Error('Share list unavailable');
    const { recipients, nextCursor } = fields(await response.json());
    if (!Array.isArray(recipients) || recipients.length > pageSize ||
        (nextCursor !== null && (recipients.length !== pageSize || !isId(nextCursor) || nextCursor === cursor))) {
      throw new Error('Invalid Share page');
    }
    const ids = new Set<string>();
    const items = recipients.map((value: unknown) => {
      const row = fields(value);
      if (!isId(row.recipientId) || ids.has(row.recipientId)) throw new Error('Invalid Share recipient');
      ids.add(row.recipientId);
      return project(row.recipientId, row);
    });
    if (nextCursor !== null && nextCursor !== items.at(-1)?.recipientId) throw new Error('Invalid Share page');
    return { recipients: items, nextCursor };
  }

  async function change(recipientId: string, method: 'PUT' | 'DELETE'): Promise<void> {
    const response = await fetcher(`${path}/read-grants/${encodeId(recipientId, true)}`, { ...request, method });
    if (response.status !== 204) throw new Error('Share change not confirmed');
  }

  return {
    listEligible: (options: ReadOptions = {}) => readPage('eligible-recipients', options, (recipientId, { displayName }) => {
      if (displayName !== null && typeof displayName !== 'string') throw new Error('Invalid Share name');
      return { recipientId, displayName };
    }),
    listDirectGrants: (options: ReadOptions = {}) => readPage('read-grants', options, (recipientId) => ({ recipientId })),
    grant: (recipientId: string) => change(recipientId, 'PUT'),
    revoke: (recipientId: string) => change(recipientId, 'DELETE'),
  };
}
