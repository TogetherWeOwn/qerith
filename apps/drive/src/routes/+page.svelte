<script lang="ts">
  import { untrack } from 'svelte';
  import RootListingView from '../lib/RootListingView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // The document consumes the notice; listing invalidation must not dismiss it.
  const downloadNotice = untrack(() => data.downloadNotice);
</script>

<svelte:head>
  <title>{data.listing ? 'My Drive' : 'Drive'}</title>
</svelte:head>

<main id="main">
  {#if downloadNotice}
    <div role="alert">
      <p>{`${downloadNotice.name ?? 'The file'} didn’t download.${data.staging ? '' : ' Try again.'}`}</p>
      {#if downloadNotice.id}
        <a data-sveltekit-reload href={`/api/download/${downloadNotice.id}`}>{data.staging ? 'Retry download' : 'Try again'}</a>
      {/if}
    </div>
  {/if}
  {#if data.listing}
    <RootListingView result={data.listing} page={data.page} uploadConfigured={data.uploadConfigured}
      staging={data.staging} bytesAllowed={data.bytesAllowed} />
  {:else}
    Service unavailable.
  {/if}
</main>

<style>
  :global(body) { margin: 0; }
  main { min-height: 100vh; box-sizing: border-box; padding: var(--drive-space-4); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  a { color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
