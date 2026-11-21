import { entryId } from '../download-id';
import { isFolderId } from '../folder-id';
import { entryChangePath } from '../metadata-id';
import { browseFolder, type BrowseResult } from './browse';
import type { ReadAccess, ReadEntry } from './metadata/read-access';

interface Dependencies {
  authorize(request: Request): Promise<string | null>;
  readAccess: Pick<ReadAccess, 'get' | 'list'>;
  metadataWriteAllowed?: boolean;
}

type FolderEntry = ReadEntry & { downloadable?: true; movable?: true };
export type FolderPage = BrowseResult<{ name: string; entries: FolderEntry[]; nextPage: string | null; paged: boolean }>;
// 12-byte nonce + 255-byte zero-padded name + 16-byte GCM tag, encoded unpadded.
const pagePattern = /^[A-Za-z0-9_-]{378}$/;
const utf8 = new TextEncoder();

async function cursorKey(token: string) {
  const key = await crypto.subtle.digest('SHA-256', utf8.encode(`drive-folder-page-v2:${token}`));
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function folderPage(request: Request, id: string, dependencies?: Dependencies): Promise<FolderPage> {
  if (!dependencies || !isFolderId(id)) return { status: 'unavailable' };
  return browseFolder(request, id, {
    authorize: (request) => dependencies.authorize(request),
    async readFolder(token) {
      const pages = new URL(request.url).searchParams.getAll('page');
      if (pages.length > 1 || (pages.length && !pagePattern.test(pages[0]))) return null;
      const algorithm = { name: 'AES-GCM', additionalData: utf8.encode(id) };
      const key = pages.length ? await cursorKey(token) : null;
      const bytes = Uint8Array.from(atob((pages[0] ?? '').replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
      const after = key ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(await crypto.subtle.decrypt({ ...algorithm, iv: bytes.subarray(0, 12) }, key, bytes.subarray(12))).replace(/\0+$/, '') : null;
      const folder = await dependencies.readAccess.get(token, id);
      if (folder?.kind !== 'folder') return null;
      // This is a live name boundary, not a snapshot. Even a replacement at that name is behind it.
      const page = await dependencies.readAccess.list(token, id, after === null ? null : { name: after, id: '' });
      if (!page || page.entries.length > 100) return null;
      const canMove = dependencies.metadataWriteAllowed === true && page.ownsFolder === true;
      const entries = page.entries.slice(page.entries[0]?.name === after ? 1 : 0)
        .map(({ id, name, kind, downloadable }): FolderEntry => {
          const entry: FolderEntry = { id, name, kind };
          if (kind === 'file' && downloadable === 1 && entryId.test(id)) entry.downloadable = true;
          if (canMove && entryChangePath(id)) entry.movable = true;
          return entry;
        });
      let nextPage = null;
      if (page.nextCursor) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const name = new Uint8Array(255); // The metadata schema caps names at 255 UTF-8 bytes and forbids NUL.
        name.set(utf8.encode(page.nextCursor.name));
        const sealed = await crypto.subtle.encrypt({ ...algorithm, iv }, key ?? await cursorKey(token), name);
        nextPage = btoa(String.fromCharCode(...iv, ...new Uint8Array(sealed))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      }
      return { name: folder.name, entries, nextPage, paged: after !== null };
    }
  });
}
