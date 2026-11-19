import { browseFolder, type BrowseResult } from './browse';
import { PrivateMetadata, validateName, type Cursor } from './metadata/private';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';

export interface RootListing {
  entries: { id: string; name: string; kind: 'file' | 'folder' }[];
  nextPage: string | null;
}

function encodePage({ name, id }: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(['root-v1', name, id]));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodePage(token: string): Cursor {
  if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError('Invalid page');
  const bytes = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'root-v1' ||
      typeof value[2] !== 'string' || !value[2] || value[2].length > 128 || value[2].includes('\0')) {
    throw new TypeError('Invalid page');
  }
  const [, name, id] = value;
  validateName(name);
  const cursor = { name, id };
  if (encodePage(cursor) !== token) throw new TypeError('Invalid page');
  return cursor;
}

type RootListingEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof PrivateMetadata>[0] };

export function loadRootListing(request: Request, env: RootListingEnv, pageTokens: readonly string[]): Promise<BrowseResult<RootListing>> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const db = env.DB;
  if (!origin || !db) return Promise.resolve({ status: 'unavailable' });

  return browseFolder(request, null, {
    async authorize(request) {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || !allowsOrigin(request, origin.origin)) return null;
      return (await readSession(request, db))?.principal.id ?? null;
    },
    async readFolder(principalId, parentId) {
      if (pageTokens.length > 1) return null;
      // The cursor selects a boundary within the authenticated root, not a principal or folder.
      const cursor = pageTokens.length ? decodePage(pageTokens[0]) : null;
      const { entries, nextCursor } = await new PrivateMetadata(db).list(principalId, parentId, cursor);
      return {
        entries: entries.map(({ id, name, kind }) => ({ id, name, kind })),
        nextPage: nextCursor === null ? null : encodePage(nextCursor)
      };
    }
  });
}
