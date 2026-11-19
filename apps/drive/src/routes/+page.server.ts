import { env } from 'cloudflare:workers';
import { downloadNoticeCookie, entryId, isDownloadNavigation } from '../lib/server/download-navigation';
import { downloadStorage } from '../lib/server/published-download';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ cookies, locals, request, url }) => {
  if (!locals.driveSession || !isDownloadNavigation(request)) return {};
  const [nonce, id] = cookies.get(downloadNoticeCookie)?.split(':') ?? [];
  if (!id || !entryId.test(nonce) || url.searchParams.get('download') !== nonce) return {};
  cookies.delete(downloadNoticeCookie, { path: '/', secure: true });
  const reference = entryId.test(id) && await downloadStorage(env)?.resolveGeneration(locals.driveSession.token, id);
  return { downloadNotice: reference ? { id, name: reference.name } : { id: null, name: null } };
};
