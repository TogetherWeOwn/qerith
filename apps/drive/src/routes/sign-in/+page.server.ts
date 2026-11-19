import { driveNext } from '../../lib/drive-navigation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
  const next = driveNext(url.searchParams.get('next'));
  return { next: next.split('?', 1)[0] === '/' ? next : '/' }; // Only root is admitted.
};
