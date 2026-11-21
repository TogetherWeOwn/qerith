<script lang="ts">
  import { invalidate, preloadData } from '$app/navigation';
  import { flushSync, tick } from 'svelte';
  import EmptyFolder from './EmptyFolder.svelte';
  import FileList from './FileList.svelte';
  import NameDialog from './NameDialog.svelte';
  import MoveDialog from './MoveDialog.svelte';
  import { entryChangePath } from './metadata-id';
  import RootUpload from './RootUpload.svelte';
  import { entryId } from './download-id';
  import type { DriveUploadMode } from './server/request-auth';
  import type { RootListingResult } from './server/root-listing';
  import './tokens.css';

  let { result: initial, page, uploadMode, staging, downloadAllowed, metadataWriteAllowed }: {
    result: RootListingResult; page: string | null; uploadMode: DriveUploadMode; staging: boolean; downloadAllowed: boolean; metadataWriteAllowed: boolean;
  } = $props();
  let status = $state('');
  let receipt = $state<{ id: string; name: string; loaded: boolean }>();
  let nameDialog = $state<ReturnType<typeof NameDialog>>();
  let moveDialog = $state<ReturnType<typeof MoveDialog>>();
  let moveReceipt = $state<{ id: string | null; name: string }>();
  let movedButNotRefreshed = $state<string[]>([]);
  let heading: HTMLHeadingElement;
  let renameStatus = $state('');
  let renameRefreshFailed = $state(false);
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

  async function refresh(reason?: 'folder' | 'rename' | 'move') {
    if (staging && !metadataWriteAllowed) {
      await invalidate('drive:root-listing');
      await tick();
      if (initial.status !== 'ok') throw new Error('Root listing unavailable');
      return;
    }
    // In opt-in staging all mutations read the same cursor without updating route data.
    const version = ++refreshVersion;
    const query = page ? `?${new URLSearchParams({ page })}` : '';
    const read = staging ? readStagingPage() : fetch(`/api/root-listing${query}`, { redirect: 'error' })
      .then((response): Promise<RootListingResult> | null => response.ok ? response.json() : null);
    // preloadData cannot be aborted; only a read that wins the deadline may update the list.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = reason === 'rename' || reason === 'move' ? await Promise.race([read, new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 5_000);
    })]).finally(() => clearTimeout(timer)) : await read;
    if (version < appliedVersion) return;
    if (!next || (next.status !== 'ok' && (reason === 'folder' || !staging))) throw new Error('Root listing unavailable');
    appliedVersion = version;
    const focused = document.activeElement;
    flushSync(() => { refreshed = next; movedButNotRefreshed = []; });
    restoreFocus(focused, next.status);
    if (next.status !== 'ok') throw new Error('Root listing unavailable');
  }

  function restoreFocus(focused: Element | null, next: RootListingResult['status'] = 'ok') {
    if (focused && !focused.isConnected && document.activeElement === document.body) {
      (next === 'ok' ? header?.querySelector('button') : recovery)?.focus();
    }
  }

  async function folderCreated(id: string, name: string, close: () => void) {
    await refresh('folder').then(() => { receipt = { id, name, loaded: result.status === 'ok' }; },
      () => { receipt = { id, name, loaded: false }; });
    await tick();
    close();
    if (createdVisible) list?.focusCreatedRow(id);
    else recovery?.focus();
  }

  function returnToRow(id: string) {
    if (!list?.focusActions(id)) (recovery ?? heading).focus();
  }

  function openRename(id: string) {
    const item = items.find(item => item.id === id && !item.shared);
    const path = entryChangePath(id);
    if (!item || !path || !metadataWriteAllowed) return;
    if (!renameRefreshFailed) renameStatus = '';
    nameDialog?.open({ id, name: item.name, kind: item.kind, path });
  }

  async function renamed(id: string, name: string, close: () => void) {
    const index = items.findIndex(item => item.id === id);
    try { await refresh('rename'); renameRefreshFailed = false; }
    catch { renameRefreshFailed = result.status !== 'invalid-page'; }
    const item = items.find(item => item.id === id);
    const detail = renameRefreshFailed ? ' Refresh My Drive to see it.' : !item ? ' It isn’t on this page.' :
      item.name !== name ? ' My Drive now shows a different name.' : '';
    // Reopen the live region's accessibility subtree before publishing its text.
    await tick();
    close();
    const neighbor = items[Math.min(Math.max(0, index), items.length - 1)];
    if (renameRefreshFailed) (recovery ?? heading).focus();
    else if (item || !neighbor) returnToRow(id);
    else list?.focusName(neighbor.id);
    renameStatus = `Renamed to “${name}”.${detail}`;
  }

  function openMove(id: string) {
    const item = items.find(item => item.id === id && !item.shared);
    if (item?.renamable && metadataWriteAllowed) moveDialog?.open({ id, name: item.name, kind: item.glyph });
  }

  async function moved(id: string, destination: { id: string | null; name: string }, close: () => void) {
    const index = items.findIndex(item => item.id === id);
    const neighbors = index < 0 ? [] : [...items.slice(index + 1), ...items.slice(0, index).reverse()];
    try { await refresh('move'); }
    catch { if (result.status === 'ok') movedButNotRefreshed = [...movedButNotRefreshed, id]; }
    await tick();
    close();
    const neighbor = neighbors.find(({ id }) => items.some(item => item.id === id)) ?? items.find(item => item.id !== id);
    if (items.some(item => item.id === id)) returnToRow(id);
    else if (neighbor) list?.focusName(neighbor.id);
    else (recovery ?? heading).focus();
    moveReceipt = destination;
  }

  // loadRootListing returns only this session's owned entries at parent_id IS NULL.
  const items = $derived(result.status === 'ok' ? result.folder.entries.filter(({ id }) => !movedButNotRefreshed.includes(id)).map(({ id, name, kind, downloadable }) => ({
    id, name, kind: kind === 'folder' ? 'Folder' : 'File', glyph: kind,
    href: downloadAllowed && downloadable !== false && kind === 'file' && entryId.test(id) ? `/api/download/${id}` : undefined,
    reload: true, size: '', bytes: null, modified: '', shared: false, renamable: metadataWriteAllowed && !!entryChangePath(id)
  })) : []);
  const createdVisible = $derived(!!receipt && items.some(item => item.id === receipt?.id));
  const needsRefresh = $derived(receipt && (result.status === 'unavailable' || (result.status === 'ok' && !receipt.loaded && !createdVisible)));
