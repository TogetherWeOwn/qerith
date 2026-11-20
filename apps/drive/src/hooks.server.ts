import { env } from 'cloudflare:workers';
import type { Handle } from '@sveltejs/kit/hooks';
import { listingRequest } from './lib/server/listing-routes';
import { privateRequests } from './lib/server/request-auth';

const handlePrivate = privateRequests(env);
export const handle: Handle = input => listingRequest(input.event.request, env) ?? handlePrivate(input);
