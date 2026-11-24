import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { usesOwnerStorage } from '../../../lib/server/qualification-readiness';
import { admitsStagingInvite } from '../../../lib/server/request-auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
  if (!usesOwnerStorage(env)) error(404);
  if (!locals.driveSession) error(401);
  if (locals.driveSession.principal.role !== 'owner') error(403);
  return { ownerInvites: admitsStagingInvite(env) };
};
