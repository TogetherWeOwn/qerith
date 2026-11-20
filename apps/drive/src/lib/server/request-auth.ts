import type { Handle } from '@sveltejs/kit/hooks';
import { driveNext, isDrivePageNavigation, isTopLevelDocumentNavigation } from '../drive-navigation';
import { downloadRedirect, downloadRoute, downloadSignIn, isDownloadDocumentNavigation, isDownloadNavigation, isExactDownloadGet } from './download-navigation';
import { Sessions } from './identity/sessions';
import { ownerLifecycleRoute } from './owner-lifecycle-route';

export interface DriveAuthEnv {
  DRIVE_SIGN_IN_FIXTURE?: string;
  DRIVE_STAGING_INVITE_ACCEPTANCE?: string;
  DRIVE_ORIGIN?: string;
  DB?: ConstructorParameters<typeof Sessions>[0];
}

export const stagingOrigin = 'https://qerith-drive-staging.5150.workers.dev';

export function admitsSignInFixture(env: DriveAuthEnv): boolean {
  return env.DRIVE_SIGN_IN_FIXTURE === '1' && env.DRIVE_ORIGIN === 'https://drive.example.test' && !!env.DB;
}

// Default-off staging mode for invitation lifecycle, acceptance and member My Drive.
export function admitsStagingInvite(env: Pick<DriveAuthEnv, 'DRIVE_ORIGIN' | 'DRIVE_STAGING_INVITE_ACCEPTANCE'>): boolean {
  return env.DRIVE_ORIGIN === stagingOrigin && env.DRIVE_STAGING_INVITE_ACCEPTANCE === '1';
}

export function allowsStagingInviteSite(request: Request, document = false): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site === null || site === 'same-origin') return true;
  return document && request.method === 'GET' && isTopLevelDocumentNavigation(request) &&
    (site === 'none' || site === 'same-site' || site === 'cross-site');
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

export function readSessionToken(request: Request): string | null {
  return readOpaqueCookie(request, sessionCookie, /^[A-Za-z0-9_-]{43}$/);
}

export async function readSession(request: Request, db: NonNullable<DriveAuthEnv['DB']>) {
  const token = readSessionToken(request);
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
    const url = new URL(request.url);
    const { pathname, search } = url;
    const navigation = isDrivePageNavigation(request);
    const refuse = (status: 403 | 503) => navigation ? pageDenial(request, status) : deny(status);
    const origin = authOrigin(env.DRIVE_ORIGIN);
    if (!origin || !env.DB) {
      if (navigation) return pageDenial(request, 503);
      return new Response('Service unavailable', { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    if (!allowsOrigin(request, origin.origin)) return refuse(403);

    const fixture = admitsSignInFixture(env);
    const staging = origin.origin === stagingOrigin;
    const routeId = event.route?.id;
    const peoplePage = routeId === '/people';
    if (peoplePage && (!admitsStagingInvite(env) || request.url !== `${stagingOrigin}/people` ||
        (request.method !== 'GET' && request.method !== 'HEAD'))) return deny(404);
    if ((fixture || staging) && routeId?.startsWith('/api/owner/')) {
      if (fixture || !admitsStagingInvite(env) || ownerLifecycleRoute(request, url) !== routeId) return deny(404);
      if (!allowsStagingInviteSite(request)) return deny(403);
    }
    const signInPage = routeId === '/sign-in';
    const invitePage = routeId === '/invite' && (fixture || admitsStagingInvite(env)) &&
      request.url === `${origin.origin}/invite` && (request.method === 'GET' || request.method === 'HEAD');
    if (invitePage && staging && !allowsStagingInviteSite(request, true)) return deny(403);
    if ((signInPage && !(staging ? pathname === '/sign-in' : fixture && /^\/sign-in\/?$/.test(pathname))) ||
        (!invitePage && (routeId === '/invite' || /^\/invite(?:\/|$)/.test(pathname))) ||
        /^\/(?:recover|api\/(?:invite|sign-in))(?:\/|$)/.test(pathname)) return deny(404);

    let session;
    try {
      // The document is public, including a cross-site link. Only HEAD reads session state.
      session = signInPage || (invitePage && request.method === 'GET') ? null : await readSession(request, env.DB);
    } catch {
      return refuse(503);
    }
    if (invitePage && request.method === 'HEAD') {
      return new Response(null, { status: session ? 204 : 200,
        headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
    }
    if (peoplePage && session?.principal.role !== 'owner') return deny(session ? 404 : 401);
    if (staging && session && session.principal.role !== 'owner') {
      const memberRoot = routeId === '/' &&
        ((pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) ||
         (pathname === '/__data.json' && request.method === 'GET'));
      const site = request.headers.get('sec-fetch-site');
      const memberDownload = routeId === downloadRoute && isExactDownloadGet(request.method, pathname) &&
        (site === null || site === 'same-origin' || site === 'none');
      if (!admitsStagingInvite(env) || !(memberRoot || memberDownload)) {
        return deny(pathname === '/' && request.method === 'HEAD' ? 401 : 403);
      }
    }
    if (!session && !signInPage && !invitePage) {
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
    if (invitePage) headers.set('referrer-policy', 'no-referrer');
    for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control']) {
      headers.delete(name);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
