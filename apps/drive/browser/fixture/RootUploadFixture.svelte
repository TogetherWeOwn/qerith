<script lang="ts">
  import RootUpload from '../../src/lib/RootUpload.svelte';

  let { intentId, fetcher }: { intentId?: string; fetcher: typeof fetch } = $props();
  let busy = $state(false);
  let status = $state('');
  let refreshes = $state(0);
</script>

<svelte:head><title>Root upload fixture · Drive</title></svelte:head>
<main id="root-upload-fixture" data-refreshes={refreshes}>
  <h1>My Drive</h1>
  <RootUpload mode="multipart" fixtureResumeIntentId={intentId} fixtureFetcher={fetcher}
    announce={message => { status = message; }} refresh={async () => { refreshes += 1; }} paginated={false} bind:busy />
  <p class="status" role="status">{status}</p>
</main>

<style>
  :global(body:has(#root-upload-fixture)) { margin: 0; }
  main { display: grid; grid-template-columns: repeat(2, max-content); align-content: start; gap: var(--drive-space-3); min-height: 100dvh; box-sizing: border-box; padding: var(--drive-space-6) var(--drive-layout-gutter-wide); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  h1 { grid-column: 1 / -1; margin: 0; font-size: var(--drive-font-size-h3); font-weight: var(--drive-font-weight-display); }
  .status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 820px) { main { grid-template-columns: minmax(0, 1fr); padding-inline: var(--drive-layout-gutter-compact); } }
</style>
