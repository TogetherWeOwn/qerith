import { browseFolder, type BrowseResult } from './browse';
import { tokenHash } from './identity/sessions';
import { decodeCursor, encodeCursor } from './metadata/listing-cursor';
import { PrivateMetadata } from './metadata/private';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';

export interface RootListing {
  entries: { id: string; name: string; kind: 'file' | 'folder' }[];
  nextPage: string | null;
}

const rootScope = 'my-drive-root';

type RootListingEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof PrivateMetadata>[0] };

export function loadRootListing(request: Request, env: RootListingEnv, pageTokens: readonly string[]): Promise<BrowseResult<RootListing>> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const db = env.DB;
  if (!origin || !db) return Promise.resolve({ status: 'unavailable' });

  return browseFolder(request, null, {
    async authorize(request) {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || !allowsOrigin(request, origin.origin)) return null;
      return readSession(request, db);
    },
    async readFolder({ principal, token }, parentId) {
      if (parentId !== null || pageTokens.length > 1) return null;
      // The cursor selects a boundary within the authenticated root, not a principal or folder.
      const cursor = pageTokens.length ? decodeCursor(pageTokens[0], rootScope, 'asc') : null;
      if (pageTokens.length && cursor === null) return null;
      const page = await new PrivateMetadata(db).list(principal.id, parentId, cursor, await tokenHash(token));
      if (!page) return null;
      return {
        entries: page.entries.map(({ id, name, kind }) => ({ id, name, kind })),
        nextPage: page.nextCursor === null ? null : encodeCursor(page.nextCursor, rootScope, 'asc')
      };
    }
  });
}
