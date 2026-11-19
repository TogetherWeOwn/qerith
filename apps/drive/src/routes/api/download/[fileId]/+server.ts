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
  // Separate cookie names keep concurrent navigations from replacing each other's notices.
  const nonce = crypto.randomUUID();
  cookies.set(downloadNoticeCookie(nonce), retryable ? params.fileId : 'unavailable', { path: '/', secure: true, maxAge: 60 });
  return downloadRedirect(`${downloadFolder}?download=${nonce}`);
};
