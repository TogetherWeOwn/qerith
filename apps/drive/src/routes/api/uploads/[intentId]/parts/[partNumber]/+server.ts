import { env } from 'cloudflare:workers';
import { uploadRoutes } from '../../../../../../lib/server/upload-routes';
import type { RequestHandler } from './$types';

// SvelteKit normalizes slashes before the private request hook.
export const trailingSlash = 'ignore';

export const PUT: RequestHandler = ({ request, params, locals }) =>
  uploadRoutes(env).part(request, locals.driveSession, params.intentId, params.partNumber);
