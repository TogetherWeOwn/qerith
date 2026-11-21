import { env } from 'cloudflare:workers';
import { getEligibleRecipients } from '../../../../../lib/server/eligible-recipient-route';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = ({ request, locals }) => getEligibleRecipients(request, env, locals.driveSession?.token ?? null);
