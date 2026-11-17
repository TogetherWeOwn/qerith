<script lang="ts">
  import { onMount } from 'svelte';
  import './tokens.css';
  import KindGlyph from './KindGlyph.svelte';

  let desktop: HTMLTableElement;
  let mobile: HTMLUListElement;

  onMount(() => {
    const compact = window.matchMedia('(max-width: 820px)');
    let lastFocused: HTMLAnchorElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      lastFocused = target instanceof HTMLAnchorElement && (desktop.contains(target) || mobile.contains(target)) ? target : null;
    };
    const forgetFocus = (event: FocusEvent) => {
      if (event.target === lastFocused && lastFocused?.getClientRects().length) lastFocused = null;
    };
    const transferFocus = () => {
      const from = compact.matches ? desktop : mobile;
      const to = compact.matches ? mobile : desktop;
      const active = document.activeElement;
      const source = active instanceof HTMLAnchorElement && from.contains(active) ? active :
        active === document.body && lastFocused && from.contains(lastFocused) ? lastFocused : null;
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

  // Keep the end of the name, including its extension, outside the ellipsized span.
  function nameParts(name: string): [string, string] {
    // Do not split combining sequences or emoji if segmentation is unavailable.
    if (typeof Intl.Segmenter !== 'function') return [name, ''];
    const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name), part => part.segment);
    if (characters.length <= 12) return [name, ''];
    const dot = characters.lastIndexOf('.');
    const suffixStart = dot > 0 && characters.length - dot <= 16 ? dot : characters.length;
    const retained = Math.min(6, Math.floor(suffixStart / 2));
    const split = suffixStart - retained;
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
  let usedPaging = false;
  export let onSort: ((direction: 'asc' | 'desc') => void) | undefined = undefined;
  export let onMore: (() => void) | undefined = undefined;
  $: orderDescription = direction === 'asc' ? 'A to Z' : 'Z to A';
  $: description = `Contents of ${folder}, folders first, then files, each sorted by name, ${orderDescription} (binary order). Times in ${timeZone}.`;
  export let items: { id: string; name: string; href: string; kind: string; glyph: 'folder' | 'folder-shared' | 'file' | 'image' | 'video' | 'audio' | 'document' | 'archive'; size: string; bytes: number | null; modified: string; modifiedAt: string; shared: boolean }[];
</script>

{#if onSort}
  <div class="compact-sort"><label for="listing-sort">Sort</label> <select id="listing-sort" value={direction} on:change={(event) => onSort?.(event.currentTarget.value as 'asc' | 'desc')}><option value="asc">Name, A to Z</option><option value="desc">Name, Z to A</option></select></div>
  <p class="order-note">Folders appear first, then files. Names use binary order, not locale or numeric order.</p>
  <p class="status" role="status">Folders first, then files, each sorted by name, {orderDescription}, in binary order.</p>
{/if}
<table class="desktop" bind:this={desktop}>
  <caption>{description}</caption>
  <thead><tr><th scope="col" aria-sort="other">{#if onSort}<button class="sort-button" type="button" on:click={() => onSort?.(direction === 'asc' ? 'desc' : 'asc')}>Name <span aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span></button>{:else}Name{/if}</th><th scope="col" class="size">Size</th><th scope="col">Modified</th><th scope="col">Kind</th></tr></thead>
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
    <li><div><span class="name"><KindGlyph kind={item.glyph} /><a href={item.href} dir="auto" data-item-id={item.id} aria-label={item.name.trim() ? item.name : `${item.name} (Whitespace-only name)`} class:folder={item.glyph === 'folder' || item.glyph === 'folder-shared'}><span class="name-start">{nameParts(item.name)[0]}</span><span class="name-end">{nameParts(item.name)[1]}</span>{#if !item.name.trim()}<span> (Whitespace-only name)</span>{/if}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</span></div><div class="details">{item.kind} · {#if item.bytes !== null}<data value={item.bytes}>{item.size}</data>{' · '}{/if}<time datetime={item.modifiedAt}>{item.modified}</time></div></li>
  {/each}
</ul>
{#if total !== undefined}
  <div class="paging">
    {#if onMore && (total > 200 || hasMore || loadingMore || usedPaging)}<button type="button" aria-busy={loadingMore} aria-disabled={loadingMore || !hasMore} on:click={() => { if (!loadingMore && hasMore) { usedPaging = true; onMore?.(); } }}>{loadingMore ? 'Showing more…' : hasMore ? loadMoreError ? 'Try again' : 'Show 200 more' : 'All items shown'}</button>{/if}
    <span>{items.length.toLocaleString()} of {total.toLocaleString()} shown</span>
  </div>
  {#if loadMoreError}<p role="alert">More items didn't load. Check your connection, then try again.</p>{/if}
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
  .name-end { flex: none; white-space: pre; }
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
  .order-note, .paging { color: var(--drive-color-text-secondary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .paging { display: flex; align-items: center; gap: var(--drive-space-2); padding: var(--drive-space-2); }
  .sort-button { color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; background: transparent; border: 0; cursor: pointer; }
  button:focus-visible, select:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .mobile { display: none; margin: 0; padding: 0; list-style: none; }
  li { min-height: var(--drive-size-row-dense); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  .details { margin-top: var(--drive-space-1); color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  @media (max-width: 820px) { .desktop { display: none; } .mobile, .compact-sort { display: block; } }
</style>
