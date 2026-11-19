<script lang="ts">
  import EmptyFolder from './EmptyFolder.svelte';
  import FileList from './FileList.svelte';
  import RootUpload from './RootUpload.svelte';
  import { entryId } from './download-id';
  import type { RootListingResult } from './server/root-listing';
  import './tokens.css';

  let { result: initial, page }: { result: RootListingResult; page: string | null } = $props();
  let status = $state('');
  let refreshed = $state<RootListingResult>();
  let result = $derived(refreshed ?? initial);
  let refreshVersion = 0;

  async function refresh() {
    const version = ++refreshVersion;
    const query = page ? `?${new URLSearchParams({ page })}` : '';
    const response = await fetch(`/api/root-listing${query}`, { redirect: 'error' });
    if (!response.ok) throw new Error('Root listing unavailable');
    const next: RootListingResult = await response.json();
    if (next.status !== 'ok') throw new Error('Root listing unavailable');
    if (version === refreshVersion) refreshed = next;
  }

  const items = $derived(result.status === 'ok' ? result.folder.entries.map(({ id, name, kind }) => ({
    id, name, kind: kind === 'folder' ? 'Folder' : 'File', glyph: kind,
    href: kind === 'file' && entryId.test(id) ? `/api/download/${id}` : undefined,
    reload: true, size: '', bytes: null, modified: '', shared: false
  })) : []);
</script>

<header>
  <h1>My Drive</h1>
  {#if result.status === 'ok'}
    <RootUpload announce={(message) => { status = message; }} {refresh} paginated={page !== null} />
  {/if}
</header>
<p class="status" role="status">{status}</p>
{#if result.status === 'unavailable'}
  <p class="error">This folder didn't load. Check your connection, then try again.</p>
  <a data-sveltekit-reload href={page ? `/?page=${page}` : '/'}>Try again</a>
{:else if result.status === 'invalid-page'}
  <p class="error">This page is no longer available.</p>
  <a data-sveltekit-reload href="/">Back to first page</a>
{:else}
  {#if items.length}
    <FileList folder="My Drive" preview announceChanges={false} {items} />
  {:else if page}
    <p>No more items.</p>
  {:else}
    <EmptyFolder root={true} />
  {/if}
  {#if page || result.folder.nextPage}
    <nav aria-label="My Drive pages">
      {#if page}<a data-sveltekit-reload href="/">Back to first page</a>{/if}
      {#if result.folder.nextPage}
        <a data-sveltekit-reload href={`/?${new URLSearchParams({ page: result.folder.nextPage })}`}>Next page</a>
      {/if}
    </nav>
  {/if}
{/if}

<style>
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--drive-space-3); margin-bottom: var(--drive-space-4); }
  h1 { margin: 0; font-family: var(--drive-font-ui); }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 820px) { header { grid-template-columns: minmax(0, 1fr); } }
  nav { display: flex; flex-wrap: wrap; gap: var(--drive-space-4); }
  a { display: inline-block; padding-block: var(--drive-space-2); color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .error { color: var(--drive-color-state-danger); }
</style>
