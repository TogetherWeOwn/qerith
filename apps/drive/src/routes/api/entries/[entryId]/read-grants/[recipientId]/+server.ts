import { env } from 'cloudflare:workers';
import { stagingReadGrantRequest } from '../../../../../../lib/server/read-grant-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const PUT: RequestHandler = ({ request, locals }) => stagingReadGrantRequest(request, env, locals.driveSession?.token ?? null);
export const DELETE = PUT;
