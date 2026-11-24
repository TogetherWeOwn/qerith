import { building } from '$app/env';
import { env } from 'cloudflare:workers';
import { downloadNoticeCookie, entryId, isDownloadNavigation } from '../lib/server/download-navigation';
import { firstReleaseUploadCapBytes } from '../lib/server/first-release-upload-limit.mjs';
import { firstReleaseOrigin } from '../lib/server/qualification-readiness';
import { maxUploadIntentBytes } from '../lib/server/upload-intent';
import { downloadStorage } from '../lib/server/published-download';
import { admitsSharedListing, admitsSignInFixture, admitsStagingInvite, admitsStagingReadGrants, driveUploadMode, privateDriveOrigin, type DriveUploadMode } from '../lib/server/request-auth';
import { loadRootListing, rootPageCursor } from '../lib/server/root-listing';
import { ownerStorageRuntime, wireUploadStorage, type storageIdentity } from '../lib/server/storage-runtime';
import type { PageServerLoad } from './$types';

export const csr = !building && (admitsSignInFixture(env) || privateDriveOrigin(env) !== null);

async function readDownloadNotice({ cookies, isDataRequest, locals, request, url }: Parameters<PageServerLoad>[0],
  identity?: ReturnType<typeof storageIdentity>) {
  if (isDataRequest || !locals.driveSession || !isDownloadNavigation(request)) return;
  const nonce = url.searchParams.get('download');
  if (!nonce || !entryId.test(nonce)) return;
  const cookie = downloadNoticeCookie(nonce);
  const id = cookies.get(cookie);
  if (!id) return;
  cookies.delete(cookie, { path: '/', secure: true });
  const reference = entryId.test(id) && await downloadStorage(env, 'own-file', identity)?.resolveGeneration(locals.driveSession.token, id);
  return reference ? { id, name: reference.name } : { id: null, name: null };
}

export const load: PageServerLoad = async (event) => {
  const fixture = admitsSignInFixture(env);
  const staging = privateDriveOrigin(env) !== null;
  const inviteMode = admitsStagingInvite(env);
  const preview = fixture || staging;
  if (staging) {
    event.depends('drive:root-listing');
    // Track explicit listing preloads without using the nonce to select data.
    event.url.searchParams.get('folder-refresh');
  }
  const pages = preview ? event.url.searchParams.getAll('page') : [];
  const ownerStorage = await ownerStorageRuntime(env);
  const identity = ownerStorage ? ownerStorage.identity ?? null : undefined;
  const listing = preview ? await loadRootListing(event.request, env, pages, identity) : null;
  const principal = event.locals.driveSession?.principal;
  const role = principal?.role;
  const downloadAllowed = (!ownerStorage || ownerStorage.status === 'connected') && (!staging || role === 'owner' || (role === 'member' && inviteMode));
  const uploadPolicy = driveUploadMode(env, role);
  const uploadStorageReady = uploadPolicy !== 'disabled' && (ownerStorage ? ownerStorage.status === 'connected' : staging ? !!wireUploadStorage(env).DRIVE_UPLOAD_VERIFIER :
    !!(env.DRIVE_UPLOAD_S3 && env.DRIVE_UPLOAD_EPOCH && env.DRIVE_UPLOAD_VERIFIER));
  const uploadMode: DriveUploadMode = uploadStorageReady ? uploadPolicy : 'disabled';
  const uploadLimit = firstReleaseOrigin(env) !== null && uploadMode !== 'disabled'
    ? uploadMode === 'multipart' ? firstReleaseUploadCapBytes : maxUploadIntentBytes : undefined;
  return { listing, uploadMode, uploadLimit, staging, downloadAllowed, page: rootPageCursor(pages) ?? null,
    ownerStorageAvailable: role === 'owner' && !!ownerStorage,
    folderLinks: fixture || inviteMode,
    metadataWriteAllowed: inviteMode && (role === 'owner' || role === 'member'),
    shareOwner: principal && inviteMode && listing?.status === 'ok' && admitsStagingReadGrants(env)
      ? { recipientId: principal.id, driveOwner: role === 'owner' } : undefined,
    ownerInvites: role === 'owner' && inviteMode,
    sharedListing: role === 'member' && admitsSharedListing(env),
    downloadNotice: downloadAllowed ? await readDownloadNotice(event, identity) : undefined };
};
