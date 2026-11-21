<script lang="ts">
  import './dialog.css';
  import { onDestroy, tick } from 'svelte';
  import './tokens.css';

  type Metadata = { displayName: string | null; note: string | null };
  // Return not-issued only when the caller knows no invitation was made.
  type Issuance = { token: string; expiresAt: number } | { kind: 'not-issued' };
  let { onIssue }: { onIssue: (metadata: Metadata) => Promise<Issuance> } = $props();
  const id = $props.id();
  const expiryDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  let opener: HTMLButtonElement, dialog: HTMLDialogElement, closeButton: HTMLButtonElement, lastButton: HTMLButtonElement;
  let nameField = $state<HTMLInputElement>(), noteField = $state<HTMLTextAreaElement>();
  let linkField = $state<HTMLInputElement>(), copyButton = $state<HTMLButtonElement>();
  let name = $state(''), note = $state('');
  let phase = $state<'editing' | 'saving' | 'uncertain' | 'issued'>('editing');
  let error = $state(''), invalid = $state<'name' | 'note' | null>(null);
  let url = $state(''), expires = $state('');
  let copyState = $state<'idle' | 'copying' | 'copied' | 'refused'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, beganOnBackdrop = false, unconfirmed = false;
  const current = (attempt: number) => attempt === generation && dialog.open;
  const unconfirmedMessage = "The invite may have been made, but no link was received. Close this dialog without making another link.";

  function reset() {
    ++generation;
    clearTimeout(timer);
    name = note = error = url = expires = '';
    invalid = null;
    phase = unconfirmed ? 'uncertain' : 'editing';
    if (unconfirmed) error = unconfirmedMessage;
    copyState = 'idle';
    beganOnBackdrop = false;
  }

  function dismiss(force = false) {
    if (!dialog.open || (!force && phase === 'saving')) return;
    if (phase === 'saving') unconfirmed = true;
    // Clear the live field as well as state before a page can enter the back/forward cache.
    if (linkField) linkField.value = '';
    dialog.close();
    reset();
    if (!force) opener.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && phase === 'saving') event.preventDefault(); // Fallback for browsers without closedby.
    if (event.key !== 'Tab') return;
    const [from, to] = event.shiftKey ? [closeButton, lastButton] : [lastButton, closeButton];
    if (document.activeElement === from) {
      event.preventDefault();
      to.focus();
    }
  }

  async function issue(event: SubmitEvent) {
    event.preventDefault();
    if (phase !== 'editing') return;
    const metadata = { displayName: name.trim() || null, note: note.trim() || null };
    for (const [key, value, limit, field] of [
      ['name', metadata.displayName, 64, nameField], ['note', metadata.note, 140, noteField]
    ] as const) {
      if (!value || (!value.includes('\0') && Array.from(value).length <= limit)) continue;
      invalid = key;
      error = value.includes('\0') ? 'Remove any null characters.' : `Use ${limit} characters or fewer.`;
      await tick();
      field?.focus();
      return;
    }
    invalid = null;
    error = '';
    phase = 'saving';
    const attempt = generation;
    try {
      const result = await onIssue(metadata);
      if (!current(attempt)) return;
      if ('kind' in result) {
        phase = 'editing';
        error = "That invite wasn't made. Try again.";
        await tick();
        if (current(attempt)) nameField?.focus();
        return;
      }
      if (!/^[\w-]{43}$/.test(result.token) || result.token.length !== 43 || !(result.expiresAt > Date.now())) throw new Error();
      expires = expiryDate.format(result.expiresAt);
      url = `${location.origin}/invite#${result.token}`;
      phase = 'issued';
    } catch {
      if (!current(attempt)) return;
      unconfirmed = true;
      phase = 'uncertain';
      error = unconfirmedMessage;
    }
    await tick();
    if (current(attempt)) (phase === 'issued' ? copyButton : lastButton)?.focus();
  }

  async function copy() {
    if (!url || copyState === 'copying' || copyState === 'copied') return;
    const attempt = generation;
    copyState = 'copying';
    try {
      await navigator.clipboard.writeText(url);
      if (!current(attempt)) return;
      copyState = 'copied';
      timer = setTimeout(() => { copyState = 'idle'; }, 2000);
    } catch {
      if (!current(attempt)) return;
      copyState = 'refused';
      linkField?.focus();
      linkField?.select();
    }
  }

  onDestroy(reset);
</script>

