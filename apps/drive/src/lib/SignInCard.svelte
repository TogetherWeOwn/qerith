<script lang="ts">
  import { beforeUpdate, afterUpdate } from 'svelte';
  import { canSignIn, requestSignIn, signInCopy, type SignInState } from './sign-in-state';

  let cancel: HTMLButtonElement;
  let primary: HTMLButtonElement;
  let title: HTMLHeadingElement;
  let restoreFocus = false;
  beforeUpdate(() => { restoreFocus = typeof document !== 'undefined' && state !== 'waiting' && document.activeElement === cancel; });
  afterUpdate(() => { if (restoreFocus) (primary || title).focus(); });

  export let state: SignInState = 'sign-in';
  export let onSignIn: () => void;
  export let onCancel: () => void;

  $: copy = signInCopy[state];
  $: unavailable = !canSignIn(state);
</script>

<section aria-labelledby="sign-in-title">
  <h1 id="sign-in-title" tabindex="-1" bind:this={title}>{copy.title}</h1>
  <p>{copy.body}</p>
  {#if copy.action}
    <button
      bind:this={primary}
      class:quiet={state === 'rate-limited' || state === 'unsupported'}
      type="button"
      aria-disabled={unavailable}
      aria-busy={state === 'waiting'}
      on:click={() => requestSignIn(state, onSignIn)}
    >{#if state !== 'waiting' && state !== 'rate-limited'}<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 1 1-2 2-1-1-3 3"/></svg>{/if}{copy.action}</button>
  {/if}
  <p class:notice={state === 'waiting' || state === 'unsupported' || state === 'rate-limited'} class:warn={state === 'unsupported'} role="status" aria-live="polite">{state === 'waiting' || state === 'unsupported' || state === 'rate-limited' ? copy.notice : ''}</p>
  {#if copy.notice && (state === 'cancelled' || state === 'no-passkey')}
    <p class="notice" role="alert">{copy.notice}</p>
  {/if}
  {#if state === 'waiting'}
    <button bind:this={cancel} class="cancel" type="button" on:click={onCancel}>Cancel</button>
  {/if}
  {#if state !== 'revoked'}
    <p class="explanation"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>No passwords. Your passkey stays on your device or password manager.</p>
  {/if}
</section>

<style>
  section {
    --drive-color-bg-surface: #1c1614;
    --drive-color-bg-raised: #241c19;
    --drive-color-line-hairline-strong: rgba(255, 236, 220, 0.14);
    --drive-color-text-primary: #f6f1ea;
    --drive-color-text-secondary: #d2c7bd;
    --drive-color-text-tertiary: #a89a8e;
    --drive-color-text-on-accent: #1d0b00;
    --drive-color-accent-default: #ff9c36;
    --drive-color-accent-hover: #ffaa47;
    --drive-radius-l: 16px;
    --drive-radius-m: 10px;
    --drive-radius-pill: 999px;
    --drive-space-inset-card-lg: 28px;
    --drive-space-4: 16px;
    --drive-font-size-h3: clamp(22px, 2vw, 26px);
    --drive-font-size-body: 16px;
    --drive-font-size-small: 14px;
    --drive-font-size-ui: 15px;
    --drive-size-control-md: 44px;
    --drive-layout-rail-max: 420px;
    box-sizing: border-box;
    max-width: var(--drive-layout-rail-max);
    padding: var(--drive-space-inset-card-lg);
    color: var(--drive-color-text-primary);
    background: var(--drive-color-bg-surface);
    border: 1px solid var(--drive-color-line-hairline-strong);
    border-radius: var(--drive-radius-l);
  }
  h1 { font-size: var(--drive-font-size-h3); line-height: 1.1; font-weight: 560; letter-spacing: -0.025em; text-wrap: balance; }
  p { font-size: var(--drive-font-size-body); line-height: 1.55; color: var(--drive-color-text-secondary); }
  button { width: 100%; min-height: var(--drive-size-control-md); border: 0; border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font: inherit; font-size: var(--drive-font-size-ui); font-weight: 600; cursor: pointer; }
  button:not(.cancel):not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button:focus-visible { outline: 2px solid var(--drive-color-accent-default); outline-offset: 3px; }
  button.quiet { background: var(--drive-color-bg-raised); color: var(--drive-color-text-tertiary); }
  button.cancel { width: auto; background: transparent; color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-small); text-decoration: underline; }
  p[role='status']:empty { margin: 0; }
  .notice { padding: var(--drive-space-4); border: 1px solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); color: var(--drive-color-text-primary); font-size: var(--drive-font-size-ui); }
  .notice.warn { background: #2e2410; }
  svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  button svg { vertical-align: middle; margin-right: 8px; }
  .explanation { display: flex; gap: 8px; font-size: var(--drive-font-size-small); }
</style>
