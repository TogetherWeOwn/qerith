<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { onMount } from 'svelte';
  import { createAnnouncer, setAnnouncer } from '../lib/announcements';
  import type { LayoutProps } from './$types';
  import '../lib/tokens.css';

  let { children }: LayoutProps = $props();
  let polite = $state(''), assertive = $state('');
  const announcer = setAnnouncer(createAnnouncer((status, error) => {
    polite = status;
    assertive = error;
  }, () => !!document.querySelector('dialog:modal')));

  afterNavigate(({ from, to }) => {
    if (from && to && (from.url.pathname !== to.url.pathname || from.url.search !== to.url.search)) announcer.clear();
  });
  onMount(() => {
    // A native modal makes the document-level regions inert until it closes.
    document.addEventListener('close', announcer.resume, true);
    // A dialog removed during a listing refresh can return focus without a close event.
    document.addEventListener('focusin', announcer.resume);
    return () => {
      document.removeEventListener('close', announcer.resume, true);
      document.removeEventListener('focusin', announcer.resume);
      announcer.clear();
    };
  });
</script>

<svelte:window onpagehide={announcer.clear} />
{@render children()}
<div class="announcements" data-drive-announcements>
  <div role="status" aria-live="polite" aria-atomic="true">{polite}</div>
  <div aria-live="assertive" aria-atomic="true">{assertive}</div>
</div>

<style>
  .announcements { position: absolute; inset-block-start: 0; inset-inline-start: 0; inline-size: var(--drive-size-line); block-size: var(--drive-size-line); overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
