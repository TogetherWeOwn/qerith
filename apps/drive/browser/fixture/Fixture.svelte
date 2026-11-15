<script>
  import SignInPage from '../../src/lib/SignInPage.svelte';

  let requests = $state(0);
  let cancellations = $state(0);
  const signInState = new URLSearchParams(window.location.search).get('state') || 'sign-in';
</script>

<SignInPage state={signInState} onSignIn={() => requests++} onCancel={() => cancellations++} />
<output hidden data-requests={requests} data-cancellations={cancellations}></output>
