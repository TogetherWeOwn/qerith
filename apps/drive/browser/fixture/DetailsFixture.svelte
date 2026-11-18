<script>
  import FileDetails from '../../src/lib/FileDetails.svelte';

  let { variant } = $props();
  let open = $state(true);
  const facts = {
    full: {
      name: '  تقرير  ' + 'a'.repeat(180) + '.pdf  ',
      size: '5.4 GB',
      bytes: 5368709120,
      kind: 'PDF',
      modifiedFull: '14 Nov 2026, 09:00 UTC',
      uploaded: '12 Nov 2026, 09:00 UTC',
      sharedWith: ['Mora', 'Sam']
    },
    missing: { name: ' \t ', size: '—', bytes: null, kind: 'Folder' },
    zero: { name: 'Empty.txt', size: '0 bytes', bytes: 0, kind: 'File', sharedWith: [] },
    one: { name: 'Tiny.txt', size: '1 byte', bytes: 1, kind: 'File' }
  };
</script>

{#if open}
  <FileDetails id="sample" {...facts[variant]} onClose={() => { open = false; }} />
{/if}
