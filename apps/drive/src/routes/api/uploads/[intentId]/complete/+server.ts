import { env } from 'cloudflare:workers';
import { ownerStorageRuntime, storageUnavailable, wireUploadStorage } from '../../../../../lib/server/storage-runtime';
import { uploadRoutes } from '../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const owner = await ownerStorageRuntime(env, request.signal);
  if (owner && owner.status !== 'connected') return storageUnavailable(owner.status);
  return uploadRoutes(owner?.upload ?? wireUploadStorage(env), owner && { fetch: owner.fetch, timeoutMs: 5000 })
    .complete(request, locals.driveSession, params.intentId);
};
