import type { Handle } from '@sveltejs/kit/hooks';
import { driveNext, isDrivePageNavigation } from '../drive-navigation';
import { downloadRedirect, downloadRoute, downloadSignIn, isDownloadDocumentNavigation, isDownloadNavigation } from './download-navigation';
import { Sessions } from './identity/sessions';

export interface DriveAuthEnv {
  DRIVE_SIGN_IN_FIXTURE?: string;
  DRIVE_ORIGIN?: string;
  DB?: ConstructorParameters<typeof Sessions>[0];
}

export const stagingOrigin = 'https://qerith-drive-staging.5150.workers.dev';

export function admitsSignInFixture(env: DriveAuthEnv): boolean {
  return env.DRIVE_SIGN_IN_FIXTURE === '1' && env.DRIVE_ORIGIN === 'https://drive.example.test' && !!env.DB;
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

function pageDenial(request: Request, status: 403 | 503): Response {
  const title = status === 403 ? 'Request blocked' : 'Drive unavailable';
  const message = status === 403 ? 'Open Drive directly and try again.' : 'Try again in a moment.';
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title} · Drive</title><main><h1>${title}</h1><p>${message}</p></main></html>`;
  return new Response(request.method === 'HEAD' ? null : body, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

export function privateRequests(env: DriveAuthEnv): Handle {
  return async ({ event, resolve }) => {
    const { request } = event;
    const { pathname, search } = new URL(request.url);
    const navigation = isDrivePageNavigation(request);
    const refuse = (status: 403 | 503) => navigation ? pageDenial(request, status) : deny(status);
    const origin = authOrigin(env.DRIVE_ORIGIN);
    if (!origin || !env.DB) {
      if (navigation) return pageDenial(request, 503);
      return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!allowsOrigin(request, origin.origin)) return refuse(403);

    const fixture = admitsSignInFixture(env);
    const routeId = event.route?.id;
    // Owner management is not admitted in preview, even before authentication.
    if ((fixture || origin.origin === stagingOrigin) && routeId?.startsWith('/api/owner/')) return deny(404);
    const signInPage = routeId === '/sign-in';
    if ((signInPage && (!fixture || !/^\/sign-in\/?$/.test(pathname))) ||
        /^\/(?:invite|recover|api\/sign-in)(?:\/|$)/.test(pathname)) return deny(404);

    let session;
    try {
      session = signInPage ? null : await readSession(request, env.DB);
    } catch {
      return refuse(503);
    }
    if (!session && !signInPage) {
      if (event.route?.id === downloadRoute) {
        const downloadNavigation = fixture ? isDownloadDocumentNavigation(request) : isDownloadNavigation(request);
        if (downloadNavigation) return downloadRedirect(downloadSignIn);
      }
      if (fixture && navigation) return downloadRedirect(`/sign-in?${new URLSearchParams({ next: driveNext(pathname + search) })}`);
      return deny(401);
    }
    if (session) event.locals.driveSession = session;

    const response = await resolve(event);
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control']) {
      headers.delete(name);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
