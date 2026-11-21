import { env } from 'cloudflare:workers';
import { loadFolder } from './load-folder';
import type { PageServerLoad } from './$types';

export const csr = false;
export const load: PageServerLoad = loadFolder(env);
