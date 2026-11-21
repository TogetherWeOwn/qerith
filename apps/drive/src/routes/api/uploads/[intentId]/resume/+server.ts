import { env } from 'cloudflare:workers';
import { wireUploadStorage } from '../../../../../lib/server/storage-runtime';
import { uploadRoutes } from '../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = ({ request, params }) =>
  uploadRoutes(wireUploadStorage(env)).stagingResume(request, params.intentId);
