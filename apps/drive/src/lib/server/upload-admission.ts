import { uploadIdPattern } from './upload-part';

export const uploadResumeRoute = '/api/uploads/[intentId]/resume';

export function isBodylessUploadResume(request: Request): boolean {
  const length = request.headers.get('content-length');
  // Workers can supply a stream even with explicit zero-length framing.
  return !request.headers.has('transfer-encoding') && (length === null ? request.body === null : length === '0');
}

// Match only canonical request URLs and return the exact SvelteKit endpoint ID.
export function uploadAdmissionRoute(request: Request, { origin, pathname }: URL): string | null {
  if (request.url !== origin + pathname) return null;
  const [, api, resource, id, action, part, extra] = pathname.split('/', 7);
  if (api !== 'api' || resource !== 'uploads' || extra !== undefined) return null;
  if (request.method === 'POST' && id === undefined) return '/api/uploads';
  if (!id || !uploadIdPattern.test(id)) return null;
  if (request.method === 'GET' && action === 'resume' && part === undefined) return uploadResumeRoute;
  if (request.method === 'POST' && action === 'complete' && part === undefined) return '/api/uploads/[intentId]/complete';
  if (request.method === 'PUT' && action === 'parts' && part && /^(?:[1-9][0-9]{0,3}|10000)$/.test(part)) {
    return '/api/uploads/[intentId]/parts/[partNumber]';
  }
  return null;
}
