import { browseFolder, type BrowseResult } from './browse';
import type { ReadAccess, ReadCursor, ReadEntry } from './metadata/read-access';

interface Dependencies {
  authorize(request: Request): Promise<string | null>;
  readAccess: Pick<ReadAccess, 'get' | 'list'>;
}

interface Page { name: string; entries: ReadEntry[]; nextPage: string | null; paged: boolean }
export type FolderPage = BrowseResult<Page>;
const entryId = /^[A-Za-z0-9_-]{1,128}$/;

function readCursor(url: string): ReadCursor | null {
  const pages = new URL(url).searchParams.getAll('page');
  if (!pages.length) return null;
  if (pages.length !== 1 || pages[0].length > 2048) throw new TypeError('Invalid page');
  const value: unknown = JSON.parse(pages[0]);
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError('Invalid page');
  const [name, id] = value;
  if (typeof id !== 'string' || !entryId.test(id) || typeof name !== 'string' ||
      !name || new TextEncoder().encode(name).length > 255) throw new TypeError('Invalid page');
  return { name, id };
}

export async function folderPage(request: Request, id: string, dependencies?: Dependencies): Promise<FolderPage> {
  if (!dependencies || !entryId.test(id)) return { status: 'unavailable' };
  return browseFolder(request, id, {
    authorize: (request) => dependencies.authorize(request),
    async readFolder(token) {
      const cursor = readCursor(request.url);
      const folder = await dependencies.readAccess.get(token, id);
      if (folder?.kind !== 'folder') return null;
      // list rechecks live access; the earlier title lookup is not a grant.
      const page = await dependencies.readAccess.list(token, id, cursor);
      if (!page || page.entries.length > 100 || page.entries.some(({ id }) => !entryId.test(id))) return null;
      const entries = page.entries.map(({ id, name, kind }) => ({ id, name, kind }));
      const last = entries.at(-1);
      const nextPage = page.nextCursor && last ? JSON.stringify([last.name, last.id]) : null;
      return { name: folder.name, entries, nextPage, paged: cursor !== null };
    }
  });
}
