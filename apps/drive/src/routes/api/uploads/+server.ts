import { env } from 'cloudflare:workers';
import { postUploadIntent } from '../../../lib/server/upload-intent';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = ({ request }) => postUploadIntent(request, env);
