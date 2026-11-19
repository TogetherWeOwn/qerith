import { env } from 'cloudflare:workers';
import { uploadRoutes } from '../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = ({ request, params, locals }) =>
  uploadRoutes(env).complete(request, locals.driveSession, params.intentId);
