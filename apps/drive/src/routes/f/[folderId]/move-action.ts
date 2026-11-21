import type { FolderPage } from '../../../lib/server/folder-page';
import type { ReadEntry } from '../../../lib/server/metadata/read-access';

/** Hand off an eligible row from the current page to the shared picker. */
export function openFolderMove(page: FolderPage, id: string, open: (source: ReadEntry) => void): void {
  if (page.status !== 'ok') return;
  const entry = page.folder.entries.find(row => row.id === id && row.movable === true);
  if (entry) open({ id: entry.id, name: entry.name, kind: entry.kind });
}

export type MoveReload = { source: string; target: string | null; rows: string[]; until: number };

export function moveNeighbor({ rows, source }: MoveReload, entries: { id: string }[]) {
  const index = rows.indexOf(source), live = new Set(entries.map(({ id }) => id));
  return [...rows.slice(index + 1), ...rows.slice(0, Math.max(0, index)).reverse()].find(id => live.has(id));
}

export async function readMoveReceipt({ source, target }: MoveReload) {
  const params = new URLSearchParams({ entry: source });
  if (target !== null) params.set('folder', target);
  try {
    const response = await fetch(`/api/move-destinations?${params}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const { folderName, currentParentId } = await response.json();
      if (currentParentId === target && typeof folderName === 'string') return { id: target, name: folderName };
    }
  } catch { /* A confirmed write still gets a receipt when the destination cannot be verified. */ }
  return null;
}

declare global { namespace App { interface PageState { folderMove?: MoveReload } } }
