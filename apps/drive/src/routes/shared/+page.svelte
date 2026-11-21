<script lang="ts">
  import DriveNav from '../../lib/DriveNav.svelte';
  import KindGlyph from '../../lib/KindGlyph.svelte';
  import { entryId } from '../../lib/download-id';
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
  const label = (name: string) => name.trim() ? name : `${name} (Whitespace-only name)`;
  const kindLabel = (kind: 'file' | 'folder') => kind === 'folder' ? 'Folder' : 'File';
  const pageHref = (cursor: string | null) => cursor === null ? '/shared' : '/shared?' + new URLSearchParams({ cursor });
</script>

<svelte:head><title>Shared with me · Drive</title></svelte:head>
{#snippet nameCell(entry: NonNullable<PageData['entries']>[number])}
  <div class="name">
    <KindGlyph kind={entry.kind} />
    {#if entry.downloadable && entryId.test(entry.id)}
      <a href={'/api/download/' + entry.id} dir="auto">{label(entry.name)}</a>
    {:else}<span dir="auto">{label(entry.name)}</span>{/if}
  </div>
{/snippet}
<DriveNav current="shared" shared owner={false} />
<main id="main" tabindex="-1" data-sveltekit-reload>
  <h1>Shared with me</h1>
  <p class="lede">Shared with you to view and download.</p>
  {#if data.status === 'unavailable'}
    <div class="notice">
      <p role="alert"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/></svg>Shared items didn't load. Check your connection, then try again.</p>
      <a class="ghost" href={pageHref(data.retryCursor)}>Try again</a>
    </div>
  {:else if data.entries.length}
    <p class="count">{data.entries.length} {data.entries.length === 1 ? 'item' : 'items'} on this page</p>
    <table aria-label="Shared items">
      <thead><tr><th scope="col">Name</th><th scope="col">Kind</th></tr></thead>
      <tbody>
        {#each data.entries as entry (entry.id)}
          <tr><td>{@render nameCell(entry)}</td><td>{kindLabel(entry.kind)}</td></tr>
        {/each}
      </tbody>
    </table>
    <ul role="list" aria-label="Shared items">
      {#each data.entries as entry (entry.id)}
        <li>{@render nameCell(entry)}<span class="kind">{kindLabel(entry.kind)}</span></li>
      {/each}
    </ul>
  {:else if data.continued}<p>No more items.</p>
  {:else}
    <section class="empty">
      <h2>Nothing is shared with you yet.</h2>
      <p>When someone shares a file or folder, it shows up here.</p>
    </section>
  {/if}
  {#if data.status === 'ok' && (data.continued || data.nextCursor)}
    <nav aria-label="Shared items pages">
      {#if data.continued}<a href="/shared">First page</a>{/if}
      {#if data.nextCursor}<a href={pageHref(data.nextCursor)}>Next page</a>{/if}
    </nav>
  {/if}
</main>
<style>
  :global(body) { margin: 0; background: var(--drive-color-bg-canvas); }
  main { box-sizing: border-box; max-width: var(--drive-layout-container); margin: auto; padding: var(--drive-space-4) var(--drive-layout-gutter-wide); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  h1 { margin: 0; font-size: var(--drive-font-size-h3); }
  h2 { margin: 0; font-size: var(--drive-font-size-title); }
  p { color: var(--drive-color-text-secondary); }
  .lede { font-size: var(--drive-font-size-lede); }
  .count, .kind { color: var(--drive-color-text-tertiary); font: var(--drive-font-size-meta) var(--drive-font-data); }
  .empty { background: var(--drive-color-bg-surface); border-radius: var(--drive-radius-l); padding: var(--drive-space-6); }
  .empty p { margin-block-end: 0; }
  .notice { background: var(--drive-color-state-danger-bg); border-radius: var(--drive-radius-m); padding: var(--drive-space-4); }
  .notice p { display: flex; align-items: baseline; gap: var(--drive-space-2); margin: 0 0 var(--drive-space-3); color: var(--drive-color-text-primary); font-size: var(--drive-font-size-ui); }
  .notice svg { flex: none; width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); fill: none; stroke: var(--drive-color-state-danger); stroke-width: 2; stroke-linecap: round; align-self: start; margin-block-start: var(--drive-space-1); }
  .ghost { padding-inline: var(--drive-space-4); border-radius: var(--drive-radius-pill); box-shadow: inset 0 0 0 var(--drive-size-line) var(--drive-color-line-hairline-strong); color: var(--drive-color-text-primary); text-decoration: none; }
  .ghost:hover { background: var(--drive-color-bg-raised); }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding-inline: var(--drive-space-2); text-align: start; border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  th { height: var(--drive-size-row-admin); color: var(--drive-color-text-secondary); }
  th:last-child { width: var(--drive-size-column-kind); }
  .name { display: flex; align-items: center; gap: var(--drive-space-2); min-height: var(--drive-size-row-admin); font-size: var(--drive-font-size-ui); }
  .name :is(a, span) { min-width: 0; overflow-wrap: anywhere; white-space: break-spaces; unicode-bidi: plaintext; }
  a { display: inline-flex; align-items: center; min-height: var(--drive-size-control-sm); color: var(--drive-color-text-link); }
  :is(a, main):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  nav { display: flex; gap: var(--drive-space-4); margin-block-start: var(--drive-space-3); }
  ul { display: none; }
  @media (max-width: 820px) {
    main { padding-inline: var(--drive-layout-gutter-compact); }
    table { display: none; }
    ul { display: block; padding: 0; list-style: none; }
    li { box-sizing: border-box; min-height: var(--drive-size-row-dense); padding-block-end: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); }
    .kind { margin-inline-start: calc(var(--drive-size-icon-md) + var(--drive-space-2)); }
  }
</style>
