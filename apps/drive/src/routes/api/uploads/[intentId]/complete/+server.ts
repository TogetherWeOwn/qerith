import { env } from 'cloudflare:workers';
import { wireUploadStorage } from '../../../../../lib/server/storage-runtime';
import { uploadRoutes } from '../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = ({ request, params, locals }) =>
  uploadRoutes(wireUploadStorage(env)).complete(request, locals.driveSession, params.intentId);
