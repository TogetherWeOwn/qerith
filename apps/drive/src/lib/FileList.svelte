<script lang="ts">
  import { onMount, tick } from 'svelte';
  import './tokens.css';
  import KindGlyph from './KindGlyph.svelte';
  import FileDetails from './FileDetails.svelte';
  import RowActions, { type RowAction } from './RowActions.svelte';

  let detailsId: string | null = null;
  async function showDetails(container: HTMLElement, id: string) {
    detailsId = id;
    await tick();
    if (detailsId !== id) return;
    Array.from(container.querySelectorAll<HTMLElement>('[data-details-id]')).find(element => element.dataset.detailsId === id)?.focus();
  }
  function closeDetails(container: HTMLElement, id: string) {
    detailsId = null;
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-row-id]')).find(element => element.dataset.rowId === id);
    row?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.focus();
  }
  let listing: HTMLDivElement;
  let desktop: HTMLTableElement;
  let mobile: HTMLUListElement;
  let compactSort: HTMLSelectElement;
  let desktopSort: HTMLButtonElement;

  onMount(() => {
    const compact = window.matchMedia('(max-width: 820px)');
    let lastFocused: HTMLElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      lastFocused = target instanceof HTMLElement && (target === compactSort || target === desktopSort || desktop.contains(target) || mobile.contains(target)) ? target : null;
    };
    const forgetFocus = (event: FocusEvent) => {
      if (event.target === lastFocused && lastFocused?.getClientRects().length) lastFocused = null;
    };
    const transferFocus = () => {
      const isCompact = desktop.getClientRects().length === 0;
      const from = isCompact ? desktop : mobile;
      const to = isCompact ? mobile : desktop;
      const active = document.activeElement;
      const hiddenSort = isCompact ? desktopSort : compactSort;
      const visibleSort = isCompact ? compactSort : desktopSort;
      if (hiddenSort && (active === hiddenSort || (active === document.body && lastFocused === hiddenSort))) {
        lastFocused = null;
        visibleSort?.focus();
        return;
      }
      const source = active instanceof HTMLElement && from.contains(active) ? active :
        active === document.body && lastFocused && from.contains(lastFocused) ? lastFocused : null;
      if (!source) return;
      let target: HTMLElement | null | undefined;
      if (source instanceof HTMLAnchorElement) target = Array.from(to.querySelectorAll<HTMLAnchorElement>('a[data-item-id]')).find(link => link.dataset.itemId === source.dataset.itemId);
      else {
        const facts = source.closest<HTMLElement>('[data-details-id]');
        const row = source.closest<HTMLElement>('[data-row-id]');
        if (facts) {
          const next = Array.from(to.querySelectorAll<HTMLElement>('[data-details-id]')).find(element => element.dataset.detailsId === facts.dataset.detailsId);
          target = source === facts ? next : next?.querySelector('button');
        } else if (row) {
          const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
          if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click();
          target = Array.from(to.querySelectorAll<HTMLElement>('[data-row-id]')).find(element => element.dataset.rowId === row.dataset.rowId)?.querySelector('button[aria-haspopup="menu"]');
        }
      }
      lastFocused = null;
      target?.focus();
    };
    document.addEventListener('focusin', rememberFocus);
    document.addEventListener('focusout', forgetFocus);
    compact.addEventListener('change', transferFocus);
    const observer = new ResizeObserver(transferFocus);
    observer.observe(listing);
    return () => {
      document.removeEventListener('focusin', rememberFocus);
      document.removeEventListener('focusout', forgetFocus);
      compact.removeEventListener('change', transferFocus);
      observer.disconnect();
    };
  });

  // The caller supplies authorized URLs and already-sorted display values.
  export let folder: string;
  export let timeZone: string;
  // The caller pages and orders folders before files, by binary name within each group.
  export let direction: 'asc' | 'desc' = 'asc';
  export let total: number | undefined = undefined;
  export let hasMore = false;
  export let loadingMore = false;
  export let loadMoreError = false;
  let usedPaging = false;
  export let onSort: ((direction: 'asc' | 'desc') => void) | undefined = undefined;
  export let onMore: (() => void) | undefined = undefined;
  $: orderDescription = direction === 'asc' ? 'A to Z' : 'Z to A';
  $: description = `Contents of ${folder}, folders first, then files, each sorted by name, ${orderDescription} (binary order). Times in ${timeZone}.`;
  export let onAction: ((id: string, action: RowAction) => void) | undefined = undefined;
  export let items: { id: string; name: string; href: string; kind: string; glyph: 'folder' | 'folder-shared' | 'file' | 'image' | 'video' | 'audio' | 'document' | 'archive'; size: string; bytes: number | null; modified: string; modifiedAt: string; shared: boolean; owned?: boolean; details?: { modifiedFull: string; uploaded: string; sharedWith?: string[] } }[];
