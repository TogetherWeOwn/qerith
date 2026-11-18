import type { Handle } from '@sveltejs/kit/hooks';
import { allowsOrigin, authOrigin, readSession } from './lib/server/request-auth';

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });
}

export const handle: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  const origin = authOrigin(env?.DRIVE_ORIGIN);
  if (!origin || !env?.DB) {
    return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (!allowsOrigin(event.request, origin.origin)) return deny(403);

  let session;
  try {
    session = await readSession(event.request, env.DB);
  } catch {
    return deny(503);
  }
  if (!session) return deny(401);
  event.locals.driveSession = session;

  const response = await resolve(event);
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
