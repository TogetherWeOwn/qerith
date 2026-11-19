import { driveNext } from '../../lib/drive-navigation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({ next: driveNext(url.searchParams.get('next')) });
