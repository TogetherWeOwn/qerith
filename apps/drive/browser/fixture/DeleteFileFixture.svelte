<script lang="ts">
  import { flushSync } from 'svelte';
  import '../../src/lib/tokens.css';
  import '../../src/lib/dialog.css';

  // Synthetic owned files only. This fixture is not an app route or an admission check.
  const file = (number: number, name: string) => ({ id: `00000000-0000-4000-8000-00000000000${number}`, name });
  let files = $state([file(1, 'Receipts.pdf'), file(2, 'Statement.pdf'), file(3, '税'.repeat(80) + '.pdf')]);
  let target = $state<(typeof files)[number]>();
  let pending = $state(false), error = $state(''), accepted = $state('');
  let dialog: HTMLDialogElement, close: HTMLButtonElement, cancel: HTMLButtonElement;
  let heading: HTMLHeadingElement, opener: HTMLButtonElement;
  let notice = $state<HTMLParagraphElement>();
  let backdrop = false;
  const uncertain = 'We couldn’t confirm the deletion request. Check My Drive before trying again.';

  function open(entry: (typeof files)[number], trigger: HTMLButtonElement) {
    opener = trigger;
    backdrop = false;
    flushSync(() => { target = entry; error = ''; });
    dialog.showModal();
  }

  function dismiss() {
    if (pending) return;
    dialog.close();
    opener.focus();
  }

  function keys(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const [from, to] = event.shiftKey ? [close, cancel] : [cancel, close];
    if (document.activeElement === from) { event.preventDefault(); to.focus(); }
  }

  async function confirm() {
    if (pending || !target || !dialog.open) return;
    const { id, name } = target;
    pending = true;
    error = '';
    let status: number | undefined;
    try {
      // In the isolated browser harness this request is intercepted, never sent to a Worker.
      const response = await fetch(`/api/entries/${id}/delete`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit',
        body: '{"confirm":"permanent-delete"}', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
    } catch { /* The journal may have committed without a response. */ }

    if (status === 202) {
      const index = files.findIndex(entry => entry.id === id);
      const neighbor = files[index + 1] ?? files[index - 1];
      dialog.close();
      flushSync(() => {
        files = files.filter(entry => entry.id !== id);
        accepted = `Deletion request accepted for “${name}”.`;
        pending = false;
      });
      (document.getElementById(`name-${neighbor?.id}`) ?? heading).focus();
      return;
    }
    flushSync(() => {
      pending = false;
      error = status === 401 ? 'Sign in again before deleting this file.' :
        status === 403 || status === 404 ? 'That file isn’t available to delete. Refresh My Drive.' :
        status === 400 ? 'The deletion request was rejected.' : uncertain;
    });
    notice?.focus();
  }
</script>

<svelte:head><title>Permanent deletion fixture · Drive</title></svelte:head>
<main>
  <h1 tabindex="-1" bind:this={heading}>My Drive</h1>
  <p>Test fixture · owned files only</p>
  <p role="status">{accepted}</p>
  {#if files.length}
    <ul>
      {#each files as entry (entry.id)}
        <li>
          <span dir="auto" id={`name-${entry.id}`} tabindex="-1">{entry.name}</span>
          <button type="button" aria-label={`Delete ${entry.name}`} onclick={event => open(entry, event.currentTarget)}>Delete…</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p>No files.</p>
  {/if}
</main>

<dialog class="drive-dialog" bind:this={dialog} aria-labelledby="delete-title" aria-describedby="delete-warning"
  closedby={pending ? 'none' : 'closerequest'} onkeydown={keys}
  oncancel={event => { event.preventDefault(); dismiss(); }}
  onpointerdown={event => { backdrop = event.target === dialog; }}
  onclick={event => { if (backdrop && event.target === dialog) dismiss(); }}>
  <div class="panel">
    <header>
      <h2 id="delete-title">Delete “<bdi>{target?.name}</bdi>”?</h2>
      <button type="button" class="close" aria-label="Close" aria-disabled={pending} bind:this={close} onclick={dismiss}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <p id="delete-warning">This deletes the file for good. There's no bin, so it can't be restored.</p>
    {#if error}<p class="notice" role="alert" tabindex="-1" bind:this={notice}>{error}</p>{/if}
    <span class="sr-only" role="status">{pending ? 'Deleting…' : ''}</span>
    <footer>
      <button type="button" class="danger" aria-disabled={pending} aria-busy={pending} onclick={confirm}>
        <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 4h10M6 4V2h4v2m2 0-.5 10h-7L4 4m2 2v6m4-6v6"/></svg>
        {pending ? 'Deleting…' : 'Delete permanently'}
      </button>
      <!-- svelte-ignore a11y_autofocus (K10 safe initial focus after the user opens the modal) -->
      <button type="button" autofocus aria-disabled={pending} bind:this={cancel} onclick={dismiss}>Cancel</button>
    </footer>
  </div>
</dialog>

<style>
  :global(body) { margin: 0; background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  main { max-width: 56rem; margin: auto; padding: var(--drive-space-inset-card); }
  ul { list-style: none; padding: 0; }
  li, header, footer { display: flex; align-items: center; gap: var(--drive-space-2); }
  li, header { justify-content: space-between; }
  li { border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  footer { justify-content: flex-end; }
  p { margin: 0; }
  :is(h2, p, li span) { min-width: 0; overflow-wrap: anywhere; }
  .sr-only { position: absolute; clip-path: inset(50%); }
  button { display: inline-flex; align-items: center; justify-content: center; gap: var(--drive-space-2); flex: none; min-height: var(--drive-size-control-md); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-secondary); font: inherit; font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button.danger { color: var(--drive-color-state-danger); }
  button:not([aria-disabled='true']):hover, button[aria-disabled='true'] { background: var(--drive-color-bg-raised); }
  button[aria-disabled='true'] { color: var(--drive-color-text-secondary); cursor: default; }
  .close { padding: 0; min-width: var(--drive-size-control-md); }
  svg { width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  :is(button, [tabindex='-1']):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { footer { flex-direction: column; align-items: stretch; } }
</style>
