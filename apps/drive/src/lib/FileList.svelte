<script lang="ts">
  import './tokens.css';

  // The caller supplies authorized URLs and already-sorted display values.
  export let folder: string;
  export let items: { id: string; name: string; href: string; kind: string; size: string; modified: string; shared: boolean }[];
</script>

<table class="desktop">
  <caption>Contents of {folder}, sorted by name, A to Z. Times in Europe/London.</caption>
  <thead><tr><th scope="col">Name</th><th scope="col" class="size">Size</th><th scope="col">Modified</th><th scope="col">Kind</th></tr></thead>
  <tbody>
    {#each items as item (item.id)}
      <tr>
        <td><a href={item.href}>{item.name}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</td>
        <td class="size">{item.size}</td><td>{item.modified}</td><td>{item.kind}</td>
      </tr>
    {/each}
  </tbody>
</table>
<ul class="mobile" aria-label="Contents of {folder}, sorted by name, A to Z. Times in Europe/London.">
  {#each items as item (item.id)}
    <li><div><a href={item.href}>{item.name}</a>{#if item.shared}<span class="tag">Shared</span>{/if}</div><div class="details">{item.kind === 'Folder' ? 'Folder' : item.size} · {item.modified}</div></li>
  {/each}
</ul>

<style>
  table, ul { width: 100%; color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); font-size: var(--drive-font-size-ui); }
  table { border-collapse: collapse; table-layout: fixed; text-align: left; }
  caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  th, td { height: var(--drive-size-row-admin); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  th { color: var(--drive-color-text-secondary); font-weight: var(--drive-font-weight-medium); }
  th:nth-child(2) { width: var(--drive-size-column-size); } th:nth-child(3) { width: var(--drive-size-column-modified); } th:nth-child(4) { width: var(--drive-size-column-kind); }
  .size { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; } a:hover { text-decoration: underline; } a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .tag { display: inline-block; margin-left: var(--drive-space-2); color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-meta); }
  .mobile { display: none; margin: 0; padding: 0; list-style: none; }
  li { min-height: var(--drive-size-row-dense); padding: var(--drive-space-2); border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); overflow-wrap: anywhere; }
  .details { margin-top: var(--drive-space-1); color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-meta); }
  @media (max-width: 820px) { .desktop { display: none; } .mobile { display: block; } }
</style>
