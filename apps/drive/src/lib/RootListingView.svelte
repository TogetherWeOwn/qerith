<script lang="ts">
  import { invalidate, preloadData } from '$app/navigation';
  import { flushSync, tick } from 'svelte';
  import EmptyFolder from './EmptyFolder.svelte';
  import FileList from './FileList.svelte';
  import NewFolderDialog from './NewFolderDialog.svelte';
  import RootUpload from './RootUpload.svelte';
  import { entryId } from './download-id';
  import type { DriveUploadMode } from './server/request-auth';
  import type { RootListingResult } from './server/root-listing';
  import './tokens.css';

  let { result: initial, page, uploadMode, staging, downloadAllowed, createFolderAllowed }: {
    result: RootListingResult; page: string | null; uploadMode: DriveUploadMode; staging: boolean; downloadAllowed: boolean; createFolderAllowed: boolean;
  } = $props();
  let status = $state('');
  let receipt = $state<'hidden' | 'visible' | 'refresh'>('hidden');
  let createdId = $state<string>();
  let list = $state<ReturnType<typeof FileList>>();
  function announce(message: string, style: typeof receipt = 'hidden') { status = message; receipt = style; }
  let refreshed = $state.raw<{ from: RootListingResult; listing: RootListingResult }>();
  let result = $derived(refreshed?.from === initial ? refreshed.listing : initial);
  let busy = $state(false);
  let header: HTMLElement;
  let recovery = $state<HTMLAnchorElement>();
  let refreshVersion = 0, appliedVersion = 0;

  $effect.pre(() => {
    if (!staging) return;
    // The user may have moved focus while the data request was in flight.
    const focused = document.activeElement;
    const next = initial.status;
    void tick().then(() => restoreFocus(focused, next));
  });

  async function refresh() {
    if (staging) {
      await invalidate('drive:root-listing');
      await tick();
      if (initial.status !== 'ok') throw new Error('Root listing unavailable');
      return;
    }
    const version = ++refreshVersion;
    const query = page ? `?${new URLSearchParams({ page })}` : '';
    const response = await fetch(`/api/root-listing${query}`, { redirect: 'error' });
    const next: RootListingResult | null = response.ok ? await response.json() : null;
    if (next?.status !== 'ok') throw new Error('Root listing unavailable');
    if (version < appliedVersion) return;
    appliedVersion = version;
    const focused = document.activeElement;
    flushSync(() => { refreshed = { from: initial, listing: next }; });
    restoreFocus(focused);
  }

  function restoreFocus(focused: Element | null, next: RootListingResult['status'] = 'ok') {
    if (focused && !focused.isConnected && document.activeElement === document.body) {
      (next === 'ok' ? header?.querySelector('button') : recovery)?.focus();
    }
  }

  async function folderCreated(id: string, name: string, close: () => void) {
    // Read the same authenticated cursor without committing a route update on failure.
    const from = initial, url = new URL(location.href);
    url.searchParams.set('folder-refresh', crypto.randomUUID());
    const next = await preloadData(url.href).catch(() => null);
    if (next?.type !== 'loaded' || next.data.listing?.status !== 'ok' || initial !== from) {
      close();
      announce(`Created “${name}”. Refresh My Drive to see it.`, 'refresh');
      await tick();
      recovery?.focus();
      return;
    }
    refreshed = { from, listing: next.data.listing };
    createdId = id;
    await tick();
    close();
    if (items.some(item => item.id === id)) {
      list?.focusCreatedRow(id);
      announce(`Created “${name}”.`);
    } else announce(`Created “${name}”. It isn’t on this page.`, 'visible');
  }

  const items = $derived(result.status === 'ok' ? result.folder.entries.map(({ id, name, kind, downloadable }) => ({
    id, name, kind: kind === 'folder' ? 'Folder' : 'File', glyph: kind,
    href: downloadAllowed && downloadable !== false && kind === 'file' && entryId.test(id) ? `/api/download/${id}` : undefined,
    reload: true, size: '', bytes: null, modified: '', shared: false
  })) : []);
</script>

<header bind:this={header} class:can-create={createFolderAllowed && result.status === 'ok'}>
  <h1>My Drive</h1>
  {#if uploadMode !== 'disabled' && result.status === 'ok'}
    <RootUpload mode={uploadMode} {announce} {refresh} paginated={page !== null} bind:busy />
  {/if}
  {#if createFolderAllowed}
    <NewFolderDialog available={result.status === 'ok'} {items} oncreated={folderCreated} />
  {/if}
</header>
<p class:status={!status || (receipt === 'hidden' && (!staging || result.status === 'ok'))} role="status">{status}</p>
{#if result.status === 'unavailable'}
  <p class="error">This folder didn't load. Check your connection, then try again.</p>
  <a bind:this={recovery} data-sveltekit-reload href={page ? `/?page=${page}` : '/'}>Try again</a>
{:else if result.status === 'invalid-page'}
  <p class="error">This page is no longer available.</p>
  <a bind:this={recovery} data-sveltekit-reload href="/">Back to first page</a>
{:else}
  {#if receipt === 'refresh'}<a bind:this={recovery} data-sveltekit-reload href={page ? `/?page=${page}` : '/'}>Refresh My Drive</a>{/if}
  {#if items.length}
    <FileList bind:this={list} folder="My Drive" preview announceChanges={false} {items} {createdId} />
  {:else if page}
    <p>No more items.</p>
  {:else}
    <EmptyFolder root={true} />
  {/if}
  {#if page || result.folder.nextPage}
    <nav aria-label="My Drive pages" data-sveltekit-reload inert={busy}>
      {#if page}<a href="/">Back to first page</a>{/if}
      {#if result.folder.nextPage}
        <a href={`/?${new URLSearchParams({ page: result.folder.nextPage })}`}>Next page</a>
      {/if}
    </nav>
  {/if}
{/if}

<style>
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--drive-space-3); margin-bottom: var(--drive-space-4); }
  header.can-create { grid-template-columns: minmax(0, 1fr) auto auto; }
  h1 { margin: 0; font-family: var(--drive-font-ui); }
  p[role="status"] { overflow-wrap: anywhere; }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 820px) {
    header { grid-template-columns: minmax(0, 1fr); }
    header.can-create { grid-template-columns: minmax(0, 1fr) auto; }
    header.can-create h1 { grid-column: 1 / -1; }
  }
  nav { display: flex; flex-wrap: wrap; gap: var(--drive-space-4); }
  a { display: inline-block; padding-block: var(--drive-space-2); color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .error { color: var(--drive-color-state-danger); }
</style>
