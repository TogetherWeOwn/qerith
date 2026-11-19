import { env } from 'cloudflare:workers';
import { downloadFolder, downloadNoticeCookie, downloadRedirect, entryId, isDownloadNavigation } from '../../../../lib/server/download-navigation';
import { publishedDownload } from '../../../../lib/server/published-download';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = async ({ request, params, locals, cookies }) => {
  const session = locals.driveSession;
  if (!session) return new Response(null, { status: 401 });
  let retryable = false;
  const response = entryId.test(params.fileId)
    ? await publishedDownload(request, params.fileId, session.token, env, () => { retryable = true; })
    : new Response(null, { status: 404 });
  if (response.status < 400 || !isDownloadNavigation(request)) return response;
  // Denied, revoked and missing files share a generic notice. For an authorized
  // transport failure, the root rechecks access before displaying the name.
  cookies.set(downloadNoticeCookie, retryable ? params.fileId : 'unavailable', { path: '/', secure: true, maxAge: 60 });
  return downloadRedirect(downloadFolder);
};