</script>

<header bind:this={header} class:can-create={metadataWriteAllowed && result.status === 'ok'}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (only -1, for focus recovery) -->
  <h1 bind:this={heading} tabindex={metadataWriteAllowed ? -1 : undefined}>My Drive</h1>
  {#if uploadMode !== 'disabled' && result.status === 'ok'}
    <RootUpload mode={uploadMode} announce={(message) => { status = message; }} {refresh} paginated={page !== null} bind:busy />
  {/if}
  {#if metadataWriteAllowed}
    <MoveDialog bind:this={moveDialog} onmoved={moved} onreturn={returnToRow} />
    <NameDialog bind:this={nameDialog} available={result.status === 'ok'} {items} oncreated={folderCreated} onrenamed={renamed} onreturn={returnToRow} />
  {/if}
</header>
<p class:status={!status || !staging || result.status === 'ok'} role="status">{status}</p>
{#if metadataWriteAllowed}<p class:status={!receipt || createdVisible} role="status">{receipt ? `Created “${receipt.name}”.${createdVisible || result.status === 'invalid-page' ? '' : needsRefresh ? ' Refresh My Drive to see it.' : ' It isn’t on this page.'}` : ''}</p>{/if}
{#if metadataWriteAllowed}<p class:status={!renameStatus || !renameRefreshFailed} role="status">{renameStatus}</p>{/if}
{#if metadataWriteAllowed}
  <div class:move-notice={!!moveReceipt}>
    <p role="status" class:status={!moveReceipt}>{#if moveReceipt}<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4 10-10"/></svg> Moved to <bdi>{moveReceipt.name}</bdi>{/if}</p>
    {#if moveReceipt}
      <a href={moveReceipt.id === null ? '/' : `/f/${moveReceipt.id}`} data-sveltekit-reload>Open <bdi>{moveReceipt.name}</bdi></a>
      {#if movedButNotRefreshed.length}<a href={page ? `/?page=${page}` : '/'} data-sveltekit-reload>Refresh My Drive</a>{/if}
    {/if}
  </div>
{/if}
{#if result.status === 'unavailable'}
  <p class="error">This folder didn't load. Check your connection, then try again.</p>
{:else if result.status === 'invalid-page'}
  <p class="error">This page is no longer available.</p>
{/if}
{#if needsRefresh || renameRefreshFailed || result.status === 'unavailable'}
  <a bind:this={recovery} data-sveltekit-reload href={page ? `/?page=${page}` : '/'}>{needsRefresh || renameRefreshFailed ? 'Refresh My Drive' : 'Try again'}</a>
{:else if result.status === 'invalid-page'}
  <a bind:this={recovery} data-sveltekit-reload href="/">Back to first page</a>
{/if}
{#if result.status === 'ok'}
  {#if items.length}
    <FileList bind:this={list} folder="My Drive" preview announceChanges={false} {items} onRename={metadataWriteAllowed ? openRename : undefined} onMove={metadataWriteAllowed ? openMove : undefined} createdId={receipt?.id} />
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
  .move-notice { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--drive-space-2); padding: var(--drive-space-4); margin-bottom: var(--drive-space-4); border-radius: var(--drive-radius-m); background: var(--drive-color-state-ok-bg); }
  .move-notice p { margin: 0; }
  .move-notice svg { width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); vertical-align: text-bottom; color: var(--drive-color-state-ok); }
  .error { color: var(--drive-color-state-danger); }
</style>
