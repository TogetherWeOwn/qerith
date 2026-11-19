import { entryId } from '../download-id';
import { browseFolder, type BrowseResult } from './browse';
import { tokenHash } from './identity/sessions';
import { PrivateMetadata } from './metadata/private';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';

export interface RootListing {
  entries: { id: string; name: string; kind: 'file' | 'folder' }[];
  nextPage: string | null;
}

export type RootListingResult = BrowseResult<RootListing> | { status: 'invalid-page' };

type RootListingEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof PrivateMetadata>[0] };

// null starts the listing; undefined rejects a malformed continuation.
export function rootPageCursor(tokens: readonly string[]): string | null | undefined {
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && entryId.test(tokens[0])) return tokens[0];
}

export async function loadRootListing(request: Request, env: RootListingEnv, pageTokens: readonly string[]): Promise<RootListingResult> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const db = env.DB;
  if (!origin || !db) return { status: 'unavailable' };

  const result = await browseFolder(request, null, {
    async authorize(request) {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || !allowsOrigin(request, origin.origin)) return null;
      return readSession(request, db);
    },
    async readFolder({ principal, token }, parentId) {
      if (parentId !== null) return null;
      const cursor = rootPageCursor(pageTokens);
      if (cursor === undefined) return 'invalid-page' as const;
      const page = await new PrivateMetadata(db).list(principal.id, parentId, cursor, await tokenHash(token));
      if (!page || page === 'invalid-page') return page;
      return {
        entries: page.entries.map(({ id, name, kind }) => ({ id, name, kind })),
        nextPage: page.nextCursor
      };
    }
  });
  if (result.status === 'unavailable') return result;
  return result.folder === 'invalid-page' ? { status: 'invalid-page' } : { status: 'ok', folder: result.folder };
}
