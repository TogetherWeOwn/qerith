<script lang="ts">
  import RootListingView from '../lib/RootListingView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>My Drive</title>
</svelte:head>

<main>
  {#if data.downloadNotice}
    <div role="alert">
      <p>{data.downloadNotice.name ?? 'The file'} didn’t download. Try again.</p>
      {#if data.downloadNotice.id}
        <a data-sveltekit-reload href={`/api/download/${data.downloadNotice.id}`}>Try again</a>
      {/if}
    </div>
  {/if}
  <RootListingView result={data.listing} paged={data.paged} />
</main>

<style>
  :global(body) { margin: 0; }
  main { min-height: 100vh; box-sizing: border-box; padding: var(--drive-space-4); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  a { color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
