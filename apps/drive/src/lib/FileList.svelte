<script lang="ts">
  import { onMount } from 'svelte';
  import './tokens.css';
  import KindGlyph from './KindGlyph.svelte';

  let desktop: HTMLTableElement;
  let mobile: HTMLUListElement;
  let compactSort: HTMLSelectElement;
  let desktopSort: HTMLButtonElement;

  onMount(() => {
    const compact = window.matchMedia('(max-width: 820px)');
    let lastFocused: HTMLElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      lastFocused = target instanceof HTMLElement && (target === compactSort || target === desktopSort || ((desktop.contains(target) || mobile.contains(target)) && target instanceof HTMLAnchorElement)) ? target : null;
    };
    const forgetFocus = (event: FocusEvent) => {
      if (event.target === lastFocused && lastFocused?.getClientRects().length) lastFocused = null;
    };
    const transferFocus = () => {
      const from = compact.matches ? desktop : mobile;
      const to = compact.matches ? mobile : desktop;
      const active = document.activeElement;
      const hiddenSort = compact.matches ? desktopSort : compactSort;
      const visibleSort = compact.matches ? compactSort : desktopSort;
      if (hiddenSort && (active === hiddenSort || (active === document.body && lastFocused === hiddenSort))) {
        lastFocused = null;
        visibleSort?.focus();
        return;
      }
      const source = active instanceof HTMLAnchorElement && from.contains(active) ? active :
        active === document.body && lastFocused instanceof HTMLAnchorElement && from.contains(lastFocused) ? lastFocused : null;
      if (!source) return;
      const target = Array.from(to.querySelectorAll('a')).find(link => link.dataset.itemId === source.dataset.itemId);
      lastFocused = null;
      target?.focus();
    };
    document.addEventListener('focusin', rememberFocus);
    document.addEventListener('focusout', forgetFocus);
    compact.addEventListener('change', transferFocus);
    return () => {
      document.removeEventListener('focusin', rememberFocus);
      document.removeEventListener('focusout', forgetFocus);
      compact.removeEventListener('change', transferFocus);
    };
  });

  // Do not break a word across separately shaped spans.
  function wordBoundary(characters: string[], split: number, suffixStart: number): number {
    const letterOrMark = /[\p{L}\p{M}]/u;
    while (split < suffixStart && letterOrMark.test(characters[split - 1]) && letterOrMark.test(characters[split])) split++;
    return split;
  }

  // Keep the end of the name, including its extension, outside the ellipsized span.
  function nameParts(name: string): [string, string] {
    // Without segmentation, split only at boundaries known not to divide a grapheme.
    if (typeof Intl.Segmenter !== 'function') {
      if (name.length <= 12) return [name, ''];
      const dot = name.lastIndexOf('.');
      if (!/^[\x20-\x7e]+$/.test(name)) {
        // A printable ASCII character before the dot guarantees a boundary
        // before it, even when the extension starts with a combining mark.
        if (dot > 0 && name.length - dot <= 16 && /^[\x20-\x7e]$/.test(name[dot - 1])) {
          return [name.slice(0, dot), name.slice(dot)];
        }
        // An ASCII letter or digit after a dot begins a new grapheme; keep the
        // dot with the original prefix so unusual Unicode sequences stay intact.
        if (dot > 0 && /^[A-Za-z0-9]{1,15}$/.test(name.slice(dot + 1))) {
          return [name.slice(0, dot + 1), name.slice(dot + 1)];
        }
        return [name, ''];
      }
      const suffixStart = dot > 0 && name.length - dot <= 16 ? dot : name.length;
      const retained = name.length - suffixStart > 8 ? 0 : Math.min(6, Math.floor(suffixStart / 2));
      const split = wordBoundary(Array.from(name), suffixStart - retained, suffixStart);
      return [name.slice(0, split), name.slice(split)];
    }
    const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name), part => part.segment);
    if (characters.length <= 12) return [name, ''];
    const dot = characters.lastIndexOf('.');
    const suffixStart = dot > 0 && characters.length - dot <= 16 ? dot : characters.length;
    const retained = characters.length - suffixStart > 8 ? 0 : Math.min(6, Math.floor(suffixStart / 2));
    const split = wordBoundary(characters, suffixStart - retained, suffixStart);
    return [characters.slice(0, split).join(''), characters.slice(split).join('')];
  }

  // The caller supplies authorized URLs and already-sorted display values.
  export let folder: string;
  export let timeZone: string;
  // The caller pages and orders folders before files, by binary name within each group.
  export let direction: 'asc' | 'desc' = 'asc';
  export let total: number | undefined = undefined;
  export let hasMore = false;
  export let loadingMore = false;
  export let loadMoreError = false;
  export let onSort: ((direction: 'asc' | 'desc') => void) | undefined = undefined;
  export let onMore: (() => void) | undefined = undefined;
  let usedPaging = false;
  $: orderDescription = direction === 'asc' ? 'A to Z' : 'Z to A';
  $: description = `Contents of ${folder}, folders first, then files, each sorted by name, ${orderDescription} (binary order). Times in ${timeZone}.`;
  export let items: { id: string; name: string; href: string; kind: string; glyph: 'folder' | 'folder-shared' | 'file' | 'image' | 'video' | 'audio' | 'document' | 'archive'; size: string; bytes: number | null; modified: string; modifiedAt: string; shared: boolean }[];
