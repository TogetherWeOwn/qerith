import type { Handle } from '@sveltejs/kit';

// The app remains unavailable until live session and membership checks are wired.
export const handle: Handle = async () =>
  new Response('Service unavailable', {
    status: 503,
    headers: { 'cache-control': 'no-store' }
  });
