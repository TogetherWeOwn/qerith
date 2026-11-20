import { env } from 'cloudflare:workers';
import { driveNext } from '../../lib/drive-navigation';
import { admitsStagingInvite } from '../../lib/server/request-auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
  const next = driveNext(url.searchParams.get('next'));
  return { next: next.split('?', 1)[0] === '/' || (next === '/people' && admitsStagingInvite(env)) ? next : '/' };
};
