<script lang="ts">
  import { onMount, tick } from 'svelte';
  import './tokens.css';
  import KindGlyph from './KindGlyph.svelte';
  import FileDetails from './FileDetails.svelte';
  import RowActions, { type RowAction } from './RowActions.svelte';

  let desktop: HTMLTableElement;
  let mobile: HTMLUListElement;
  let compactSort: HTMLSelectElement;
  let desktopSort: HTMLButtonElement;
  const desktopActions: Record<string, { dismiss(): void; openFromContextMenu(event: MouseEvent): void } | undefined> = Object.create(null);
  const compactActions: typeof desktopActions = Object.create(null);
  const actionTrigger = 'button[aria-haspopup="menu"]';
  let checkLayoutOnOpen: ((when: 'now' | 'next-frame') => void) | undefined;

  let detailsId: string | null = null;
  const visibleView = () => desktop.getClientRects().length ? desktop : mobile;
  const findRowPart = (view: HTMLElement, attribute: string, id: string | null | undefined) =>
    Array.from(view.querySelectorAll<HTMLElement>(`[${attribute}]`)).find(el => el.getAttribute(attribute) === id);
  export function focusName(id: string) { findRowPart(visibleView(), 'data-focus-name', id)?.focus(); }
  export function focusCreatedRow(id: string) {
    findRowPart(visibleView(), 'data-created-row', id)?.focus();
  }
  const triggerFor = (view: HTMLElement, id: string) => findRowPart(view, 'data-action-row', id)?.querySelector<HTMLButtonElement>(actionTrigger);
  export function focusActions(id: string) {
    const trigger = triggerFor(visibleView(), id);
    trigger?.focus();
    return !!trigger;
  }

  $: if (detailsId !== null && ((onAction && !inlineDetails) || !items.some(item => item.id === detailsId))) {
    if (onAction && findRowPart(visibleView(), 'data-details-id', detailsId)?.contains(document.activeElement)) triggerFor(visibleView(), detailsId)?.focus();
    detailsId = null;
  }
  async function selectAction(source: HTMLElement, id: string, action: RowAction) {
    if (preview && action === 'Rename') { onRename?.(id); return; }
    if (action !== 'Details' || (onAction && !inlineDetails)) { onAction?.(id, action); return; }
    const sourceTrigger = triggerFor(source, id);
    detailsId = id;
    await tick();
    const active = document.activeElement;
    const view = visibleView();
    if (detailsId === id && (active === sourceTrigger || active === triggerFor(view, id))) findRowPart(view, 'data-details-id', id)?.focus();
  }
  function closeDetails(view: HTMLElement, id: string) {
    detailsId = null;
    triggerFor(view, id)?.focus();
  }
  function escapeDetails(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || detailsId === null || !(event.target instanceof Element)) return;
    const facts = event.target.closest('[data-details-id]');
    if (!facts || facts.getAttribute('data-details-id') !== detailsId) return;
    const view = desktop.contains(facts) ? desktop : mobile.contains(facts) ? mobile : null;
    if (view) { event.preventDefault(); closeDetails(view, detailsId); }
  }

  function contextMenu(event: MouseEvent, action: typeof desktopActions[string]) {
    const controlClick = event.button === 0 && event.ctrlKey && event instanceof PointerEvent && event.pointerType === 'mouse';
    if ((onAction || (preview && onRename && action)) && (event.button === 2 || controlClick) && !(event.target instanceof Element && event.target.closest('[data-details-id]'))) action?.openFromContextMenu(event);
  }

  onMount(() => {
    const compactViewport = window.matchMedia('(max-width: 820px)');
    let lastFocused: HTMLElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      lastFocused = target instanceof HTMLElement && (target === compactSort || target === desktopSort || ((desktop.contains(target) || mobile.contains(target)) && target.closest('a, [data-action-row], [data-details-id], [data-created-row], [data-focus-name]'))) ? target : null;
    };
    const forgetFocus = (event: FocusEvent) => {
      if (!lastFocused || event.target !== lastFocused) return;
      // A top-layer item can have a box after its listing view becomes hidden.
      const view = lastFocused.closest('[data-action-row]') ? (desktop.contains(lastFocused) ? desktop : mobile) : lastFocused;
      if (view.getClientRects().length) lastFocused = null;
    };
    const dismissMenus = (view: HTMLElement, actions: typeof desktopActions) => {
      const expanded = view.querySelectorAll<HTMLButtonElement>(`${actionTrigger}[aria-expanded="true"]`);
      for (const trigger of expanded) {
        const id = trigger.closest<HTMLElement>('[data-action-row]')?.dataset.actionRow;
        if (id !== undefined) actions[id]?.dismiss();
      }
    };
    const transferFocus = () => {
      const compact = desktop.getClientRects().length === 0;
      const from = compact ? desktop : mobile;
      const to = compact ? mobile : desktop;
      // Closing a top-layer menu can itself change focus, so snapshot it first.
      const active = document.activeElement;
      const focused = active === document.body ? lastFocused : active;
      dismissMenus(from, compact ? desktopActions : compactActions);
      if (!to.getClientRects().length) {
        dismissMenus(to, compact ? compactActions : desktopActions);
        lastFocused = null;
        return;
      }
      const hiddenSort = compact ? desktopSort : compactSort;
      const visibleSort = compact ? compactSort : desktopSort;
      if (hiddenSort && focused === hiddenSort) {
        lastFocused = null;
        visibleSort?.focus();
        return;
      }
      if (!(focused instanceof HTMLElement) || !from.contains(focused)) return;
      let target: HTMLElement | null | undefined;
      const facts = focused.closest<HTMLElement>('[data-details-id]');
      if (focused.dataset.focusName !== undefined) {
        target = findRowPart(to, 'data-focus-name', focused.dataset.focusName);
      } else if (focused instanceof HTMLAnchorElement) {
        target = Array.from(to.querySelectorAll('a')).find(link => link.dataset.itemId === focused.dataset.itemId);
      } else if (focused.hasAttribute('data-created-row')) {
        target = findRowPart(to, 'data-created-row', focused.getAttribute('data-created-row'));
      } else if (facts) {
        const next = findRowPart(to, 'data-details-id', facts.dataset.detailsId);
        target = focused === facts ? next : next?.querySelector('button[type="button"]');
      } else {
        const id = focused.closest<HTMLElement>('[data-action-row]')?.dataset.actionRow;
        target = findRowPart(to, 'data-action-row', id)?.querySelector(actionTrigger);
      }
      lastFocused = null;
      target?.focus();
    };
    let openingFrame = 0;
    // A menu can open in a transient layout that ResizeObserver never reports.
    checkLayoutOnOpen = (when) => {
      if (when === 'now') { transferFocus(); return; }
      cancelAnimationFrame(openingFrame);
      openingFrame = requestAnimationFrame(transferFocus);
    };
    document.addEventListener('focusin', rememberFocus);
    // Observe focus loss before a target blur handler can change the layout.
    document.addEventListener('blur', forgetFocus, true);
    // Keep viewport handoff timing; observe both views for container-only changes.
    compactViewport.addEventListener('change', transferFocus);
    const observer = new ResizeObserver(transferFocus);
    observer.observe(desktop);
    observer.observe(mobile);
    return () => {
      document.removeEventListener('focusin', rememberFocus);
      document.removeEventListener('blur', forgetFocus, true);
      compactViewport.removeEventListener('change', transferFocus);
      cancelAnimationFrame(openingFrame);
      observer.disconnect();
    };
  });

  // The caller supplies authorized URLs and already-sorted display values.
  export let folder: string;
  export let timeZone: string | undefined = undefined;
  // The caller pages and orders folders before files, by binary name within each group.
  export let preview = false;
  export let announceChanges = true;
  export let direction: 'asc' | 'desc' = 'asc';
  export let total: number | undefined = undefined;
  export let hasMore = false;
  export let loadingMore = false;
  export let loadMoreError = false;
  let usedPaging = false;
  export let onSort: ((direction: 'asc' | 'desc') => void) | undefined = undefined;
  export let onMore: (() => void) | undefined = undefined;
  $: orderDescription = direction === 'asc' ? 'A to Z' : 'Z to A';
  $: nameOrder = preview ? 'in binary order' : `${orderDescription} (binary order)`;
  $: description = `Contents of ${folder}, folders first, then files, each sorted by name, ${nameOrder}.${!preview && timeZone ? ` Times in ${timeZone}.` : ''}`;
  export let onAction: ((id: string, action: RowAction) => void) | undefined = undefined;
  export let onRename: ((id: string) => void) | undefined = undefined;
  export let inlineDetails = false;
  export let createdId: string | undefined = undefined;
  export let items: { id: string; name: string; href?: string; reload?: boolean; kind: string; glyph: 'folder' | 'folder-shared' | 'file' | 'image' | 'video' | 'audio' | 'document' | 'archive'; size: string; bytes: number | null; modified: string; modifiedAt?: string; shared: boolean; owned?: boolean; renamable?: boolean; details?: { modifiedFull?: string; uploaded?: string; sharedWith?: string[] } }[];
