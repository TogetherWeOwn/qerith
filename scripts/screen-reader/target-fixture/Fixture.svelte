<script>
  import SignInPage from './source/apps/drive/src/lib/SignInPage.svelte';

  // These callbacks simulate presentation states; they never authenticate.
  let state = 'sign-in';
  function signIn() { state = 'waiting'; }
  function cancel() { state = 'cancelled'; }
</script>

<SignInPage {state} onSignIn={signIn} onCancel={cancel} />
