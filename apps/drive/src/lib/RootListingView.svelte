<script lang="ts">
  import EmptyFolder from './EmptyFolder.svelte';
  import FileList from './FileList.svelte';
  import { entryId } from './download-id';
  import type { BrowseResult } from './server/browse';
  import type { RootListing } from './server/root-listing';
  import './tokens.css';

  let { result, paged }: { result: BrowseResult<RootListing>; paged: boolean } = $props();

  const items = $derived(result.status === 'ok' ? result.folder.entries.map(({ id, name, kind }) => ({
    id, name, kind: kind === 'folder' ? 'Folder' : 'File', glyph: kind,
    href: kind === 'file' && entryId.test(id) ? `/api/download/${id}` : undefined,
    reload: true, size: '', bytes: null, modified: '', shared: false
  })) : []);
</script>

<h1>My Drive</h1>
{#if result.status === 'unavailable'}
  <p class="error">This folder didn't load. Check your connection, then try again.</p>
  <a data-sveltekit-reload href="/">Try again</a>
{:else}
  {#if items.length}
    <FileList folder="My Drive" showMetadata={false} {items} />
  {:else if paged}
    <p>No more items.</p>
  {:else}
    <EmptyFolder root={true} />
  {/if}
  {#if paged || result.folder.nextPage}
    <nav aria-label="My Drive pages">
      {#if paged}<a href="/">Back to first page</a>{/if}
      {#if result.folder.nextPage}
        <a href={`/?${new URLSearchParams({ page: result.folder.nextPage })}`}>Next page</a>
      {/if}
    </nav>
  {/if}
{/if}

<style>
  h1 { margin-block: 0 var(--drive-space-4); font-family: var(--drive-font-ui); }
  nav { display: flex; flex-wrap: wrap; gap: var(--drive-space-4); }
  a { display: inline-block; padding-block: var(--drive-space-2); color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .error { color: var(--drive-color-state-danger); }
</style>
