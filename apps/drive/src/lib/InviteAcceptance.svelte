<script lang="ts" module>
  // The caller resolves the link and owns registration, cancellation and success navigation.
  export type InviteAcceptanceState =
    | { kind: 'valid' | 'waiting' | 'cancelled' | 'unsupported' | 'rate-limited'; inviter?: string; displayName?: string; note?: string }
    | { kind: 'dead-link' }
    | { kind: 'signed-in'; signedInName: string };
</script>

<script lang="ts">
  import { afterUpdate, beforeUpdate, onMount } from 'svelte';
  import PasskeyPage from './PasskeyPage.svelte';
  import { signInCopy } from './sign-in-state';

  export let state: InviteAcceptanceState;
  export let onSetup: (displayName: string) => void;
  export let onCancel: () => void;

  let heading: HTMLHeadingElement;
  let card: HTMLElement;
  let field: HTMLInputElement;
  let primary: HTMLButtonElement;
  let cancel: HTMLButtonElement;
  let name = '';
  let nameError = '';
  let ready = false;
  let restore: 'heading' | 'primary' | undefined;
  const nameLimit = 64;
  $: invite = state.kind !== 'dead-link' && state.kind !== 'signed-in' ? state : null;
  $: prefill = invite?.displayName ?? '';
  $: { name = prefill; nameError = ''; }
  $: status = state.kind === 'waiting' || state.kind === 'unsupported' || state.kind === 'rate-limited'
    ? signInCopy[state.kind].notice : undefined;
  $: unavailable = state.kind !== 'valid' && state.kind !== 'cancelled';

  onMount(() => { ready = true; });
  beforeUpdate(() => {
    if (typeof document === 'undefined') return;
    const focused = document.activeElement;
    restore = !invite && focused !== heading && card?.contains(focused) ? 'heading'
      : state.kind !== 'waiting' && focused === cancel ? 'primary' : undefined;
  });
  afterUpdate(() => {
    if (restore === 'heading') heading.focus();
    if (restore === 'primary') primary.focus();
    restore = undefined;
  });

  function setup() {
    if (!ready || unavailable) return;
    const displayName = name.trim();
    nameError = !displayName ? 'Type a name.' : displayName.length > nameLimit ? 'Use 64 characters or fewer.' : '';
    if (nameError) field.focus();
    else onSetup(displayName);
  }
</script>

<PasskeyPage title="Accept invite">
  <section aria-labelledby="invite-title" bind:this={card}>
    <h1 id="invite-title" tabindex="-1" aria-describedby={invite ? undefined : 'invite-description'} bind:this={heading}>
      {#if state.kind === 'dead-link'}This link doesn't work any more
      {:else if state.kind === 'signed-in'}You're signed in as <bdi>{state.signedInName}</bdi>
      {:else if state.inviter}<bdi>{state.inviter}</bdi> invited you to Drive
      {:else}You're invited to Drive{/if}
    </h1>
    {#if state.kind === 'dead-link'}
      <p id="invite-description">Invite and sign-in links work once and expire after 7 days. Ask the owner for a new one.</p>
    {:else if state.kind === 'signed-in'}
      <p id="invite-description">This invite is for someone else, so it wasn't used.</p>
      <a class="ghost" href="/">Go to My Drive</a>
    {:else}
      {#if state.note}<blockquote dir="auto">{state.note}</blockquote>{/if}
      <form method="post" novalidate on:submit|preventDefault={setup}>
        <label for="invite-name">Your name</label>
        <input id="invite-name" type="text" dir="auto" autocomplete="name" required maxlength={nameLimit}
          readonly={state.kind === 'waiting'} bind:this={field} bind:value={name} on:input={() => { nameError = ''; }}
          aria-invalid={nameError ? 'true' : undefined} aria-describedby={nameError ? 'invite-name-error' : undefined} />
        <p id="invite-name-error" class="error" role="alert">{nameError}</p>
        <button class="primary" class:quiet={state.kind === 'unsupported' || state.kind === 'rate-limited'} type="submit"
          bind:this={primary} disabled={!ready} aria-disabled={unavailable} aria-busy={state.kind === 'waiting'}
          aria-describedby={unavailable ? 'invite-status' : undefined}>
          {state.kind === 'waiting' || state.kind === 'rate-limited' ? signInCopy[state.kind].action : 'Set up a passkey'}
        </button>
        <p id="invite-status" class:notice={state.kind === 'unsupported'} role="status">{status ?? ''}</p>
        {#if state.kind === 'waiting'}<button class="cancel" type="button" on:click={onCancel} bind:this={cancel}>Cancel</button>{/if}
        {#if state.kind === 'cancelled'}<p class="notice info" role="alert">{signInCopy.cancelled.notice}</p>{/if}
      </form>
      <p class="explanation">Your device asks to save a passkey for this site. That's how you sign in from now on.</p>
      <p class="explanation lock"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>No passwords. Your passkey stays on your device or password manager.</p>
    {/if}
  </section>
</PasskeyPage>

<style>
  section { padding: var(--drive-space-inset-card-lg); background: var(--drive-color-bg-surface); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-l); overflow-wrap: anywhere; }
  h1 { font-size: var(--drive-font-size-h3); line-height: var(--drive-line-height-heading); font-weight: var(--drive-font-weight-display); font-stretch: var(--drive-font-width-display); letter-spacing: var(--drive-tracking-h3); text-wrap: balance; }
  p, blockquote { font-size: var(--drive-font-size-body); line-height: var(--drive-line-height-body); color: var(--drive-color-text-secondary); }
  blockquote { margin-inline: 0; padding-inline-start: var(--drive-space-3); border-inline-start: var(--drive-size-line) solid var(--drive-color-line-control); white-space: pre-wrap; }
  label { display: block; font-size: var(--drive-font-size-ui); margin-block-end: var(--drive-space-2); }
  input, button, .ghost { box-sizing: border-box; min-height: var(--drive-size-control-md); font: inherit; font-size: var(--drive-font-size-ui); }
  input { width: 100%; border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-m); background: var(--drive-color-bg-canvas); color: inherit; padding-inline: var(--drive-space-inset-room); }
  input[aria-invalid='true'] { border-color: var(--drive-color-state-danger); }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  button, .ghost { border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); font-weight: var(--drive-font-weight-semibold); font-stretch: var(--drive-font-width-button); cursor: pointer; }
  .primary { width: 100%; margin-block-start: var(--drive-space-4); padding-inline: var(--drive-space-5); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); }
  .primary:not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  .quiet { background: var(--drive-color-bg-raised); color: var(--drive-color-text-primary); }
  .ghost { display: inline-flex; align-items: center; padding-inline: var(--drive-space-5); border-color: var(--drive-color-line-hairline-strong); color: inherit; text-decoration: none; }
  .ghost:hover { background: var(--drive-color-bg-raised); }
  .cancel { min-height: var(--drive-size-control-sm); background: transparent; padding-inline: var(--drive-space-2); color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-small); text-decoration: underline; }
  .notice { padding: var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); background: var(--drive-color-state-warn-bg); color: var(--drive-color-text-primary); font-size: var(--drive-font-size-ui); }
  .info { background: var(--drive-color-bg-surface); }
  .error { margin-block: var(--drive-space-2) 0; color: var(--drive-color-state-danger); font-size: var(--drive-font-size-small); }
  p:empty { margin: 0; }
  .explanation { font-size: var(--drive-font-size-small); }
  .lock { display: flex; gap: var(--drive-space-2); }
  svg { width: var(--drive-size-icon-md); height: var(--drive-size-icon-md); fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
</style>
