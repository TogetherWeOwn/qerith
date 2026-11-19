<script lang="ts">
  import { onMount } from 'svelte';
  import SignInPage from '../../lib/SignInPage.svelte';
  import { passkeyBrowser, signInWithPasskey } from '../../lib/passkey-sign-in';
  import type { SignInState } from '../../lib/sign-in-state';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  let state: SignInState = $state('sign-in');
  let browser: ReturnType<typeof passkeyBrowser>;
  let attempt: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    browser = passkeyBrowser();
    if (!browser) state = 'unsupported';
    return () => { attempt?.abort(); attempt = undefined; clearTimeout(retry); };
  });

  async function signIn() {
    if (!browser || attempt) return;
    const current = attempt = new AbortController();
    state = 'waiting';
    const outcome = await signInWithPasskey(browser, current.signal);
    if (attempt !== current) return;
    attempt = undefined;
    if (outcome === 'signed-in') {
      // Keep per-tab state, including any interrupted uploads. Do not clear storage.
      window.location.replace(data.next);
      return;
    }
    state = outcome;
    if (outcome === 'rate-limited') retry = setTimeout(() => { state = 'sign-in'; }, 60_000);
  }
</script>

<SignInPage {state} onSignIn={signIn} onCancel={() => attempt?.abort()} />
