import type { FolderPage } from '../../../lib/server/folder-page';
import type { ReadEntry } from '../../../lib/server/metadata/read-access';

/** Hand off an eligible row from the current page to the shared picker. */
export function openFolderMove(page: FolderPage, id: string, open: (source: ReadEntry) => void): void {
  if (page.status !== 'ok') return;
  const entry = page.folder.entries.find(row => row.id === id && row.movable === true);
  if (entry) open({ id: entry.id, name: entry.name, kind: entry.kind });
}
