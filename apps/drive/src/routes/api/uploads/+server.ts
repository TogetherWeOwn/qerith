import { env } from 'cloudflare:workers';
import { privateDriveOrigin } from '../../../lib/server/request-auth';
import { wireUploadStorage } from '../../../lib/server/storage-runtime';
import { postUploadIntent } from '../../../lib/server/upload-intent';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = ({ request }) =>
  postUploadIntent(request, privateDriveOrigin(env) !== null ? wireUploadStorage(env) : env);
