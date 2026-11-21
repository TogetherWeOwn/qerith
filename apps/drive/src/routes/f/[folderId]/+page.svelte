<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import EmptyFolder from '../../../lib/EmptyFolder.svelte';
  import KindGlyph from '../../../lib/KindGlyph.svelte';
  import MoveDialog from '../../../lib/MoveDialog.svelte';
  import RowActions from '../../../lib/RowActions.svelte';
  import { moveNeighbor, openFolderMove, readMoveReceipt, type MoveReload } from './move-action';
  import { isLinkableFolderId } from '../../../lib/drive-navigation';
  import type { FolderPage } from '../../../lib/server/folder-page';

  export let data: { result: FolderPage };
  const label = (name: string) => name.trim() ? name : `${name} (Whitespace-only name)`;

  let mounted = false, movedId: string | undefined;
  let main: HTMLElement, heading: HTMLHeadingElement;
  let picker: ReturnType<typeof MoveDialog>;
  let receipt: Awaited<ReturnType<typeof readMoveReceipt>> | undefined;
  const shallow = { shallow: true, replace: true } as const;
  const row = (id: string) => main.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
  const restoreTrigger = (id: string) => row(id)?.querySelector('button')?.focus();
  const focusNeighbor = (id?: string) => (id && row(id)?.querySelector<HTMLElement>('[data-name]') || heading).focus();

  onMount(() => {
    mounted = true;
    if (page.state.folderMove) void restore(page.state.folderMove);
  });

  async function restore(saved: MoveReload) {
    const expired = saved.until <= Date.now();
    if (!expired && data.result.status === 'unavailable') {
      receipt = null; // Keep the saved IDs for the next document refresh.
      return;
    }
    await goto(location.href, shallow).catch(() => {});
    if (expired || data.result.status !== 'ok' || !data.result.folder.canMove) return;
    const entries = data.result.folder.entries;
    if (entries.some(entry => entry.id === saved.source && entry.movable)) restoreTrigger(saved.source);
    else focusNeighbor(moveNeighbor(saved, entries));
    receipt = await readMoveReceipt(saved);
  }

  async function moved(id: string, { id: target }: { id: string | null }, close: () => void) {
    if (data.result.status !== 'ok') return;
    const { entries } = data.result.folder;
    const saved = { source: id, target, rows: entries.map(entry => entry.id), until: Date.now() + 60_000 };
    close(); movedId = id; receipt = null;
    await tick(); focusNeighbor(moveNeighbor(saved, entries));
    try {
      await goto(location.href, { ...shallow, persistState: true, state: { folderMove: saved } });
      location.reload(); // The nested listing is admitted as a document, never as __data.json.
    } catch { receipt = await readMoveReceipt(saved); }
  }
</script>

<svelte:head><title>{data.result.status === 'ok' ? `${label(data.result.folder.name)} · Drive` : 'Folder unavailable · Drive'}</title></svelte:head>

<main bind:this={main} data-sveltekit-reload>
  {#if data.result.status === 'ok'}
    {@const folder = data.result.folder}
    {@const entries = movedId === undefined ? folder.entries : folder.entries.filter(entry => entry.id !== movedId)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (only -1, for focus recovery) -->
    <h1 dir="auto" bind:this={heading} tabindex={folder.canMove ? -1 : undefined}>{label(folder.name)}</h1>
    {#if folder.canMove}
      <MoveDialog bind:this={picker} onrootcreated={async () => {}} onmoved={moved} onreturn={restoreTrigger} />
      <div class:move-notice={receipt !== undefined}>
        <p role="status" class:status={receipt === undefined}>{#if receipt}Moved to <bdi>{label(receipt.name)}</bdi>{:else if receipt === null}Item moved.{/if}</p>
        {#if receipt}<a href={receipt.id === null ? '/' : `/f/${receipt.id}`}>Open <bdi>{label(receipt.name)}</bdi></a>{/if}
        {#if movedId}<a href={page.url.pathname + page.url.search}>Refresh this folder</a>{/if}
      </div>
    {/if}
    {#if entries.length}
      <ul role="list">
        {#each entries as entry (entry.id)}
          <li data-row={folder.canMove ? entry.id : undefined}>
            <KindGlyph kind={entry.kind} />
            {#if entry.kind === 'folder' && isLinkableFolderId(entry.id)}<a href={'/f/' + entry.id} dir="auto" data-name>{label(entry.name)}</a>
            {:else if entry.downloadable}<a href={'/api/download/' + entry.id} dir="auto" data-name>{label(entry.name)}</a>
            {:else}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (only -1, for focus recovery) -->
              <span dir="auto" data-name tabindex={folder.canMove ? -1 : undefined}>{label(entry.name)}</span>
            {/if}
            <span class="kind">{entry.kind === 'folder' ? 'Folder' : 'File'}</span>
            {#if mounted && entry.movable && movedId === undefined}
              <RowActions name={entry.name} moveOnly onAction={() => openFolderMove(data.result, entry.id, source => picker?.open(source))}
                onTab={() => false} />
            {/if}
          </li>
        {/each}
      </ul>
    {:else if folder.paged}
      <p>No more items.</p>
    {:else}
      <EmptyFolder root={false} />
    {/if}
    {#if folder.paged}<a href="?">First page</a>{/if}
    {#if folder.nextPage}<a href={'?' + new URLSearchParams({ page: folder.nextPage })}>Next page</a>{/if}
  {:else}
    <h1>This folder isn't available.</h1>
    <p>It may have been deleted or moved, or it isn't shared with you.</p>
    {#if receipt === null}<p role="status">Item moved. Refresh this page to reload the source folder.</p>{/if}
    <a class="ghost" href="/">Go to My Drive</a>
  {/if}
</main>

<style>
  main { box-sizing: border-box; max-width: var(--drive-layout-container); margin: auto; padding: var(--drive-layout-gutter-wide); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); overflow-wrap: anywhere; }
  h1 { font-size: var(--drive-font-size-h3); }
  ul { list-style: none; padding: 0; }
  li { display: flex; align-items: baseline; gap: var(--drive-space-2); min-height: var(--drive-size-row-admin); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  li :is(a, span) { min-width: 0; white-space: break-spaces; unicode-bidi: plaintext; }
  .kind { margin-inline-start: auto; color: var(--drive-color-text-secondary); }
  a { display: inline-block; box-sizing: border-box; min-height: var(--drive-size-control-sm); padding-block: var(--drive-space-2); color: inherit; }
  .ghost { min-height: var(--drive-size-control-md); padding-inline: var(--drive-space-5); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-pill); text-decoration: none; }
  .ghost:hover { background: var(--drive-color-bg-raised); }
  .move-notice { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--drive-space-2); padding: var(--drive-space-4); border-radius: var(--drive-radius-m); background: var(--drive-color-state-ok-bg); }
  .move-notice p { margin: 0; }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  :is(a, h1, [data-name]):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { main { padding: var(--drive-layout-gutter-compact); } li { min-height: var(--drive-size-row-dense); } }
</style>
