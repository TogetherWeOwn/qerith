import type { Handle } from '@sveltejs/kit/hooks';
import { downloadRedirect, downloadRoute, downloadSignIn, isDownloadNavigation } from './download-navigation';
import { Sessions } from './identity/sessions';

export interface DriveAuthEnv {
  DRIVE_ORIGIN?: string;
  DB?: ConstructorParameters<typeof Sessions>[0];
}

export const sessionCookie = '__Host-drive-session';

export function authOrigin(value?: string): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url : null;
  } catch {
    return null;
  }
}

export function allowsOrigin(request: Request, origin: string): boolean {
  if (new URL(request.url).origin !== origin) return false;
  const source = request.headers.get('origin');
  return source === origin || (source === null && (request.method === 'GET' || request.method === 'HEAD'));
}

export function readOpaqueCookie(request: Request, cookieName: string, pattern: RegExp): string | null {
  const header = request.headers.get('cookie');
  // A comma may be a joined Cookie field, never part of a cookie-pair.
  if (header === null || /[^\t\x20-\x7e]|,/.test(header)) return null;
  let token: string | null = null;
  for (const cookie of header.split(';')) {
    const pair = cookie.trimStart();
    const equals = pair.indexOf('=');
    const name = equals === -1 ? pair : pair.slice(0, equals);
    if (name.trimEnd() !== cookieName) continue;
    if (name !== cookieName || equals === -1 || token !== null) return null;
    const value = pair.slice(equals + 1);
    if (!pattern.test(value)) return null;
    token = value;
  }
  return token;
}

export async function readSession(request: Request, db: NonNullable<DriveAuthEnv['DB']>) {
  const token = readOpaqueCookie(request, sessionCookie, /^[A-Za-z0-9_-]{43}$/);
  if (token === null) return null;
  // Use the primary binding and re-read membership on every private request.
  const principal = await new Sessions(db).lookup(token);
  return principal === null ? null : { principal, token };
}

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });
}

export function privateRequests(env: DriveAuthEnv): Handle {
  return async ({ event, resolve }) => {
    const origin = authOrigin(env.DRIVE_ORIGIN);
    if (!origin || !env.DB) {
      return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!allowsOrigin(event.request, origin.origin)) return deny(403);

    let session;
    try {
      session = await readSession(event.request, env.DB);
    } catch {
      return deny(503);
    }
    if (!session) return event.route?.id === downloadRoute && isDownloadNavigation(event.request)
      ? downloadRedirect(downloadSignIn) : deny(401);
    event.locals.driveSession = session;

    const response = await resolve(event);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control']) {
      headers.delete(name);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
