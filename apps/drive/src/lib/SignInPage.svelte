<script lang="ts">
  import PasskeyPage from './PasskeyPage.svelte';
  import SignInCard from './SignInCard.svelte';
  import type { SignInState } from './sign-in-state';

  export let state: SignInState = 'sign-in';
  export let onSignIn: () => void;
  export let onCancel: () => void;
</script>

<PasskeyPage title="Sign in">
  <SignInCard {state} {onSignIn} {onCancel} />
</PasskeyPage>
