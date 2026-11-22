import { isExactFolderDocument, isTopLevelDocumentNavigation } from '../drive-navigation';
import { downloadRedirect, downloadSignIn, isExactDownloadGet } from './download-navigation';
import { dispatchEligibleRecipients } from './eligible-recipient-route';
import { entryChangeRequest, entryChangeSource, type MetadataWriteEnv } from './entry-change-route';
import { postFolder } from './folder-route';
import { Sessions } from './identity/sessions';
import { getMoveDestinations } from './move-destinations';
import { ownerLifecycleRoute } from './owner-lifecycle-route';
import { eligibleRecipientEntry, readGrantAdapterRequest, readGrantAdmissionRoute, readGrantCursor } from './read-grant-admission';
import { isExactSharedDocument, sharedPageCursor } from './shared-page';
import { admitsSharedListing, admitsStagingInvite, admitsStagingReadGrants, allowsOrigin, allowsStagingInviteSite, driveUploadMode, readSessionToken, stagingOrigin, type DriveAuthEnv } from './request-auth';
import { stagingRoutes, type CeremonyStep, type InviteStep, type RouteAccess, type SignedOut, type StagingGate,
  type StagingRoute, type StagingRouteTarget } from './staging-routes';
import { isBodylessUploadResume, uploadAdmissionRoute } from './upload-admission';

interface PreviewAssets {
  signIn: ReadonlySet<string>;
  root: ReadonlySet<string>;
  invite: ReadonlySet<string>;
  people: ReadonlySet<string>;
  folder: ReadonlySet<string>;
  shared?: ReadonlySet<string>;
}

type Target = (StagingRouteTarget |
  { kind: 'public-asset' | 'invite-asset' | 'private-asset' | 'people-asset' | 'folder-asset' | 'shared-asset' }) &
  { deadline?: number };
type Admission = { target: Target; access: RouteAccess; signedOut: SignedOut };

interface PreviewDispatch {
  adapter(request: Request): Promise<Response>;
  ceremony(request: Request, step: CeremonyStep): Promise<Response>;
  invite(request: Request, step: InviteStep): Promise<Response>;
  asset(request: Request): Promise<Response>;
}

function matchesRoute(route: StagingRoute, request: Request, url: URL): boolean {
  const { target, path } = route;
  switch (target.kind) {
    case 'folder': return isExactFolderDocument(request, url);
    case 'shared': return isExactSharedDocument(request, url);
    case 'download': return isExactDownloadGet(request.method, url.pathname);
    case 'upload':
    case 'upload-resume': return uploadAdmissionRoute(request, url) === path;
    case 'owner-lifecycle': return ownerLifecycleRoute(request, url) === path;
    case 'read-grant': return readGrantAdmissionRoute(request, url) === path;
    case 'eligible-recipients': return eligibleRecipientEntry(request, url) !== null;
    case 'metadata-write':
      return target.operation === 'create-folder' ? request.url === stagingOrigin + path : entryChangeSource(request, url) !== null;
    default: return url.pathname === path;
  }
}

