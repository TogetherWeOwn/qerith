<script>
  import SignInPage from '../../src/lib/SignInPage.svelte';
  import EmptyFolder from '../../src/lib/EmptyFolder.svelte';
  import RowActions from '../../src/lib/RowActions.svelte';

  const menuFixture = new URLSearchParams(window.location.search).get('menu');
  let firstName;
  let nextName;
  let menu;
  let selected = $state('');

  const empty = new URLSearchParams(window.location.search).get('empty');
  let uploads = $state(0);

  let requests = $state(0);
  let cancellations = $state(0);
  let signInState = $state(new URLSearchParams(window.location.search).get('state') || 'sign-in');
  window.addEventListener('fixture-wait', () => { signInState = 'waiting'; });
  window.addEventListener('fixture-state', event => { signInState = event.detail; });
</script>

{#if menuFixture}
  <main>
    <div oncontextmenu={(event) => menu.openFromContextMenu(event)} role="presentation">
      <button bind:this={firstName}>Sample file</button>
      <RowActions bind:this={menu} name="Sample file" file={menuFixture !== 'folder'} owned={menuFixture !== 'shared'} onAction={(action) => selected = action} onTab={(direction) => (direction === 'next' ? nextName : firstName).focus()} />
    </div>
    <button bind:this={nextName}>Next file</button>
    <p aria-live="polite">{selected}</p>
  </main>
{:else if empty}
  <main><EmptyFolder root={empty === 'root'} onUpload={() => uploads++} /></main>
{:else}
  <SignInPage state={signInState} onSignIn={() => requests++} onCancel={() => cancellations++} />
{/if}
<output hidden data-requests={requests} data-cancellations={cancellations} data-uploads={uploads}></output>

<style>
  main { min-height: 100vh; background: var(--drive-color-bg-canvas); }
</style>
