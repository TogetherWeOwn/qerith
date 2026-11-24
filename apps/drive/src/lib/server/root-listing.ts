import { entryId } from '../download-id';
import { browseFolder, type BrowseResult } from './browse';
import { tokenHash } from './identity/sessions';
import { PrivateMetadata } from './metadata/private';
import { admitsStagingInvite, allowsOrigin, authOrigin, readSession, privateDriveOrigin, type DriveAuthEnv } from './request-auth';
import { storageIdentity, type StorageBindings } from './storage-runtime';

export interface RootListing {
  entries: { id: string; name: string; kind: 'file' | 'folder'; downloadable?: boolean }[];
  nextPage: string | null;
}

export type RootListingResult = BrowseResult<RootListing> | { status: 'invalid-page' };

type ListingDatabase = ConstructorParameters<typeof PrivateMetadata>[0];
type RootListingEnv = DriveAuthEnv & StorageBindings & {
  DB?: ListingDatabase & { withSession?(constraint: 'first-primary'): ListingDatabase };
};

// null starts the listing; undefined rejects a malformed continuation.
export function rootPageCursor(tokens: readonly string[]): string | null | undefined {
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && entryId.test(tokens[0])) return tokens[0];
}

export async function loadRootListing(request: Request, env: RootListingEnv, pageTokens: readonly string[],
  storage = storageIdentity(env)): Promise<RootListingResult> {
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
      const inviteMode = admitsStagingInvite(env);
      const ownerOnly = privateDriveOrigin(env) !== null && !inviteMode;
      const invitee = inviteMode && principal.role === 'member';
      const identity = invitee ? storage : null;
      const primary = identity && db.withSession?.('first-primary');
      const page = await new PrivateMetadata(primary ?? db).list(principal.id, parentId, cursor, await tokenHash(token), ownerOnly,
        primary && identity ? [identity.settings.endpoint, identity.settings.bucket, identity.epoch] : undefined);
      if (!page || page === 'invalid-page') return page;
      return {
        entries: page.entries.map(({ id, name, kind, downloadable }) => invitee && kind === 'file' ?
          { id, name, kind, downloadable: downloadable === 1 } : { id, name, kind }),
        nextPage: page.nextCursor
      };
    }
  });
  if (result.status === 'unavailable') return result;
  return result.folder === 'invalid-page' ? { status: 'invalid-page' } : { status: 'ok', folder: result.folder };
}
