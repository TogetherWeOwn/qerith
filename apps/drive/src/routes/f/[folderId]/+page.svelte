<script lang="ts">
  import type { PageData } from './$types';
  import FolderView from '../../../lib/FolderView.svelte';

  export let data: PageData;
</script>

<svelte:head><title>{data.result.status === 'ok' ? `${data.result.folder.name} · Drive` : 'Folder unavailable · Drive'}</title></svelte:head>
<FolderView result={data.result} />
