import { isExactFolderDocument, isTopLevelDocumentNavigation } from '../drive-navigation';
import { downloadRedirect, downloadSignIn, isExactDownloadGet } from './download-navigation';
import { dispatchEligibleRecipients } from './eligible-recipient-route';
import { entryChangeRequest, entryChangeSource, type MetadataWriteEnv } from './entry-change-route';
import { postFolder } from './folder-route';
import { Sessions } from './identity/sessions';
import { getMoveDestinations, moveDestinationsPath } from './move-destinations';
import { ownerLifecycleRoute } from './owner-lifecycle-route';
import { eligibleRecipientEntry, readGrantAdapterRequest, readGrantAdmissionRoute, readGrantCursor } from './read-grant-admission';
import { isExactSharedDocument, sharedPageCursor } from './shared-page';
import { admitsSharedListing, admitsStagingInvite, admitsStagingReadGrants, allowsOrigin, allowsStagingInviteSite, driveUploadMode, readSessionToken, stagingOrigin, type DriveAuthEnv } from './request-auth';
import { isBodylessUploadResume, uploadAdmissionRoute, uploadResumeRoute } from './upload-admission';

interface PreviewAssets {
  signIn: ReadonlySet<string>;
  root: ReadonlySet<string>;
  invite: ReadonlySet<string>;
  people: ReadonlySet<string>;
  folder: ReadonlySet<string>;
  shared?: ReadonlySet<string>;
}

type CeremonyStep = 'challenge' | 'restart' | 'verify';
type InviteStep = 'present' | 'challenge' | 'enroll';
type Target = { kind: 'sign-in' | 'public-asset' | 'root-data' | 'download' | 'upload' | 'upload-resume' | 'invite' | 'invite-asset' | 'owner-lifecycle' | 'people' | 'folder' } |
  { kind: 'read-grant' | 'eligible-recipients' } |
  { kind: 'metadata-write'; operation: 'create-folder' | 'change-entry' } | { kind: 'move-destinations' } |
  { kind: 'ceremony'; step: CeremonyStep } | { kind: 'invite-ceremony'; step: InviteStep } |
  { kind: 'private-asset' | 'people-asset' | 'folder-asset' | 'shared' | 'shared-asset' | 'root'; deadline?: number };

interface PreviewDispatch {
  adapter(request: Request): Promise<Response>;
  ceremony(request: Request, step: CeremonyStep): Promise<Response>;
  invite(request: Request, step: InviteStep): Promise<Response>;
  asset(request: Request): Promise<Response>;
}

function route(request: Request, url: URL, assets: PreviewAssets, invite: boolean, shared: boolean): Target | null {
  const { method } = request;
  const { pathname: path } = url;
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/sign-in') return { kind: 'sign-in' };
    if (invite && path === '/invite') return { kind: 'invite' };
    if (invite && path === '/people') return { kind: 'people' };
    if (invite && method === 'GET' && path === moveDestinationsPath) return { kind: 'move-destinations' };
    if (invite && isExactFolderDocument(request, url)) return { kind: 'folder' };
    if (shared && isExactSharedDocument(request, url)) return { kind: 'shared' };
    if (path === '/') return { kind: 'root' };
    if (method === 'GET' && path === '/__data.json') return { kind: 'root-data' };
    // Trust exact build-time entries only. Shared dependencies needed by sign-in are public.
    if (path.startsWith('/_app/immutable/')) {
      if (assets.signIn.has(path)) return { kind: 'public-asset' };
      if (invite && assets.invite.has(path)) return { kind: 'invite-asset' };
      if (assets.root.has(path)) return { kind: 'private-asset' };
      if (invite && assets.people.has(path)) return { kind: 'people-asset' };
      // Preserve prior classifications even if the folder shares a build dependency.
      if (invite && assets.folder.has(path) && request.url === stagingOrigin + path) return { kind: 'folder-asset' };
      if (shared && assets.shared?.has(path) && request.url === stagingOrigin + path) return { kind: 'shared-asset' };
    }
  }
  if (invite) {
    if (method === 'POST' && request.url === `${stagingOrigin}/api/folders`) {
      return { kind: 'metadata-write', operation: 'create-folder' };
    }
    if (method === 'PATCH' && entryChangeSource(request, url) !== null) {
      return { kind: 'metadata-write', operation: 'change-entry' };
    }
  }
  const [, api, resource, id, action] = path.split('/', 5);
  if (api !== 'api') return null;
  if (method === 'POST' && resource === 'sign-in' && action === undefined &&
      (id === 'challenge' || id === 'restart' || id === 'verify')) return { kind: 'ceremony', step: id };
  if (invite && method === 'POST' && resource === 'invite' && action === undefined &&
      (id === 'present' || id === 'challenge' || id === 'enroll')) return { kind: 'invite-ceremony', step: id };
  if (isExactDownloadGet(method, path)) return { kind: 'download' };
  const upload = uploadAdmissionRoute(request, url);
  if (upload === uploadResumeRoute) return invite ? { kind: 'upload-resume' } : null;
  return upload ? { kind: 'upload' } : null;
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
  const grants = admitsStagingReadGrants(env);
  const readGrant = grants && readGrantAdmissionRoute(request, url);
  const eligibleRecipients = grants && request.method === 'GET' && eligibleRecipientEntry(request, url) !== null;
  const target: Target | null = readGrant ? { kind: 'read-grant' } : eligibleRecipients ? { kind: 'eligible-recipients' }
    : invite && ownerLifecycleRoute(request, url) ? { kind: 'owner-lifecycle' }
    : route(request, url, assets, invite, admitsSharedListing(env));
  if (!target) return deny(404);
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
  if (target.kind === 'sign-in' || target.kind === 'ceremony' || target.kind === 'public-asset') return target;

  try {
    const token = readSessionToken(request);
    // Charge the entire session lookup against the lifetime reported by D1.
    const started = performance.now();
    const session = token === null ? null : await new Sessions(env.DB).lookupWithRemainingLifetime(token);
    const deadline = started + (session?.remaining_ms ?? 0);
    if (session && performance.now() < deadline) {
      if (target.kind === 'shared' || target.kind === 'shared-asset') {
        return session.role === 'member' ? { ...target, deadline } : deny(404);
      }
      const memberRoute = target.kind === 'upload' || target.kind === 'upload-resume'
        ? driveUploadMode(env, session.role) === 'multipart' && allowsStagingInviteSite(request)
        : grantManagement || invite && (target.kind === 'root' || target.kind === 'root-data' ||
          target.kind === 'private-asset' || target.kind === 'download' ||
          target.kind === 'folder' || target.kind === 'folder-asset' || target.kind === 'metadata-write' ||
          target.kind === 'move-destinations');
      if (session.role === 'owner' || memberRoute) {
        return target.kind === 'private-asset' || target.kind === 'people-asset' || target.kind === 'folder-asset' ||
          (target.kind === 'root' && request.method === 'HEAD')
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