</script>

{#if onSort}
  <div class="compact-sort"><label>Sort <select aria-label="Sort" bind:this={compactSort} value={direction} on:change={(event) => { const next = event.currentTarget.value as 'asc' | 'desc'; event.currentTarget.value = direction; onSort?.(next); }}><option value="asc">Name, A to Z</option><option value="desc">Name, Z to A</option></select></label></div>
  <p class="order-note">Folders appear first, then files. Names use binary order, not locale or numeric order.</p>
{/if}
<p class="status" role="status">{#if onSort}Folders first, then files, each sorted by name, {orderDescription}, in binary order.{/if}{#if usedPaging} {total === undefined ? `${items.length.toLocaleString()} shown.` : `${items.length.toLocaleString()} of ${total.toLocaleString()} shown.`}{/if}</p>
<table class="desktop" bind:this={desktop}>
  <caption>{description}</caption>
  <thead><tr><th scope="col" aria-sort="other">{#if onSort}<button class="sort-button" bind:this={desktopSort} type="button" on:click={() => onSort?.(direction === 'asc' ? 'desc' : 'asc')}>Name <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span></button>{:else}Name{/if}</th><th scope="col" class="size">Size</th><th scope="col">Modified</th><th scope="col">Kind</th></tr></thead>
  <tbody>
    {#each items as item (item.id)}
      <tr>
        <td><span class="name"><KindGlyph kind={item.glyph} /><a href={item.href} dir="auto" data-item-id={item.id} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class:folder={item.glyph === 'folder' || item.glyph === 'folder-shared'}><span class="name-start">{nameParts(item.name)[0]}</span><span class="name-end">{nameParts(item.name)[1]}</span>{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</span></td>
        <td class="size">{#if item.bytes === null}—{:else}<data value={item.bytes}>{item.size}</data>{/if}</td><td><time datetime={item.modifiedAt}>{item.modified}</time></td><td>{item.kind}</td>
      </tr>
    {/each}
  </tbody>
</table>
<ul class="mobile" role="list" bind:this={mobile} aria-label={description}>
  {#each items as item (item.id)}
    <li><div><span class="name"><KindGlyph kind={item.glyph} /><a href={item.href} dir="auto" data-item-id={item.id} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class:folder={item.glyph === 'folder' || item.glyph === 'folder-shared'}><span class="name-start">{nameParts(item.name)[0]}</span><span class="name-end">{nameParts(item.name)[1]}</span>{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</span></div><div class="details">{item.kind} · {#if item.bytes !== null}<data value={item.bytes}>{item.size}</data> · {/if}<time datetime={item.modifiedAt}>{item.modified}</time></div></li>
  {/each}
</ul>
{#if total !== undefined || onMore}
  <div class="paging">
    {#if onMore && ((total !== undefined && total > 200) || hasMore || loadingMore || usedPaging)}<button type="button" aria-busy={loadingMore} aria-disabled={loadingMore || !hasMore} on:click={() => { if (!loadingMore && hasMore) { usedPaging = true; onMore?.(); } }}>{loadingMore ? 'Showing more…' : hasMore ? loadMoreError ? 'Try again' : 'Show 200 more' : 'All items shown'}</button>{/if}
    <span>{total === undefined ? `${items.length.toLocaleString()} shown` : `${items.length.toLocaleString()} of ${total.toLocaleString()} shown`}</span>
  </div>
  {#if loadMoreError}<p class="paging-error" role="alert">More items didn't load. Check your connection, then try again.</p>{/if}
{/if}

<style>
  table, ul { width: 100%; color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); font-size: var(--drive-font-size-ui); }
  table { border-collapse: collapse; table-layout: fixed; text-align: left; }
  caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  th, td { height: var(--drive-size-row-admin); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  thead { background: var(--drive-color-bg-surface); }
  th { color: var(--drive-color-text-secondary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-label); font-weight: var(--drive-font-weight-medium); letter-spacing: var(--drive-tracking-label); text-transform: uppercase; }
  td { vertical-align: middle; }
  th:nth-child(2) { width: var(--drive-size-column-size); } th:nth-child(3) { width: var(--drive-size-column-modified); } th:nth-child(4) { width: var(--drive-size-column-kind); }
  .size { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; unicode-bidi: plaintext; } a:hover { text-decoration: underline; } a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .name { display: inline-flex; align-items: center; gap: var(--drive-space-2); max-width: 100%; }
  .name a { display: inline-flex; min-width: 0; padding-block: var(--drive-space-2); white-space: break-spaces; }
  .name-start { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  .name-end { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
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
</style>
