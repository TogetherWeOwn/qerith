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
    if (!response.ok) return null;
    const { folderName, currentParentId } = await response.json();
    return currentParentId === target && typeof folderName === 'string' ? { id: target, name: folderName } : null;
  } catch { return null; }
}

declare global { namespace App { interface PageState { folderMove?: MoveReload } } }
