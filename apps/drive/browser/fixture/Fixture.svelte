<script>
  import SignInPage from '../../src/lib/SignInPage.svelte';
  import EmptyFolder from '../../src/lib/EmptyFolder.svelte';
  import FileList from '../../src/lib/FileList.svelte';

  const listing = new URLSearchParams(window.location.search).has('listing');
  const items = [
    { id: '1', name: 'Archive', href: '#archive', kind: 'Folder', size: '—', modified: '14 Nov', shared: true },
    { id: '3', name: 'a-very-long-file-name-without-breaks-to-check-reflow.txt', href: '#long', kind: 'File', size: '1 KB', modified: '12 Nov', shared: false },
    { id: '2', name: 'Résumé 2025.pdf', href: '#resume', kind: 'PDF', size: '5.4 MB', modified: '13 Nov', shared: false }
  ];
  const empty = new URLSearchParams(window.location.search).get('empty');
  let uploads = $state(0);

  let requests = $state(0);
  let cancellations = $state(0);
  let signInState = $state(new URLSearchParams(window.location.search).get('state') || 'sign-in');
  window.addEventListener('fixture-wait', () => { signInState = 'waiting'; });
  window.addEventListener('fixture-state', event => { signInState = event.detail; });
</script>

{#if listing}
  <main><FileList folder="My Drive" {items} /></main>
{:else if empty}
  <main><EmptyFolder root={empty === 'root'} onUpload={() => uploads++} /></main>
{:else}
  <SignInPage state={signInState} onSignIn={() => requests++} onCancel={() => cancellations++} />
{/if}
<output hidden data-requests={requests} data-cancellations={cancellations} data-uploads={uploads}></output>

<style>
  main { min-height: 100vh; background: var(--drive-color-bg-canvas); }
</style>
