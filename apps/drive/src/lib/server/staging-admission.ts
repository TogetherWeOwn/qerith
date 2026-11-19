import { entryId } from '../download-id';
import { isDrivePageNavigation } from '../drive-navigation';
import { downloadRedirect } from './download-navigation';
import { allowsOrigin, readSession, type DriveAuthEnv } from './request-auth';
import { uploadIdPattern } from './upload-part';

export const stagingOrigin = 'https://qerith-drive-staging.5150.workers.dev';

interface PreviewAssets {
  signIn: ReadonlySet<string>;
  root: ReadonlySet<string>;
}

type CeremonyStep = 'challenge' | 'restart' | 'verify';
type Target = { kind: 'sign-in' | 'public-asset' | 'private-asset' | 'root' | 'download' | 'upload' } |
  { kind: 'ceremony'; step: CeremonyStep };

interface PreviewDispatch {
  adapter(request: Request): Promise<Response>;
  ceremony(request: Request, step: CeremonyStep): Promise<Response>;
  asset(request: Request): Promise<Response>;
}

function route(method: string, path: string, assets: PreviewAssets): Target | null {
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/sign-in') return { kind: 'sign-in' };
    if (path === '/') return { kind: 'root' };
    // Trust exact build-time entries only. Shared dependencies needed by sign-in are public.
    if (path.startsWith('/_app/immutable/')) {
      if (assets.signIn.has(path)) return { kind: 'public-asset' };
      if (assets.root.has(path)) return { kind: 'private-asset' };
    }
  }
  const [, api, resource, id, action, part, extra] = path.split('/', 7);
  if (api !== 'api' || extra !== undefined) return null;
  if (method === 'POST' && resource === 'sign-in' && action === undefined &&
      (id === 'challenge' || id === 'restart' || id === 'verify')) return { kind: 'ceremony', step: id };
  if (method === 'GET' && resource === 'download' && id && entryId.test(id) && action === undefined) {
    return { kind: 'download' };
  }
  if (resource !== 'uploads') return null;
  if (method === 'POST' && (id === undefined ||
      (uploadIdPattern.test(id) && action === 'complete' && part === undefined))) return { kind: 'upload' };
  if (method === 'PUT' && id && uploadIdPattern.test(id) && action === 'parts' && part &&
      /^(?:[1-9][0-9]{0,3}|10000)$/.test(part)) return { kind: 'upload' };
  return null;
}

function deny(status: number): Response {
  return new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });
}

// The generated Worker will call this before dispatch. Storage readiness comes from
// the live storage composition, never a fixture flag or request-supplied value.
export async function admitStagingRequest(request: Request, env: DriveAuthEnv, storageReady: boolean,
  assets: PreviewAssets): Promise<Target | Response> {
  if (env.DRIVE_ORIGIN !== stagingOrigin || typeof env.DB?.prepare !== 'function' || !storageReady) return deny(503);
  if (!allowsOrigin(request, stagingOrigin)) return deny(403);
  const { pathname, search } = new URL(request.url);
  const target = route(request.method, pathname, assets);
  if (!target) return deny(404);
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return deny(403);
  if (target.kind === 'sign-in' || target.kind === 'ceremony' || target.kind === 'public-asset') return target;

  try {
    const session = await readSession(request, env.DB);
    if (session?.principal.role === 'owner') return target;
    if (session) return deny(403);
    if (target.kind === 'root' && isDrivePageNavigation(request)) {
      return downloadRedirect(`/sign-in?${new URLSearchParams({ next: pathname + search })}`);
    }
    return deny(401);
  } catch {
    return deny(503);
  }
}

export async function dispatchStagingRequest(request: Request, env: DriveAuthEnv, storageReady: boolean,
  assets: PreviewAssets, dispatch: PreviewDispatch): Promise<Response> {
  const target = await admitStagingRequest(request, env, storageReady, assets);
  if (target instanceof Response) return target;
  switch (target.kind) {
    case 'ceremony':
      return dispatch.ceremony(request, target.step);
    case 'public-asset':
    case 'private-asset': {
      const asset = await dispatch.asset(request);
      const response = new Response(asset.body, asset);
      response.headers.set('cache-control', 'private, no-store');
      for (const name of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control']) {
        response.headers.delete(name);
      }
      return response;
    }
    case 'sign-in':
    case 'root':
    case 'download':
    case 'upload':
      return dispatch.adapter(request);
  }
}
