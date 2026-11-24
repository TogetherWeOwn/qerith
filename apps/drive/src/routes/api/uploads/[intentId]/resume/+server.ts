import { env } from 'cloudflare:workers';
import { ownerStorageRuntime, storageUnavailable, wireUploadStorage } from '../../../../../lib/server/storage-runtime';
import { uploadRoutes } from '../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = async ({ request, params }) => {
  const owner = await ownerStorageRuntime(env);
  if (owner && owner.status !== 'connected') return storageUnavailable(owner.status);
  return uploadRoutes(owner?.upload ?? wireUploadStorage(env)).stagingResume(request, params.intentId);
};