</script>

{#snippet entryName(item: (typeof items)[number])}
  {@const folder = item.glyph === 'folder' || item.glyph === 'folder-shared'}
  <span class="name">
    <KindGlyph kind={item.glyph} />
    {#if item.href}
      <a href={item.href} data-sveltekit-reload={item.reload ? '' : undefined} dir="auto" data-item-id={item.id} data-focus-name={onRename ? item.id : undefined} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class="entry-name" class:folder>{item.name}{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (only -1, after a row leaves the page) -->
      <span dir="auto" data-focus-name={onRename ? item.id : undefined} tabindex={onRename ? -1 : undefined} class="entry-name" class:folder>{item.name}{#if !item.name.trim()} (Whitespace-only name){/if}</span>
    {/if}
    {#if item.shared}<span class="tag">Shared</span>{/if}
  </span>
{/snippet}

<svelte:window on:keydown={escapeDetails} />
<div class="listing" class:preview>
{#if onSort}
  <div class="compact-sort"><label>Sort <select aria-label="Sort" bind:this={compactSort} value={direction} on:change={(event) => { const next = event.currentTarget.value as 'asc' | 'desc'; event.currentTarget.value = direction; onSort?.(next); }}><option value="asc">Name, A to Z</option><option value="desc">Name, Z to A</option></select></label></div>
  <p class="order-note">Folders appear first, then files. Names use binary order, not locale or numeric order.</p>
{/if}
{#if announceChanges}
  <p class="status" role="status">{#if onSort}Folders first, then files, each sorted by name, {orderDescription}, in binary order.{/if}{#if usedPaging} {total === undefined ? `${items.length.toLocaleString()} shown.` : `${items.length.toLocaleString()} of ${total.toLocaleString()} shown.`}{/if}</p>
{/if}
<table class="desktop" bind:this={desktop}>
  <caption>{description}</caption>
  <thead><tr><th scope="col" aria-sort="other">{#if onSort}<button class="sort-button" bind:this={desktopSort} type="button" on:click={() => onSort?.(direction === 'asc' ? 'desc' : 'asc')}>Name <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span></button>{:else}Name{/if}</th>{#if !preview}<th scope="col" class="size">Size</th><th scope="col">Modified</th>{/if}<th scope="col" class="kind">Kind</th>{#if !preview || onRename}<th scope="col" class="actions">Actions</th>{/if}</tr></thead>
  <tbody>
    {#each items as item (item.id)}
      <tr data-created-row={createdId === item.id ? item.id : undefined} tabindex={createdId === item.id ? -1 : undefined} on:contextmenu={(event) => contextMenu(event, desktopActions[item.id])}>
        <td>{@render entryName(item)}</td>
        {#if !preview}<td class="size">{#if item.bytes === null}—{:else}<data value={item.bytes}>{item.size}</data>{/if}</td><td><time datetime={item.modifiedAt}>{item.modified}</time></td>{/if}<td>{item.kind}</td>
        {#if !preview || onRename}
          <td data-action-row={item.id}>{#if !preview || (item.renamable && !item.shared)}<RowActions bind:this={desktopActions[item.id]} name={item.name} file={item.glyph !== 'folder' && item.glyph !== 'folder-shared'} owned={item.owned ?? false} detailsOnly={!onAction} {checkLayoutOnOpen} onAction={(action) => selectAction(desktop, item.id, action)} onTab={() => false} renameOnly={preview} />{/if}</td>
        {/if}
      </tr>
      {#if !preview && detailsId === item.id}<tr><td colspan="5"><FileDetails id={item.id} name={item.name} size={item.size} bytes={item.bytes} kind={item.kind} modifiedFull={item.details?.modifiedFull || item.modified} uploaded={item.details?.uploaded} sharedWith={item.owned && item.shared ? item.details?.sharedWith : undefined} onClose={() => closeDetails(desktop, item.id)} /></td></tr>{/if}
    {/each}
  </tbody>
</table>
<ul class="mobile" role="list" bind:this={mobile} aria-label={description}>
  {#each items as item (item.id)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (only -1, for focus after creation) -->
    <li class:with-actions={!preview || !!(onRename && item.renamable && !item.shared)} data-created-row={createdId === item.id ? item.id : undefined} tabindex={createdId === item.id ? -1 : undefined} on:contextmenu={(event) => contextMenu(event, compactActions[item.id])}><div>{@render entryName(item)}</div><div class="details">{item.kind}{#if !preview}{' · '}{#if item.bytes !== null}<data value={item.bytes}>{item.size}</data>{' · '}{/if}<time datetime={item.modifiedAt}>{item.modified}</time>{/if}</div>
      {#if !preview || (onRename && item.renamable && !item.shared)}
        <div data-action-row={item.id}><RowActions bind:this={compactActions[item.id]} name={item.name} file={item.glyph !== 'folder' && item.glyph !== 'folder-shared'} owned={item.owned ?? false} detailsOnly={!onAction} {checkLayoutOnOpen} onAction={(action) => selectAction(mobile, item.id, action)} onTab={() => false} renameOnly={preview} /></div>
      {/if}
      {#if !preview && detailsId === item.id}<FileDetails id={item.id} name={item.name} size={item.size} bytes={item.bytes} kind={item.kind} modifiedFull={item.details?.modifiedFull || item.modified} uploaded={item.details?.uploaded} sharedWith={item.owned && item.shared ? item.details?.sharedWith : undefined} onClose={() => closeDetails(mobile, item.id)} />{/if}
    </li>
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
  th.size { width: var(--drive-size-column-size); }
  .listing:not(.preview) th:nth-child(3) { width: var(--drive-size-column-modified); }
  th.kind { width: var(--drive-size-column-kind); }
  .preview a { text-decoration: underline; }
  th.actions { width: var(--drive-size-column-actions); }
  .size { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; unicode-bidi: plaintext; } a:hover { text-decoration: underline; } :is(a, [data-focus-name]):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .name { display: flex; align-items: flex-start; flex-wrap: wrap; gap: var(--drive-space-2); max-width: 100%; }
  .name :global(svg) { margin-top: var(--drive-space-2); }
  .entry-name { display: inline-block; flex: 1 1 0; min-width: 0; max-width: 100%; padding-block: var(--drive-space-2); white-space: break-spaces; overflow-wrap: anywhere; word-break: normal; unicode-bidi: plaintext; }
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
  li.with-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
  li.with-actions > [data-action-row] { grid-column: 2; grid-row: 1 / span 2; align-self: center; margin-inline-start: var(--drive-space-2); }
  li.with-actions > :global([data-details-id]) { grid-column: 1 / -1; }
  tbody tr:has([data-action-row] :global(button[aria-expanded='true'])), li:has([data-action-row] :global(button[aria-expanded='true'])) { background-color: var(--drive-color-bg-raised); }
  tbody tr[data-created-row], li[data-created-row] { background: var(--drive-color-bg-raised); }
  [data-created-row]:focus { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: calc(-1 * var(--drive-size-focus-width)); }
  .details { margin-top: var(--drive-space-1); color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  @media (max-width: 820px) { .desktop { display: none; } .mobile, .compact-sort { display: block; } }
  @container (max-width: 740px) { .desktop { display: none; } .mobile, .compact-sort { display: block; } }
  @container (max-width: 200px) {
    li.with-actions > :first-child { grid-column: 1 / -1; }
    li.with-actions > [data-action-row] { grid-row: 2; }
  }
</style>
