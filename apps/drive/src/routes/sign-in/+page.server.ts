import { env } from 'cloudflare:workers';
import { driveNext } from '../../lib/drive-navigation';
import { admitsSignInFixture, admitsStagingInvite } from '../../lib/server/request-auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
  const next = driveNext(url.searchParams.get('next'));
  const path = next.split('?', 1)[0];
  if (path.startsWith('/f/') && admitsSignInFixture(env)) return { next: path }; // Cursors are session-bound.
  return { next: path === '/' || (next === '/people' && admitsStagingInvite(env)) ? next : '/' };
};
