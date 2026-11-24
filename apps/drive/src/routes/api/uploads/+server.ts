import { env } from 'cloudflare:workers';
import { privateDriveOrigin } from '../../../lib/server/request-auth';
import { ownerStorageRuntime, storageUnavailable, wireUploadStorage } from '../../../lib/server/storage-runtime';
import { postUploadIntent } from '../../../lib/server/upload-intent';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = async ({ request }) => {
  const owner = await ownerStorageRuntime(env);
  if (owner) return owner.status === 'connected'
    ? postUploadIntent(request, owner.upload, { fetch: owner.fetch, timeoutMs: 5000 }) : storageUnavailable(owner.status);
  return postUploadIntent(request, privateDriveOrigin(env) !== null ? wireUploadStorage(env) : env);
};
