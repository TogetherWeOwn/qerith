import { building } from '$app/env';
import { env } from 'cloudflare:workers';
import { admitsStagingInvite } from '../../../lib/server/request-auth';
import { loadFolder } from './load-folder';
import type { PageServerLoad } from './$types';

export const csr = !building && admitsStagingInvite(env);
export const load: PageServerLoad = loadFolder(env);