<svelte:window onpagehide={() => dismiss(true)} onpopstate={() => dismiss(true)} />
<button class="primary" type="button" bind:this={opener} onclick={() => { dialog.showModal(); (unconfirmed ? lastButton : nameField)?.focus(); }}>
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m4-13v6m-3-3h6"/></svg>Invite someone
</button>
<dialog class="drive-dialog" bind:this={dialog} aria-labelledby={`${id}-title`} onkeydown={handleKeydown} closedby={phase === 'saving' ? 'none' : 'closerequest'}
  oncancel={event => { event.preventDefault(); dismiss(); }}
  onpointerdown={event => { beganOnBackdrop = event.target === dialog; }}
  onclick={event => { if (beganOnBackdrop && event.target === dialog) dismiss(); }}>
  <div class="panel">
    <header>
      <h2 id={`${id}-title`}>Invite someone</h2>
      <button class="close" type="button" aria-label="Close" aria-disabled={phase === 'saving'} bind:this={closeButton} onclick={() => dismiss()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <p class="status" role="status" aria-live="polite">{phase === 'saving' ? 'Making invite link…' : copyState === 'copied' ? 'Link copied' : ''}</p>
    {#if error && !invalid}<p class="notice" role="alert">{error}</p>{/if}
    {#if phase === 'issued'}
      <div class="copy">
        <input class="link" aria-label={name.trim() ? `Invite link for ${name.trim()}` : 'Invite link'} readonly dir="ltr" value={url} bind:this={linkField} />
        <button type="button" aria-disabled={copyState === 'copying' || copyState === 'copied'} aria-describedby={`${id}-expiry`} bind:this={copyButton} onclick={copy}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{#if copyState === 'copied'}<path d="m5 12 4 4L19 6"/>{:else}<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 5V4H4v12h1"/>{/if}</svg>
          {copyState === 'copied' ? 'Copied' : 'Copy link'}
        </button>
      </div>
      {#if copyState === 'refused'}<p role="alert">Press Ctrl+C or ⌘C to copy, or press and hold the link and choose Copy.</p>{/if}
      <p id={`${id}-expiry`}>Send it to {#if name.trim()}<bdi>{name.trim()}</bdi>{:else}them{/if} yourself. It works once and expires on {expires}. You won't see this link again.</p>
    {:else if phase !== 'uncertain'}
      <form id={`${id}-form`} autocomplete="off" onsubmit={issue}>
        <div class="field">
          <label for={`${id}-name`}>Name (optional)</label>
          <input id={`${id}-name`} bind:this={nameField} bind:value={name} readonly={phase === 'saving'} aria-invalid={invalid === 'name'} aria-describedby={invalid === 'name' ? `${id}-error` : undefined} />
          {#if invalid === 'name'}<span id={`${id}-error`}>{error}</span>{/if}
        </div>
        <div class="field">
          <label for={`${id}-note`}>Note for them (optional, they'll see it)</label>
          <textarea id={`${id}-note`} rows="3" bind:this={noteField} bind:value={note} readonly={phase === 'saving'} aria-invalid={invalid === 'note'} aria-describedby={invalid === 'note' ? `${id}-error` : undefined}></textarea>
          {#if invalid === 'note'}<span id={`${id}-error`}>{error}</span>{/if}
        </div>
      </form>
    {/if}
    <footer>
      {#if phase === 'editing' || phase === 'saving'}
        <button class="primary" type="submit" form={`${id}-form`} aria-busy={phase === 'saving'} aria-disabled={phase === 'saving'}>{phase === 'saving' ? 'Making invite link…' : 'Make invite link'}</button>
      {/if}
      <button type="button" aria-disabled={phase === 'saving'} bind:this={lastButton} onclick={() => dismiss()}>{phase === 'issued' || phase === 'uncertain' ? 'Done' : 'Cancel'}</button>
    </footer>
  </div>
</dialog>

<style>
  header, footer, .copy { display: flex; align-items: center; gap: var(--drive-space-2); }
  header { justify-content: space-between; }
  footer { justify-content: flex-end; }
  p { margin: 0; color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-small); line-height: var(--drive-line-height-body); overflow-wrap: anywhere; }
  .status { position: absolute; clip-path: inset(50%); }
  form, .field { display: grid; gap: var(--drive-space-3); }
  .field { gap: var(--drive-space-1); font-size: var(--drive-font-size-ui); }
  input, textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: var(--drive-size-control-md); padding: var(--drive-space-2) var(--drive-space-inset-room); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-m); color: inherit; background: var(--drive-color-bg-canvas); font: inherit; }
  textarea { resize: vertical; }
  [aria-invalid='true'] { border-color: var(--drive-color-state-danger); }
  .field span { color: var(--drive-color-state-danger); font-size: var(--drive-font-size-small); }
  .link { font-family: var(--drive-font-data); font-size: var(--drive-font-size-small); }
  button { display: inline-flex; align-items: center; justify-content: center; gap: var(--drive-space-2); flex: none; min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-secondary); font: inherit; font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); font-stretch: var(--drive-font-width-button); cursor: pointer; }
  button.primary { min-height: var(--drive-size-control-md); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); }
  button:not(.primary):not([aria-disabled='true']):hover { background: var(--drive-color-bg-raised); }
  button.primary:not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button[aria-disabled='true'] { background: var(--drive-color-bg-raised); color: var(--drive-color-text-tertiary); cursor: default; }
  .close { padding: 0; min-width: var(--drive-size-control-sm); }
  svg { width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  :is(input, textarea, button):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) {
    footer, .copy { flex-direction: column; align-items: stretch; }
    .copy button { align-self: start; }
  }
</style>
