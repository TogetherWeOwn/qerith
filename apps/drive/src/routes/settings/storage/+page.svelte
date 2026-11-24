<script lang="ts">
  import StorageSettings from '../../../lib/StorageSettings.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Storage settings · Drive</title></svelte:head>
<StorageSettings ownerInvites={data.ownerInvites} />
