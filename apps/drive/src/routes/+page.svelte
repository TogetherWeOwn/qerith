<script lang="ts">
  import { untrack } from 'svelte';
  import DriveNav from '../lib/DriveNav.svelte';
  import RootListingView from '../lib/RootListingView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // The document consumes the notice; listing invalidation must not dismiss it.
  const downloadNotice = untrack(() => data.downloadNotice);
</script>

<svelte:head>
  <title>{data.listing ? 'My Drive' : 'Drive'}</title>
</svelte:head>

{#if data.ownerInvites || data.sharedListing}
  <DriveNav current="home" owner={data.ownerInvites} shared={data.sharedListing} />
{/if}
<main id="main" class:owner={data.ownerInvites || data.sharedListing} tabindex="-1">
  {#if downloadNotice}
    <div role="alert">
      <p>{`${downloadNotice.name ?? 'The file'} didn’t download.${data.staging ? '' : ' Try again.'}`}</p>
      {#if downloadNotice.id}
        <a data-sveltekit-reload href={`/api/download/${downloadNotice.id}`}>{data.staging ? 'Retry download' : 'Try again'}</a>
      {/if}
    </div>
  {/if}
  {#if data.listing}
    <RootListingView result={data.listing} page={data.page} uploadMode={data.uploadMode}
      staging={data.staging} downloadAllowed={data.downloadAllowed} metadataWriteAllowed={data.metadataWriteAllowed} folderLinks={data.folderLinks} />
  {:else}
    Service unavailable.
  {/if}
</main>

<style>
  :global(body) { margin: 0; }
  main { min-height: 100vh; box-sizing: border-box; padding: var(--drive-space-4); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  main.owner { max-width: var(--drive-layout-container); margin-inline: auto; padding-inline: var(--drive-layout-gutter-wide); }
  @media (max-width: 820px) { main.owner { padding-inline: var(--drive-layout-gutter-compact); } }
  a { color: inherit; }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
