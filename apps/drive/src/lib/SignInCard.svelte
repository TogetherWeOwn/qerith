<script lang="ts">
  import { beforeUpdate, afterUpdate } from 'svelte';
  import './tokens.css';
  import { canSignIn, requestSignIn, signInCopy, type SignInState } from './sign-in-state';

  let cancel: HTMLButtonElement;
  let primary: HTMLButtonElement;
  let title: HTMLHeadingElement;
  let restoreFocus = false;
  beforeUpdate(() => { restoreFocus = typeof document !== 'undefined' && ((state !== 'waiting' && document.activeElement === cancel) || (state === 'revoked' && document.activeElement === primary)); });
  afterUpdate(() => { if (restoreFocus) (primary || title).focus(); });

  export let state: SignInState = 'sign-in';
  export let onSignIn: () => void;
  export let onCancel: () => void;

  $: copy = signInCopy[state];
  $: unavailable = !canSignIn(state);
</script>

<section aria-labelledby="sign-in-title">
  <h1 id="sign-in-title" tabindex="-1" aria-describedby={state === 'revoked' ? 'sign-in-description' : undefined} bind:this={title}>{copy.title}</h1>
  <p id="sign-in-description">{copy.body}</p>
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
    box-sizing: border-box;
    max-width: var(--drive-layout-rail-max);
    padding: var(--drive-space-inset-card-lg);
    color: var(--drive-color-text-primary);
    background: var(--drive-color-bg-surface);
    border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong);
    border-radius: var(--drive-radius-l);
  }
  h1 { font-size: var(--drive-font-size-h3); line-height: var(--drive-line-height-heading); font-weight: var(--drive-font-weight-display); letter-spacing: var(--drive-tracking-h3); text-wrap: balance; }
  p { font-size: var(--drive-font-size-body); line-height: var(--drive-line-height-body); color: var(--drive-color-text-secondary); }
  button { width: 100%; min-height: var(--drive-size-control-md); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font: inherit; font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button:not(.cancel):not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  button.quiet { background: var(--drive-color-bg-raised); color: var(--drive-color-text-tertiary); }
  button.cancel { width: auto; background: transparent; color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-small); text-decoration: underline; }
  p[role='status']:empty { margin: 0; }
  .notice { padding: var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); color: var(--drive-color-text-primary); font-size: var(--drive-font-size-ui); }
  .notice.warn { background: var(--drive-color-state-warn-bg); }
  svg { width: var(--drive-size-icon-md); height: var(--drive-size-icon-md); fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  button svg { vertical-align: middle; margin-right: var(--drive-space-2); }
  .explanation { display: flex; gap: var(--drive-space-2); font-size: var(--drive-font-size-small); }
</style>
