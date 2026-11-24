import { env } from 'cloudflare:workers';
import { ownerStorageRuntime, storageUnavailable, wireUploadStorage } from '../../../../../../lib/server/storage-runtime';
import { uploadRoutes } from '../../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

// SvelteKit normalizes slashes before the private request hook.
export const trailingSlash = 'ignore';

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const owner = await ownerStorageRuntime(env);
  if (owner && owner.status !== 'connected') return storageUnavailable(owner.status);
  return uploadRoutes(owner?.upload ?? wireUploadStorage(env), owner && { fetch: owner.fetch, timeoutMs: 5000 })
    .part(request, locals.driveSession, params.intentId, params.partNumber);
};
