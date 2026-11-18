import { env } from 'cloudflare:workers';
import { privateRequests } from './lib/server/request-auth';

export const handle = privateRequests(env);
