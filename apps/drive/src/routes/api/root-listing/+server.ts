import { env } from 'cloudflare:workers';
import { admitsSignInFixture } from '../../../lib/server/request-auth';
import { loadRootListing } from '../../../lib/server/root-listing';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
  if (!admitsSignInFixture(env)) return new Response(null, { status: 404 });
  const listing = await loadRootListing(request, env, url.searchParams.getAll('page'));
  return Response.json(listing, { status: listing.status === 'ok' ? 200 : listing.status === 'invalid-page' ? 400 : 503 });
};
