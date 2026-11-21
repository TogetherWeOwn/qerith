import { building } from '$app/env';
import { env } from 'cloudflare:workers';
import { downloadNoticeCookie, entryId, isDownloadNavigation } from '../lib/server/download-navigation';
import { downloadStorage } from '../lib/server/published-download';
import { admitsSharedListing, admitsSignInFixture, admitsStagingInvite, driveUploadMode, stagingOrigin, type DriveUploadMode } from '../lib/server/request-auth';
import { loadRootListing, rootPageCursor } from '../lib/server/root-listing';
import { wireUploadStorage } from '../lib/server/storage-runtime';
import type { PageServerLoad } from './$types';

// The generated Worker admits staging only with live DB, assets and qualified storage.
export const csr = !building && (admitsSignInFixture(env) || env.DRIVE_ORIGIN === stagingOrigin);

async function readDownloadNotice({ cookies, isDataRequest, locals, request, url }: Parameters<PageServerLoad>[0]) {
  if (isDataRequest || !locals.driveSession || !isDownloadNavigation(request)) return;
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
  const fixture = admitsSignInFixture(env);
  const staging = env.DRIVE_ORIGIN === stagingOrigin;
  const inviteMode = admitsStagingInvite(env);
  const preview = fixture || staging;
  if (staging) {
    event.depends('drive:root-listing');
    // Track explicit listing preloads without using the nonce to select data.
    event.url.searchParams.get('folder-refresh');
  }
  const pages = preview ? event.url.searchParams.getAll('page') : [];
  const listing = preview ? await loadRootListing(event.request, env, pages) : null;
  const role = event.locals.driveSession?.principal.role;
  const downloadAllowed = !staging || role === 'owner' || (role === 'member' && inviteMode);
  const uploadPolicy = driveUploadMode(env, role);
  const uploadStorageReady = uploadPolicy !== 'disabled' && (staging ? !!wireUploadStorage(env).DRIVE_UPLOAD_VERIFIER :
    !!(env.DRIVE_UPLOAD_S3 && env.DRIVE_UPLOAD_EPOCH && env.DRIVE_UPLOAD_VERIFIER));
  const uploadMode: DriveUploadMode = uploadStorageReady ? uploadPolicy : 'disabled';
  return { listing, uploadMode, staging, downloadAllowed, page: rootPageCursor(pages) ?? null,
    folderLinks: fixture || inviteMode,
    metadataWriteAllowed: inviteMode && (role === 'owner' || role === 'member'),
    ownerInvites: role === 'owner' && inviteMode,
    sharedListing: role === 'member' && admitsSharedListing(env),
    downloadNotice: downloadAllowed ? await readDownloadNotice(event) : undefined };
};
