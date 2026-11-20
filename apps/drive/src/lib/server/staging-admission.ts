import { isTopLevelDocumentNavigation } from '../drive-navigation';
import { downloadRedirect, downloadSignIn, isExactDownloadGet } from './download-navigation';
import { Sessions } from './identity/sessions';
import { ownerLifecycleRoute } from './owner-lifecycle-route';
import { admitsStagingInvite, allowsOrigin, allowsStagingInviteSite, driveUploadMode, readSessionToken, stagingOrigin, type DriveAuthEnv } from './request-auth';
import { uploadAdmissionRoute } from './upload-admission';

interface PreviewAssets {
  signIn: ReadonlySet<string>;
  root: ReadonlySet<string>;
  invite: ReadonlySet<string>;
  people: ReadonlySet<string>;
}

type CeremonyStep = 'challenge' | 'restart' | 'verify';
type InviteStep = 'present' | 'challenge' | 'enroll';
type Target = { kind: 'sign-in' | 'public-asset' | 'root-data' | 'download' | 'upload' | 'invite' | 'invite-asset' | 'owner-lifecycle' | 'people' } |
  { kind: 'ceremony'; step: CeremonyStep } | { kind: 'invite-ceremony'; step: InviteStep } |
  { kind: 'private-asset' | 'people-asset' | 'root'; deadline?: number };

interface PreviewDispatch {
  adapter(request: Request): Promise<Response>;
  ceremony(request: Request, step: CeremonyStep): Promise<Response>;
  invite(request: Request, step: InviteStep): Promise<Response>;
  asset(request: Request): Promise<Response>;
}

function route(request: Request, url: URL, assets: PreviewAssets, invite: boolean): Target | null {
  const { method } = request;
  const { pathname: path } = url;
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/sign-in') return { kind: 'sign-in' };
    if (invite && path === '/invite') return { kind: 'invite' };
    if (invite && path === '/people') return { kind: 'people' };
    if (path === '/') return { kind: 'root' };
    if (method === 'GET' && path === '/__data.json') return { kind: 'root-data' };
    // Trust exact build-time entries only. Shared dependencies needed by sign-in are public.
    if (path.startsWith('/_app/immutable/')) {
      if (assets.signIn.has(path)) return { kind: 'public-asset' };
      if (invite && assets.invite.has(path)) return { kind: 'invite-asset' };
      if (assets.root.has(path)) return { kind: 'private-asset' };
      if (invite && assets.people.has(path)) return { kind: 'people-asset' };
    }
  }
  const [, api, resource, id, action] = path.split('/', 5);
  if (api !== 'api') return null;
  if (method === 'POST' && resource === 'sign-in' && action === undefined &&
      (id === 'challenge' || id === 'restart' || id === 'verify')) return { kind: 'ceremony', step: id };
  if (invite && method === 'POST' && resource === 'invite' && action === undefined &&
      (id === 'present' || id === 'challenge' || id === 'enroll')) return { kind: 'invite-ceremony', step: id };
  if (isExactDownloadGet(method, path)) return { kind: 'download' };
  return uploadAdmissionRoute(request, url) ? { kind: 'upload' } : null;
}

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });
}