</script>

<svelte:window on:keydown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented && detailsId && document.activeElement instanceof Element) { const facts = document.activeElement.closest('[data-details-id]'); const container = facts && (desktop.contains(facts) ? desktop : mobile.contains(facts) ? mobile : null); if (container && facts?.getAttribute('data-details-id') === detailsId) { event.preventDefault(); closeDetails(container, detailsId); } } }} />
<div class="listing" bind:this={listing}>
{#if onSort}
  <div class="compact-sort"><label>Sort <select aria-label="Sort" bind:this={compactSort} value={direction} on:change={(event) => { const next = event.currentTarget.value as 'asc' | 'desc'; event.currentTarget.value = direction; onSort?.(next); }}><option value="asc">Name, A to Z</option><option value="desc">Name, Z to A</option></select></label></div>
  <p class="order-note">Folders appear first, then files. Names use binary order, not locale or numeric order.</p>
{/if}
<p class="status" role="status">{#if onSort}Folders first, then files, each sorted by name, {orderDescription}, in binary order.{/if}{#if usedPaging} {total === undefined ? `${items.length.toLocaleString()} shown.` : `${items.length.toLocaleString()} of ${total.toLocaleString()} shown.`}{/if}</p>
<table class="desktop" bind:this={desktop}>
  <caption>{description}</caption>
  <thead><tr><th scope="col" aria-sort="other">{#if onSort}<button class="sort-button" bind:this={desktopSort} type="button" on:click={() => onSort?.(direction === 'asc' ? 'desc' : 'asc')}>Name <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span></button>{:else}Name{/if}</th><th scope="col" class="size">Size</th><th scope="col">Modified</th><th scope="col">Kind</th><th scope="col">Actions</th></tr></thead>
  <tbody>
    {#each items as item (item.id)}
      <tr>
        <td><span class="name"><KindGlyph kind={item.glyph} /><a href={item.href} dir="auto" data-item-id={item.id} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class:folder={item.glyph === 'folder' || item.glyph === 'folder-shared'}>{item.name}{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</span></td>
        <td class="size">{#if item.bytes === null}—{:else}<data value={item.bytes}>{item.size}</data>{/if}</td><td><time datetime={item.modifiedAt}>{item.modified}</time></td><td>{item.kind}</td>
        <td><div data-row-id={item.id}><RowActions name={item.name} file={item.bytes !== null} owned={item.owned ?? false} detailsOnly={!onAction} onAction={(action) => { if (action === 'Details') void showDetails(desktop, item.id); else onAction?.(item.id, action); }} onTab={() => false} /></div></td>
      </tr>
      {#if detailsId === item.id}<tr><td colspan="5"><FileDetails id={item.id} name={item.name} size={item.size} bytes={item.bytes} kind={item.kind} {...item.details} modifiedFull={item.details?.modifiedFull || item.modified} onClose={() => closeDetails(desktop, item.id)} /></td></tr>{/if}
    {/each}
  </tbody>
</table>
<ul class="mobile" role="list" bind:this={mobile} aria-label={description}>
  {#each items as item (item.id)}
    <li><div><span class="name"><KindGlyph kind={item.glyph} /><a href={item.href} dir="auto" data-item-id={item.id} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class:folder={item.glyph === 'folder' || item.glyph === 'folder-shared'}>{item.name}{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</span></div><div class="details">{item.kind} · {#if item.bytes !== null}<data value={item.bytes}>{item.size}</data>{' · '}{/if}<time datetime={item.modifiedAt}>{item.modified}</time></div><div data-row-id={item.id}><RowActions name={item.name} file={item.bytes !== null} owned={item.owned ?? false} detailsOnly={!onAction} onAction={(action) => { if (action === 'Details') void showDetails(mobile, item.id); else onAction?.(item.id, action); }} onTab={() => false} /></div>{#if detailsId === item.id}<FileDetails id={item.id} name={item.name} size={item.size} bytes={item.bytes} kind={item.kind} {...item.details} modifiedFull={item.details?.modifiedFull || item.modified} onClose={() => closeDetails(mobile, item.id)} />{/if}</li>
  {/each}
</ul>
{#if total !== undefined || onMore}
  <div class="paging">
    {#if onMore && ((total !== undefined && total > 200) || hasMore || loadingMore || usedPaging)}<button type="button" aria-busy={loadingMore} aria-disabled={loadingMore || !hasMore} on:click={() => { if (!loadingMore && hasMore) { usedPaging = true; onMore?.(); } }}>{loadingMore ? 'Showing more…' : hasMore ? loadMoreError ? 'Try again' : 'Show 200 more' : 'All items shown'}</button>{/if}
    <span>{total === undefined ? `${items.length.toLocaleString()} shown` : `${items.length.toLocaleString()} of ${total.toLocaleString()} shown`}</span>
  </div>
  {#if loadMoreError}<p class="paging-error" role="alert">More items didn't load. Check your connection, then try again.</p>{/if}
{/if}
</div>

<style>
  .listing { container-type: inline-size; }
  table, ul { width: 100%; color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); font-size: var(--drive-font-size-ui); }
  table { border-collapse: collapse; table-layout: fixed; text-align: left; }
  caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  th, td { height: var(--drive-size-row-admin); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  thead { background: var(--drive-color-bg-surface); }
  th { color: var(--drive-color-text-secondary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-label); font-weight: var(--drive-font-weight-medium); letter-spacing: var(--drive-tracking-label); text-transform: uppercase; }
  td { vertical-align: baseline; }
  th:nth-child(2) { width: var(--drive-size-column-size); } th:nth-child(3) { width: var(--drive-size-column-modified); } th:nth-child(4) { width: var(--drive-size-column-kind); } th:nth-child(5) { width: var(--drive-size-column-actions); }
  .size { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; unicode-bidi: plaintext; } a:hover { text-decoration: underline; } a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .name { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--drive-space-2); max-width: 100%; }
  .name :global(svg) { margin-top: var(--drive-space-2); }
  .name a { display: inline-block; flex: 1 1 0; min-width: 0; max-width: 100%; padding-block: var(--drive-space-2); white-space: break-spaces; overflow-wrap: anywhere; word-break: normal; }
  .folder { font-weight: var(--drive-font-weight-medium); }
  .tag { color: var(--drive-color-text-secondary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-label); letter-spacing: var(--drive-tracking-label); text-transform: uppercase; padding: var(--drive-space-inset-tag-y) var(--drive-space-inset-tag-x); border-radius: var(--drive-radius-s); box-shadow: inset 0 0 0 var(--drive-size-line) var(--drive-color-line-hairline-strong); }
  @media (forced-colors: active) { .tag { outline: var(--drive-size-line) solid transparent; outline-offset: calc(-1 * var(--drive-size-line)); } }
  @media (hover: hover) {
    tbody tr:hover, li:hover { background-color: var(--drive-color-bg-surface); }
  }
  @media (hover: hover) and (prefers-reduced-motion: no-preference) {
    tbody tr, li { transition: background-color var(--drive-motion-duration-base) var(--drive-motion-ease); }
  }
  .compact-sort { display: none; }
  .compact-sort label { display: flex; align-items: center; gap: var(--drive-space-2); font-family: var(--drive-font-ui); }
  .compact-sort select { min-height: var(--drive-size-control-sm); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-s); background: var(--drive-color-bg-surface); color: var(--drive-color-text-primary); font: inherit; }
  .order-note, .paging { color: var(--drive-color-text-secondary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .paging { display: flex; align-items: center; gap: var(--drive-space-2); padding: var(--drive-space-2); }
  .paging button { min-height: var(--drive-size-control-sm); padding: 0 var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-primary); font: inherit; cursor: pointer; }
  .paging button[aria-disabled='true'] { color: var(--drive-color-text-tertiary); cursor: default; }
  .paging-error { margin: 0; padding: 0 var(--drive-space-2); color: var(--drive-color-state-danger); font-family: var(--drive-font-ui); font-size: var(--drive-font-size-meta); }
  .sort-button { color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; background: transparent; border: 0; cursor: pointer; }
  button:focus-visible, select:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .mobile { display: none; margin: 0; padding: 0; list-style: none; }
  li { min-height: var(--drive-size-row-dense); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  .details { margin-top: var(--drive-space-1); color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  @media (max-width: 820px) { .desktop { display: none; } .mobile, .compact-sort { display: block; } }
  @container (max-width: 740px) { .desktop { display: none; } .mobile, .compact-sort { display: block; } }
</style>
