<script lang="ts" module>
  export type InviteAcceptanceView =
    | { kind: 'invite'; inviter?: string; displayName?: string; note?: string }
    | { kind: 'dead-link' }
    | { kind: 'unavailable' }
    | { kind: 'signed-in'; signedInName?: string };
  export type InvitePasskeyPhase = 'valid' | 'waiting' | 'cancelled' | 'unsupported' | 'rate-limited';
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import SignInPage from './SignInPage.svelte';
  import { signInCopy } from './sign-in-state';

  // The caller resolves the link and owns the ceremony and navigation.
  export let view: InviteAcceptanceView | undefined;
  export let phase: InvitePasskeyPhase = 'valid';
  // Return a promise while preparing the ceremony, or set the waiting phase synchronously.
  export let onSetup: (displayName: string) => void | Promise<void>;
  export let onCancel: () => void;
  export let cancellable = true;

  let heading: HTMLHeadingElement;
  let card: HTMLElement;
  let field: HTMLInputElement;
  let primary: HTMLButtonElement;
  type ViewKind = InviteAcceptanceView['kind'] | 'loading';
  let kind: ViewKind;
  let rendered: ViewKind | undefined;
  let previousPhase: InvitePasskeyPhase | undefined;
  let announcement = '';
  let nameError = '';
  let ready = false;
  let pending: symbol | undefined;
  const titles = {
    loading: 'Accept invite',
    invite: "You're invited to Drive",
    'dead-link': "This link doesn't work any more",
    unavailable: 'Drive unavailable',
    'signed-in': "You're signed in",
  };
  $: kind = view?.kind ?? 'loading';
  $: invite = view?.kind === 'invite' ? view : null;
  // The preparation latch lasts only until the caller changes the view kind or phase.
  $: { kind; phase; pending = undefined; }
  $: shown = pending ? 'waiting' : phase;
  $: saving = shown === 'waiting' && !cancellable;
  $: status = !invite ? undefined : saving ? 'Saving your passkey…' :
    shown === 'waiting' || shown === 'unsupported' || shown === 'rate-limited' ? signInCopy[shown].notice : undefined;
  $: unavailable = shown !== 'valid' && shown !== 'cancelled';
  $: updateFocus(kind, shown);

  onMount(() => { ready = true; });

  async function updateFocus(kind: ViewKind, nextPhase: InvitePasskeyPhase) {
    if (kind === rendered && nextPhase === previousPhase) return;
    // Capture focus once, before a view or phase change can remove its control.
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const focused = card?.contains(active) ? active : null;
    announcement = kind !== rendered && (rendered === 'loading' || (rendered === 'invite' && !focused))
      ? titles[kind] : '';
    if (kind !== rendered) {
      rendered = kind;
      nameError = '';
    }
    previousPhase = nextPhase;
    if (!focused || kind === 'loading') return;
    await tick();
    if (card?.isConnected && !card.contains(focused) && document.activeElement === document.body) {
      (view?.kind === 'invite' ? primary : heading)?.focus();
    }
  }

  async function setup() {
    if (!ready || pending || unavailable || !invite) return;
    const displayName = field.value.trim();
    nameError = !displayName ? 'Type a name.' : Array.from(displayName).length > 64 ? 'Use 64 characters or fewer.' : '';
    if (nameError) { field.focus(); return; }
    const attempt = Symbol();
    pending = attempt;
    try { await onSetup(displayName); }
    finally { if (pending === attempt) pending = undefined; }
  }

  function cancelSetup() {
    if (!cancellable) return;
    pending = undefined;
    onCancel();
  }
</script>

<SignInPage title="Accept invite">
  <section class:resolved={!!view} aria-labelledby="invite-title" bind:this={card}>
    <h1 id="invite-title" tabindex="-1" aria-describedby={view && !invite ? 'invite-description' : undefined} bind:this={heading}>
      {#if view?.kind === 'signed-in' && view.signedInName}{titles[kind]}{' as '}<bdi>{view.signedInName}</bdi>
      {:else if invite?.inviter}<bdi>{invite.inviter}</bdi> invited you to Drive
      {:else}{titles[kind]}{/if}
    </h1>
    <!-- Keep the live region in the DOM while the invite resolves. -->
    <p class:sr-only={!!view} role="status" aria-live="polite" aria-atomic="true">{view ? status ?? announcement : 'Checking the invite…'}</p>
    {#if !view}
      <noscript>Turn on JavaScript to set up a passkey.</noscript>
    {:else if view.kind === 'dead-link'}
      <p id="invite-description">Invite and sign-in links work once and expire after 7 days. Ask the owner for a new one.</p>
    {:else if view.kind === 'unavailable'}
      <p id="invite-description">Try signing in if you saved a passkey. Otherwise, open the invite again and try again.</p>
      <a class="ghost" data-sveltekit-reload href="/sign-in">Sign in</a>
    {:else if view.kind === 'signed-in'}
      <p id="invite-description">This invite is for someone else, so it wasn't used.</p>
      <a class="ghost" href="/">Go to My Drive</a>
    {:else}
      {#if view.note}<blockquote dir="auto">{view.note}</blockquote>{/if}
      <form method="post" novalidate on:submit|preventDefault={setup}>
        <label for="invite-name">Your name</label>
        <input id="invite-name" type="text" dir="auto" autocomplete="name" required
          readonly={shown === 'waiting'} bind:this={field} value={view.displayName ?? ''} on:input={() => { nameError = ''; }}
          aria-invalid={nameError ? 'true' : undefined} aria-describedby={nameError ? 'invite-name-error' : undefined} />
        <p id="invite-name-error" class="error" role="alert">{nameError}</p>
        <button class="primary" class:quiet={shown === 'unsupported' || shown === 'rate-limited'} type="submit"
          bind:this={primary} disabled={!ready} aria-disabled={unavailable} aria-busy={shown === 'waiting'}
          aria-describedby={status ? 'invite-status' : undefined}>
          {saving ? status : shown === 'waiting' || shown === 'rate-limited' ? signInCopy[shown].action : 'Set up a passkey'}
        </button>
        <p id="invite-status" class:notice={shown === 'unsupported'}>{status ?? ''}</p>
        {#if shown === 'waiting'}<button class="cancel" type="button" aria-disabled={!cancellable} on:click={cancelSetup}>Cancel</button>{/if}
        {#if shown === 'cancelled'}<p class="notice info" role="alert">{signInCopy.cancelled.notice}</p>{/if}
      </form>
      <p class="explanation">Your device asks to save a passkey for this site. That's how you sign in from now on.</p>
      <p class="explanation lock"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>No passwords. Your passkey stays on your device or password manager.</p>
    {/if}
  </section>
</SignInPage>

<style>
  .resolved { padding: var(--drive-space-inset-card-lg); background: var(--drive-color-bg-surface); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-l); overflow-wrap: anywhere; }
  :where(.resolved) h1 { font-size: var(--drive-font-size-h3); line-height: var(--drive-line-height-heading); font-weight: var(--drive-font-weight-display); font-stretch: var(--drive-font-width-display); letter-spacing: var(--drive-tracking-h3); text-wrap: balance; }
  :where(.resolved) p, blockquote { font-size: var(--drive-font-size-body); line-height: var(--drive-line-height-body); color: var(--drive-color-text-secondary); }
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
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .explanation { font-size: var(--drive-font-size-small); }
  .lock { display: flex; gap: var(--drive-space-2); }
  svg { width: var(--drive-size-icon-md); height: var(--drive-size-icon-md); fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; flex: none; }
</style>
