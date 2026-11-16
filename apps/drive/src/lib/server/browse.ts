// Integration supplies both operations; this module does not authenticate requests
// or provide a storage implementation of its own.
export interface BrowseDependencies<Access, Folder> {
  authorize(request: Request, folderId: string | null): Promise<Access | null>;
  readFolder(access: Access, folderId: string | null): Promise<Folder | null>;
}

export type BrowseResult<Folder> =
  | { status: 'ok'; folder: Folder }
  | { status: 'unavailable' };

export async function browseFolder<Access, Folder>(
  request: Request,
  folderId: string | null,
  dependencies: BrowseDependencies<Access, Folder>
): Promise<BrowseResult<Folder>> {
  try {
    const access = await dependencies.authorize(request, folderId);
    if (access == null) return { status: 'unavailable' };
    const folder = await dependencies.readFolder(access, folderId);
    return folder == null ? { status: 'unavailable' } : { status: 'ok', folder };
  } catch {
    return { status: 'unavailable' };
  }
}
