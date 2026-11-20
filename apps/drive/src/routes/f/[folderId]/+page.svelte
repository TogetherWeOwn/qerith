<script lang="ts">
  import EmptyFolder from '../../../lib/EmptyFolder.svelte';
  import KindGlyph from '../../../lib/KindGlyph.svelte';
  import { isLinkableFolderId } from '../../../lib/drive-navigation';
  import type { FolderPage } from '../../../lib/server/folder-page';

  export let data: { result: FolderPage };
  const label = (name: string) => name.trim() ? name : `${name} (Whitespace-only name)`;
</script>

<svelte:head><title>{data.result.status === 'ok' ? `${label(data.result.folder.name)} · Drive` : 'Folder unavailable · Drive'}</title></svelte:head>

<main data-sveltekit-reload>
  {#if data.result.status === 'ok'}
    {@const folder = data.result.folder}
    <h1 dir="auto">{label(folder.name)}</h1>
    {#if folder.entries.length}
      <ul role="list">
        {#each folder.entries as entry (entry.id)}
          <li>
            <KindGlyph kind={entry.kind} />
            {#if entry.kind === 'folder' && isLinkableFolderId(entry.id)}<a href={'/f/' + entry.id} dir="auto">{label(entry.name)}</a>
            {:else}<span dir="auto">{label(entry.name)}</span>{/if}
            <span class="kind">{entry.kind === 'folder' ? 'Folder' : 'File'}</span>
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
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { main { padding: var(--drive-layout-gutter-compact); } li { min-height: var(--drive-size-row-dense); } }
</style>
