import { readJsonWithin } from './bounded-json.ts';
import { validateName } from './entry-name.ts';

export type ShareRecipient = { recipientId: string; displayName: string | null };
export type ShareAccess = ShareRecipient & { direct: boolean; inheritedFrom: string | null };
type DirectGrant = Pick<ShareRecipient, 'recipientId'>;
type Page<T> = { recipients: T[]; nextCursor: string | null };

type ReadOptions = { cursor?: string; signal?: AbortSignal };

const pageSize = 100;
// Covers one full page of bounded IDs and labels, including JSON escaping.
const pageBytes = 320 * 1024;
const encoder = new TextEncoder();

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value) && encoder.encode(value).length <= 512;
}

const isPathId = (id: string) => id !== '.' && id !== '..';

function encodeId(id: string, pathSegment = false): string {
  if (!isId(id) || (pathSegment && !isPathId(id))) throw new TypeError('Invalid Share ID');
  return encodeURIComponent(id).replaceAll("'", '%27');
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Share response');
  return value as Record<string, unknown>;
}

function effectiveRecipient(recipientId: string, { displayName, direct, inheritedFrom }: Record<string, unknown>): ShareAccess {
  if (!isPathId(recipientId)) throw new Error('Invalid Share recipient');
  if (displayName !== null && (typeof displayName !== 'string' || displayName.length > 128 ||
      [...displayName].length > 64 || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(displayName))) throw new Error('Invalid Share name');
  if (typeof direct !== 'boolean' || (inheritedFrom !== null && typeof inheritedFrom !== 'string')) {
    throw new Error('Invalid Share access');
  }
  if (inheritedFrom !== null) validateName(inheritedFrom);
  return { recipientId, displayName, direct, inheritedFrom };
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
    let body: unknown;
    try {
      body = await readJsonWithin(response, pageBytes);
    } catch {
      signal?.throwIfAborted();
      throw new Error('Invalid Share response');
    }
    const { recipients, nextCursor } = fields(body);
    if (!Array.isArray(recipients) || recipients.length > pageSize ||
        (nextCursor !== null && (recipients.length !== pageSize || !isId(nextCursor) || nextCursor === cursor))) {
      throw new Error('Invalid Share page');
    }
    const ids = new Set(cursor === undefined ? [] : [cursor]);
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
    async listAccessPage({ cursor, signal }: ReadOptions = {}) {
      const { recipients, nextCursor } = await readPage('eligible-recipients', { cursor, signal }, effectiveRecipient);
      const access: ShareAccess[] = [];
      const candidates: ShareRecipient[] = [];
      for (const row of recipients) {
        if (row.direct || row.inheritedFrom !== null) access.push(row);
        else candidates.push({ recipientId: row.recipientId, displayName: row.displayName });
      }
      // Both views page through the same roster, even when one view has no rows.
      return { access, candidates, nextCursor, complete: cursor === undefined && nextCursor === null };
    },
    listEligible: (options: ReadOptions = {}) => readPage('eligible-recipients', options, (recipientId, { displayName }) => {
      if (displayName !== null && typeof displayName !== 'string') throw new Error('Invalid Share name');
      return { recipientId, displayName };
    }),
    listDirectGrants: (options: ReadOptions = {}) => readPage('read-grants', options, (recipientId) => ({ recipientId })),
    grant: (recipientId: string) => change(recipientId, 'PUT'),
    revoke: (recipientId: string) => change(recipientId, 'DELETE'),
  };
}
