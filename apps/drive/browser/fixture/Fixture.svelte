<script>
  import SignInPage from '../../src/lib/SignInPage.svelte';

  let requests = $state(0);
  let cancellations = $state(0);
  let signInState = $state(new URLSearchParams(window.location.search).get('state') || 'sign-in');
  window.addEventListener('fixture-wait', () => { signInState = 'waiting'; });
  window.addEventListener('fixture-state', event => { signInState = event.detail; });
</script>

<SignInPage state={signInState} onSignIn={() => requests++} onCancel={() => cancellations++} />
<output hidden data-requests={requests} data-cancellations={cancellations}></output>
