import { env } from 'cloudflare:workers';
import { stagingReadGrantRequest } from '../../../../../lib/server/read-grant-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = ({ request, locals }) => stagingReadGrantRequest(request, env, locals.driveSession?.token ?? null);
