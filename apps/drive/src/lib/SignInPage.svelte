<script lang="ts">
  import './tokens.css';
  import SignInCard from './SignInCard.svelte';
  import type { SignInState } from './sign-in-state';
  import qerithSans from './fonts/QerithSans-latin.woff2?url';

  export let title = 'Sign in';
  export let state: SignInState = 'sign-in';
  export let onSignIn: (() => void) | undefined = undefined;
  export let onCancel: (() => void) | undefined = undefined;
</script>

<svelte:head>
  <title>{title} · Drive</title>
  <link rel="preload" href={qerithSans} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

<main>
  <div class="rail">
    <header>
      <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false"><path fill-rule="evenodd" d="M3 7a2 2 0 0 1 2-2h4.59a2 2 0 0 1 1.42.59L12.91 7.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zm4 6.25v1.5h10v-1.5z"/></svg>
      <span>Drive</span>
    </header>
    <slot>
      {#if onSignIn && onCancel}<SignInCard {state} {onSignIn} {onCancel} />{/if}
    </slot>
  </div>
</main>

<style>
  @font-face {
    font-family: 'Qerith Sans';
    src: url('./fonts/QerithSans-latin.woff2') format('woff2');
    font-weight: 200 900;
    font-stretch: 75% 125%;
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face {
    font-family: 'Fragment Mono';
    src: url('./fonts/FragmentMono-Regular-latin.woff2') format('woff2');
    font-weight: 400;
    font-display: optional;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  main {
    min-height: 100vh;
    box-sizing: border-box;
    padding: var(--drive-space-6) var(--drive-space-4);
    background: var(--drive-color-bg-canvas);
    color: var(--drive-color-text-primary);
    font-family: var(--drive-font-ui);
  }
  .rail { max-width: var(--drive-layout-rail-max); margin: 0 auto; }
  header { display: flex; align-items: center; gap: var(--drive-space-2); margin-bottom: var(--drive-space-6); font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); }
</style>
