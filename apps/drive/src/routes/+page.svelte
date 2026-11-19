<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Drive</title>
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
  Service unavailable.
</main>
