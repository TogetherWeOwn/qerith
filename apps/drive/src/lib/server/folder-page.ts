import { browseFolder, type BrowseResult } from './browse';
import type { ReadAccess, ReadEntry } from './metadata/read-access';

interface Dependencies {
  authorize(request: Request): Promise<string | null>;
  readAccess: Pick<ReadAccess, 'get' | 'list'>;
}

interface Page { name: string; entries: ReadEntry[]; nextPage: string | null; paged: boolean }
export type FolderPage = BrowseResult<Page>;
const validId = (id: string) => id.length > 0 && id.length <= 128;

export async function folderPage(request: Request, id: string, dependencies?: Dependencies): Promise<FolderPage> {
  if (!dependencies || !validId(id)) return { status: 'unavailable' };
  return browseFolder(request, id, {
    authorize: (request) => dependencies.authorize(request),
    async readFolder(token) {
      const { readAccess } = dependencies;
      const pages = new URL(request.url).searchParams.getAll('page');
      if (pages.length > 1 || (pages.length && !validId(pages[0]))) return null;
      const folder = await readAccess.get(token, id);
      if (folder?.kind !== 'folder') return null;
      // Resolve the anchor under the same session; never put its name in the URL.
      const anchor = pages.length ? await readAccess.get(token, pages[0]) : null;
      if (pages.length && !anchor) return null;
      const page = await readAccess.list(token, id, anchor && { name: anchor.name, id: anchor.id });
      if (!page || page.entries.length > 100) return null;
      const entries = page.entries.map(({ id, name, kind }) => ({ id, name, kind }));
      return { name: folder.name, entries, nextPage: page.nextCursor ? entries.at(-1)?.id ?? null : null, paged: anchor !== null };
    }
  });
}
