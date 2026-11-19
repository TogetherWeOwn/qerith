import { building } from '$app/env';
import { env } from 'cloudflare:workers';
import { downloadNoticeCookie, entryId, isDownloadNavigation } from '../lib/server/download-navigation';
import { downloadStorage } from '../lib/server/published-download';
import { admitsSignInFixture } from '../lib/server/request-auth';
import { loadRootListing, rootPageCursor } from '../lib/server/root-listing';
import type { PageServerLoad } from './$types';

export const csr = !building && admitsSignInFixture(env);

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
  const preview = admitsSignInFixture(env);
  const pages = preview ? event.url.searchParams.getAll('page') : [];
  const listing = preview ? await loadRootListing(event.request, env, pages) : null;
  const uploadConfigured = preview && !!(env.DRIVE_UPLOAD_S3 && env.DRIVE_UPLOAD_EPOCH && env.DRIVE_UPLOAD_VERIFIER);
  return { listing, uploadConfigured, page: rootPageCursor(pages) ?? null, downloadNotice: await readDownloadNotice(event) };
};
