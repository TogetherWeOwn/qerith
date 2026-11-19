import { env } from 'cloudflare:workers';
import { downloadNoticeCookie, entryId, isDownloadNavigation } from '../lib/server/download-navigation';
import { downloadStorage } from '../lib/server/published-download';
import { loadRootListing, rootPageCursor } from '../lib/server/root-listing';
import type { PageServerLoad } from './$types';

async function readDownloadNotice({ cookies, locals, request, url }: Parameters<PageServerLoad>[0]) {
  if (!locals.driveSession || !isDownloadNavigation(request)) return;
  const nonce = url.searchParams.get('download');
  if (!nonce || !entryId.test(nonce)) return;
  const cookie = downloadNoticeCookie(nonce);
  const id = cookies.get(cookie);
  if (!id) return;
  cookies.delete(cookie, { path: '/', secure: true });
  const reference = entryId.test(id) && await downloadStorage(env)?.resolveGeneration(locals.driveSession.token, id);
  return reference ? { id, name: reference.name } : { id: null, name: null };
}

export const load: PageServerLoad = async (event) => {
  const pages = event.url.searchParams.getAll('page');
  const listing = await loadRootListing(event.request, env, pages);
  return { listing, page: rootPageCursor(pages) ?? null, downloadNotice: await readDownloadNotice(event) };
};
