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
  let receipt = $state<{ id: string; name: string; loaded: boolean }>();
  let list = $state<ReturnType<typeof FileList>>();
  let refreshed = $state<RootListingResult>();
  let result = $derived(refreshed ?? initial);
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

  async function readStagingPage(): Promise<RootListingResult | null> {
    const url = new URL(location.href);
    url.searchParams.set('folder-refresh', crypto.randomUUID());
    const response = await preloadData(url.href);
    return response.type === 'loaded' ? response.data.listing : null;
  }

  async function refresh(forFolder = false) {
    if (staging && !createFolderAllowed) {
      await invalidate('drive:root-listing');
      await tick();
      if (initial.status !== 'ok') throw new Error('Root listing unavailable');
      return;
    }
    // In opt-in staging both mutations read the same cursor without updating route data.
    const version = ++refreshVersion;
    const query = page ? `?${new URLSearchParams({ page })}` : '';
    const next = staging ? await readStagingPage() : await fetch(`/api/root-listing${query}`, { redirect: 'error' })
      .then((response): Promise<RootListingResult> | null => response.ok ? response.json() : null);
    if (version < appliedVersion) return;
    if (!next || (next.status !== 'ok' && (forFolder || !staging))) throw new Error('Root listing unavailable');
    appliedVersion = version;
    const focused = document.activeElement;
    flushSync(() => { refreshed = next; });
    restoreFocus(focused, next.status);
    if (next.status !== 'ok') throw new Error('Root listing unavailable');
  }

  function restoreFocus(focused: Element | null, next: RootListingResult['status'] = 'ok') {
    if (focused && !focused.isConnected && document.activeElement === document.body) {
      (next === 'ok' ? header?.querySelector('button') : recovery)?.focus();
    }
  }

  async function folderCreated(id: string, name: string, close: () => void) {
    await refresh(true).then(() => { receipt = { id, name, loaded: result.status === 'ok' }; },
      () => { receipt = { id, name, loaded: false }; });
    await tick();
    close();
    if (createdVisible) list?.focusCreatedRow(id);
    else recovery?.focus();
  }

  const items = $derived(result.status === 'ok' ? result.folder.entries.map(({ id, name, kind, downloadable }) => ({
    id, name, kind: kind === 'folder' ? 'Folder' : 'File', glyph: kind,
    href: downloadAllowed && downloadable !== false && kind === 'file' && entryId.test(id) ? `/api/download/${id}` : undefined,
    reload: true, size: '', bytes: null, modified: '', shared: false
  })) : []);
  const createdVisible = $derived(!!receipt && items.some(item => item.id === receipt?.id));
  const needsRefresh = $derived(receipt && (result.status === 'unavailable' || (result.status === 'ok' && !receipt.loaded && !createdVisible)));
</script>

<header bind:this={header} class:can-create={createFolderAllowed && result.status === 'ok'}>
  <h1>My Drive</h1>
  {#if uploadMode !== 'disabled' && result.status === 'ok'}
    <RootUpload mode={uploadMode} announce={(message) => { status = message; }} {refresh} paginated={page !== null} bind:busy />
  {/if}
  {#if createFolderAllowed}
    <NewFolderDialog available={result.status === 'ok'} {items} oncreated={folderCreated} />
  {/if}
</header>
<p class:status={!status || !staging || result.status === 'ok'} role="status">{status}</p>
{#if createFolderAllowed}<p class:status={!receipt || createdVisible} role="status">{receipt ? `Created “${receipt.name}”.${createdVisible || result.status === 'invalid-page' ? '' : needsRefresh ? ' Refresh My Drive to see it.' : ' It isn’t on this page.'}` : ''}</p>{/if}
{#if result.status === 'unavailable'}
  <p class="error">This folder didn't load. Check your connection, then try again.</p>
{:else if result.status === 'invalid-page'}
  <p class="error">This page is no longer available.</p>
{/if}
{#if needsRefresh || result.status === 'unavailable'}
  <a bind:this={recovery} data-sveltekit-reload href={page ? `/?page=${page}` : '/'}>{needsRefresh ? 'Refresh My Drive' : 'Try again'}</a>
{:else if result.status === 'invalid-page'}
  <a bind:this={recovery} data-sveltekit-reload href="/">Back to first page</a>
{/if}
{#if result.status === 'ok'}
  {#if items.length}
    <FileList bind:this={list} folder="My Drive" preview announceChanges={false} {items} createdId={receipt?.id} />
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