// The generated Worker calls this before dispatch. Storage readiness comes from
// the live storage composition, never a fixture flag or request-supplied value.
export async function admitStagingRequest(request: Request, env: DriveAuthEnv, storageReady: boolean,
  assets: PreviewAssets): Promise<Target | Response> {
  if (env.DRIVE_ORIGIN !== stagingOrigin || typeof env.DB?.prepare !== 'function' || !storageReady) return deny(503);
  if (!allowsOrigin(request, stagingOrigin)) return deny(403);
  const url = new URL(request.url);
  const { pathname, search } = url;
  const invite = admitsStagingInvite(env);
  const target: Target | null = invite && ownerLifecycleRoute(request, url)
    ? { kind: 'owner-lifecycle' } : route(request, url, assets, invite);
  if (!target) return deny(404);
  if (target.kind === 'owner-lifecycle' && !allowsStagingInviteSite(request)) return deny(403);
  if (target.kind === 'invite' || target.kind === 'invite-asset' || target.kind === 'invite-ceremony') {
    // Do not admit queries (even a bare '?') or rely on decoded/rewritten paths.
    if (request.url !== stagingOrigin + pathname) return deny(404);
    return allowsStagingInviteSite(request, target.kind === 'invite') ? target : deny(403);
  }
  const ownerPage = target.kind === 'people' || target.kind === 'people-asset';
  if (ownerPage && request.url !== stagingOrigin + pathname) return deny(404);
  const site = request.headers.get('sec-fetch-site');
  const navigation = isTopLevelDocumentNavigation(request);
  const signInRedirect = () => downloadRedirect(`/sign-in?${new URLSearchParams({ next: pathname + search })}`);
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    // A cross-site document visit may reach sign-in, but never reads private state.
    if (navigation && target.kind === 'root') return signInRedirect();
    if (!(navigation && target.kind === 'sign-in')) return deny(ownerPage ? 404 : 403);
  }
  if (target.kind === 'sign-in' || target.kind === 'ceremony' || target.kind === 'public-asset') return target;

  try {
    const token = readSessionToken(request);
    // Charge the entire session lookup against the lifetime reported by D1.
    const started = performance.now();
    const session = token === null ? null : await new Sessions(env.DB).lookupWithRemainingLifetime(token);
    const deadline = started + (session?.remaining_ms ?? 0);
    if (session && performance.now() < deadline) {
      const memberRoute = target.kind === 'upload'
        ? driveUploadMode(env, session.role) === 'multipart' && allowsStagingInviteSite(request)
        : invite && (target.kind === 'root' || target.kind === 'root-data' ||
          target.kind === 'private-asset' || target.kind === 'download');
      if (session.role === 'owner' || memberRoute) {
        return target.kind === 'private-asset' || target.kind === 'people-asset' || (target.kind === 'root' && request.method === 'HEAD')
          ? { ...target, deadline } : target;
      }
      if (ownerPage) return deny(404);
      // An otherwise valid member cookie must not prevent the owner from signing in.
      return deny(target.kind === 'root' && request.method === 'HEAD' ? 401 : 403);
    }
    if (navigation && (target.kind === 'root' || (target.kind === 'people' && request.method === 'GET'))) return signInRedirect();
    if (navigation && target.kind === 'download') return downloadRedirect(downloadSignIn);
    return deny(401);
  } catch {
    return deny(503);
  }
}

export async function dispatchStagingRequest(request: Request, env: DriveAuthEnv, storageReady: boolean,
  assets: PreviewAssets, dispatch: PreviewDispatch): Promise<Response> {
  const target = await admitStagingRequest(request, env, storageReady, assets);
  if (target instanceof Response) return target;
  const rootProbe = target.kind === 'root' && request.method === 'HEAD';
  if (target.kind === 'private-asset' || target.kind === 'people-asset' || rootProbe) {
    if (!(performance.now() < (target.deadline ?? 0))) return deny(401);
    // The sign-in probe reports authorization, not whether the listing rendered.
    if (rootProbe) return new Response(null, { headers: { 'cache-control': 'private, no-store' } });
  }
  switch (target.kind) {
    case 'ceremony':
      return dispatch.ceremony(request, target.step);
    case 'invite-ceremony':
      return dispatch.invite(request, target.step);
    case 'invite-asset':
    case 'public-asset':
    case 'private-asset':
    case 'people-asset':
    case 'root-data': {
      const result = await (target.kind === 'root-data' ? dispatch.adapter(request) : dispatch.asset(request));
      const response = new Response(result.body, result);
      response.headers.set('cache-control', 'private, no-store');
      for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control']) {
        response.headers.delete(name);
      }
      return response;
    }
    case 'invite':
    case 'sign-in':
    case 'root':
    case 'download':
    case 'upload':
    case 'owner-lifecycle':
    case 'people':
      return dispatch.adapter(request);
  }
}
