<script lang="ts">
  import { tick } from 'svelte';
  import { entryId } from './download-id';
  import { validateName } from './entry-name';
  import './dialog.css';

  let { available, items, oncreated }: {
    available: boolean;
    items: { name: string; kind: string }[];
    oncreated: (id: string, name: string, close: () => void) => Promise<void>;
  } = $props();
  const id = $props.id();
  let dialog: HTMLDialogElement, field: HTMLInputElement;
  let first: HTMLButtonElement, last: HTMLButtonElement;
  let opener = $state<HTMLButtonElement>(), notice = $state<HTMLParagraphElement>();
  let backdrop = false;
  let name = $state(''), checking = $state(false), pending = $state(false);
  let clash = $state(''), failure = $state('');
  const invalid = $derived(checking ? nameError(name) || clash : '');

  function nameError(value: string) {
    try { validateName(value); return ''; } catch {
      if (!value) return 'Type a name.';
      if (/^[ .]+$|\//.test(value)) return 'Names can\'t contain "/" or be only dots or spaces.';
      if (new TextEncoder().encode(value).length > 255) return 'That name is too long. Shorten it and try again.';
      return 'Remove unsupported characters and try again.';
    }
  }

  function open() {
    name = clash = failure = ''; checking = false;
    dialog.showModal(); field.focus();
  }
  function close() {
    dialog?.close(); opener?.focus();
  }
  function dismiss() { if (!pending) close(); }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape' && pending) event.preventDefault();
    if (event.key !== 'Tab') return;
    const [from, to] = event.shiftKey ? [first, last] : [last, first];
    if (document.activeElement === from) { event.preventDefault(); to.focus(); }
  }

  async function makeFolder(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    checking = true; failure = '';
    if (invalid) { await tick(); field.focus(); return; }
    pending = true;
    const submitted = name;
    const unknown = 'We couldn’t confirm the folder was created. Check My Drive before trying again.';
    let created: string | undefined;
    try {
      const response = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ name: submitted, parentId: null }),
      });
      if (response.status === 201) {
        const folder = await response.json();
        if (typeof folder?.id === 'string' && entryId.test(folder.id) && folder.kind === 'folder' &&
            folder.parentId === null && folder.name === submitted) created = folder.id;
        else failure = unknown;
      } else if (response.status === 409) {
        // The empty 409 doesn't expose the conflicting entry's kind. Only name a kind we can already see.
        const kind = items.find(item => item.name === submitted)?.kind.toLowerCase();
        clash = `There's already ${kind ? `a ${kind}` : 'an item'} called "${submitted}" here. Pick another name.`;
      } else if (response.status === 400) failure = 'Check the folder name and try again.';
      else if (response.status === 401) failure = 'Sign in again before making a folder.';
      else if (response.status === 403 || response.status === 404) failure = 'You can’t make a folder here. Refresh My Drive.';
      else failure = unknown;
    } catch { failure = unknown; }

    try { if (created) await oncreated(created, submitted, close); }
    finally { pending = false; }
    if (!created) { await tick(); (clash ? field : notice)?.focus(); }
  }
</script>

{#if available}<button class="new-folder" type="button" bind:this={opener} onclick={open}>New folder</button>{/if}
<dialog class="drive-dialog" bind:this={dialog} aria-labelledby={`${id}-title`} closedby={pending ? 'none' : 'closerequest'}
  onkeydown={keys} oncancel={event => { event.preventDefault(); dismiss(); }}
  onpointerdown={event => { backdrop = event.target === dialog; }}
  onclick={event => { if (backdrop && event.target === dialog) dismiss(); }}>
  <form class="panel" onsubmit={makeFolder} autocomplete="off">
    <header>
      <h2 id={`${id}-title`}>New folder in My Drive</h2>
      <button class="close" type="button" aria-label="Close" aria-disabled={pending} bind:this={first} onclick={dismiss}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    <p class="status" role="status">{pending ? 'Making folder…' : ''}</p>
    {#if failure}<p class="notice" role="alert" tabindex="-1" bind:this={notice}>{failure}</p>{/if}
    <div class="field">
      <label for={`${id}-name`}>Folder name</label>
      <input id={`${id}-name`} bind:this={field} bind:value={name} dir="auto" readonly={pending} oninput={() => { clash = ''; }}
        aria-invalid={!!invalid} aria-describedby={invalid ? `${id}-error` : undefined} />
      {#if invalid}<span id={`${id}-error`} role="alert" dir="auto">{invalid}</span>{/if}
    </div>
    <footer>
      <button class="primary" type="submit" aria-disabled={pending} aria-busy={pending}>{pending ? 'Making folder…' : 'Make folder'}</button>
      <button type="button" aria-disabled={pending} bind:this={last} onclick={dismiss}>Cancel</button>
    </footer>
  </form>
</dialog>

<style>
  header, footer { display: flex; align-items: center; gap: var(--drive-space-2); }
  header { justify-content: space-between; }
  footer { justify-content: flex-end; }
  p { margin: 0; overflow-wrap: anywhere; }
  .status { position: absolute; clip-path: inset(50%); }
  .field { display: grid; gap: var(--drive-space-1); font-size: var(--drive-font-size-ui); }
  .field span { color: var(--drive-color-state-danger); font-size: var(--drive-font-size-small); overflow-wrap: anywhere; }
  input { box-sizing: border-box; width: 100%; min-width: 0; min-height: var(--drive-size-control-md); padding: var(--drive-space-2) var(--drive-space-inset-room); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-m); color: inherit; background: var(--drive-color-bg-canvas); font: inherit; }
  input[aria-invalid='true'] { border-color: var(--drive-color-state-danger); }
  button { flex: none; min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-secondary); font: inherit; font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); font-stretch: var(--drive-font-width-button); cursor: pointer; }
  button.primary { min-height: var(--drive-size-control-md); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); }
  button:not(.primary):not([aria-disabled='true']):hover, button[aria-disabled='true'] { background: var(--drive-color-bg-raised); }
  button.primary:not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button[aria-disabled='true'] { color: var(--drive-color-text-secondary); cursor: default; }
  .close { padding: 0; min-width: var(--drive-size-control-sm); }
  svg { display: block; margin: auto; width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; }
  :is(input, button, .notice):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { footer { flex-direction: column; align-items: stretch; } }
</style>