function assetAdmission(request: Request, path: string, assets: PreviewAssets, gates: Record<StagingGate, boolean>): Admission | undefined {
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !path.startsWith('/_app/immutable/')) return;
  // Trust exact build-time entries only. Shared dependencies needed by sign-in are public.
  if (assets.signIn.has(path)) return { target: { kind: 'public-asset' }, access: 'public', signedOut: 'dispatch' };
  if (gates.invite && assets.invite.has(path)) return { target: { kind: 'invite-asset' }, access: 'public', signedOut: 'dispatch' };
  if (assets.root.has(path)) return { target: { kind: 'private-asset' }, access: 'owner-or-invited-member', signedOut: 401 };
  if (gates.invite && assets.people.has(path)) return { target: { kind: 'people-asset' }, access: 'owner', signedOut: 401 };
  // Preserve prior classifications even if the folder shares a build dependency.
  if (request.url !== stagingOrigin + path) return;
  if (gates.invite && assets.folder.has(path)) return { target: { kind: 'folder-asset' }, access: 'owner-or-member', signedOut: 401 };
  if (gates.shared && assets.shared?.has(path)) return { target: { kind: 'shared-asset' }, access: 'member', signedOut: 401 };
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
  const gates = { invite: admitsStagingInvite(env), 'read-grants': admitsStagingReadGrants(env), shared: admitsSharedListing(env) };
  const route = stagingRoutes.find((route): route is StagingRoute => !('excluded' in route) &&
    (!route.gate || gates[route.gate]) && route.methods.some(method => method === request.method) && matchesRoute(route, request, url));
  const admission = route ?? assetAdmission(request, pathname, assets, gates);
  if (!admission) return deny(404);
  const { access, signedOut } = admission;
  const target = { ...admission.target };
  const grantManagement = target.kind === 'read-grant' || target.kind === 'eligible-recipients';
  if (target.kind === 'upload-resume') {
    if (!allowsStagingInviteSite(request)) return deny(403);
    if (!isBodylessUploadResume(request)) return deny(400);
  }
  if ((target.kind === 'owner-lifecycle' || grantManagement || target.kind === 'metadata-write' ||
      target.kind === 'move-destinations') && !allowsStagingInviteSite(request)) return deny(403);
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
  if (access === 'public') return target;

  try {
    const token = readSessionToken(request);
    // Charge the entire session lookup against the lifetime reported by D1.
    const started = performance.now();
    const session = token === null ? null : await new Sessions(env.DB).lookupWithRemainingLifetime(token);
    const deadline = started + (session?.remaining_ms ?? 0);
    if (session && performance.now() < deadline) {
      if (access === 'member') {
        return session.role === 'member' ? { ...target, deadline } : deny(404);
      }
      const memberRoute = access === 'owner-or-member' || (access === 'owner-or-invited-member' && gates.invite) ||
        (access === 'owner-or-multipart-member' && driveUploadMode(env, session.role) === 'multipart' && allowsStagingInviteSite(request));
      if (session.role === 'owner' || memberRoute) {
        return target.kind === 'private-asset' || target.kind === 'people-asset' || target.kind === 'folder-asset' ||
          (target.kind === 'root' && request.method === 'HEAD')
          ? { ...target, deadline } : target;
      }
      if (ownerPage) return deny(404);
      // An otherwise valid member cookie must not prevent the owner from signing in.
      return deny(target.kind === 'root' && request.method === 'HEAD' ? 401 : 403);
    }
    if (navigation && signedOut === 'return-to-route') return signInRedirect();
    if (navigation && signedOut === 'return-to-root') return downloadRedirect(downloadSignIn);
    return deny(401);
  } catch {
    return deny(503);
  }
}

export async function dispatchStagingRequest(request: Request, env: MetadataWriteEnv, storageReady: boolean,
  assets: PreviewAssets, dispatch: PreviewDispatch): Promise<Response> {
  const target = await admitStagingRequest(request, env, storageReady, assets);
  if (target instanceof Response) return target;
  const rootProbe = target.kind === 'root' && request.method === 'HEAD';
  if (target.kind === 'private-asset' || target.kind === 'people-asset' || target.kind === 'folder-asset' ||
      target.kind === 'shared' || target.kind === 'shared-asset' || rootProbe) {
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
    case 'folder-asset':
    case 'shared-asset':
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
    case 'upload-resume':
    case 'owner-lifecycle':
    case 'people':
    case 'folder':
      return dispatch.adapter(request);
    case 'shared':
      // Reject reserved and malformed query keys before the adapter sees them.
      return sharedPageCursor(new URL(request.url).search) === undefined ? deny(400) : dispatch.adapter(request);
    case 'metadata-write':
      return target.operation === 'create-folder' ? postFolder(request, env) : entryChangeRequest(request, env) ?? deny(404);
    case 'move-destinations':
      return getMoveDestinations(request, env);
    case 'eligible-recipients':
      return dispatchEligibleRecipients(request, env, dispatch.adapter) ?? deny(404);
    case 'read-grant': {
      const url = new URL(request.url);
      // The adapter can reject reserved query keys before Drive's hook runs.
      if (readGrantCursor(request.method, url.search) === undefined) return deny(400);
      return dispatch.adapter(readGrantAdapterRequest(request, url));
    }
  }
}
