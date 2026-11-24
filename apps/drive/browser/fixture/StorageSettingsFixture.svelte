<script>
  import StorageSettings from '../../src/lib/StorageSettings.svelte';
  import { createAnnouncer, setAnnouncer } from '../../src/lib/announcements';

  let status = $state(''), error = $state('');
  setAnnouncer(createAnnouncer((polite, assertive) => {
    status = polite;
    error = assertive;
  }, () => false));
</script>

<StorageSettings />
<div role="status">{status}</div>
<div aria-live="assertive">{error}</div>

<style>
  div { position: absolute; clip-path: inset(50%); }
</style>
