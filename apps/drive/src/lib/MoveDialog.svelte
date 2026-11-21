<script lang="ts">
  import { flushSync, onDestroy, tick } from 'svelte';
  import KindGlyph from './KindGlyph.svelte';
  import NameDialog from './NameDialog.svelte';
  import { isLinkableFolderId } from './drive-navigation';
  import { entryChangePath } from './metadata-id';
  import type { MoveDestinations } from './server/move-destinations';
  import './dialog.css';
  type Folder = { id: string | null; name: string };
  type Entry = { id: string; name: string; kind: 'folder' | 'file' };
  let { onrootcreated, onmoved, onreturn }: {
    onrootcreated: (id: string, name: string) => Promise<void>;
    onmoved: (id: string, folder: Folder, close: () => void) => Promise<void>;
    onreturn: (id: string) => void;
  } = $props();
  const uid = $props.id();
  const root: Folder = { id: null, name: 'My Drive' };
  const gone = 'That folder was deleted. Pick another one.';
  const unknown = 'We couldn’t confirm the move. Refresh the source folder and check the selected destination before trying again.';
  const label = (name: string) => name.trim() ? name : `${name} (Whitespace-only name)`;
  let dialog: HTMLDialogElement, heading: HTMLHeadingElement, first: HTMLButtonElement, last: HTMLButtonElement;
  let notice = $state<HTMLParagraphElement>();
  let nameDialog = $state<ReturnType<typeof NameDialog>>();
  let source = $state<Entry>(), trail = $state<Folder[]>([root]), data = $state<MoveDestinations>();
  let reading = $state(false), saving = $state(false), invalidated = $state(false), uncertain = $state(false);
  let failure = $state('');
  let request: AbortController | undefined, backdrop = false;
  const folder = $derived(trail[trail.length - 1]);
  const parent = $derived(trail[trail.length - 2]);
  const alreadyHere = $derived(!!data && data.currentParentId === folder.id);
  const unavailable = $derived(!data || reading || saving || invalidated || uncertain);
  const tooDeepToCreate = $derived(trail.length > 64); // The destination listing caps ancestry at 64 folders.
  onDestroy(() => request?.abort());

  export function open(entry: Entry) {
    if (dialog.open || !entryChangePath(entry.id)) return;
    flushSync(() => { source = entry; trail = [root]; data = undefined; failure = ''; invalidated = uncertain = false; });
    dialog.showModal();
    heading.focus();
    void browse([root]);
  }

  function dismiss() {
    if (saving || !source) return;
    request?.abort();
    request = undefined;
    reading = false;
    dialog.close();
    onreturn(source.id);
  }

  function keys(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const [from, to] = event.shiftKey ? [first, last] : [last, first];
    if (document.activeElement === from) { event.preventDefault(); to.focus(); }
  }

  async function browse(path: Folder[], after?: string) {
    if (!source || reading || saving || uncertain) return;
    const destination = path[path.length - 1];
    if (destination.id !== null && (!isLinkableFolderId(destination.id) || destination.id === source.id)) return;
    const params = new URLSearchParams({ entry: source.id });
    if (destination.id !== null) params.set('folder', destination.id);
    if (after) params.set('after', after);
    const controller = new AbortController();
    request = controller;
    reading = true;
    failure = '';
    try {
      const response = await fetch(`/api/move-destinations?${params}`, {
        redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
      const next: MoveDestinations | undefined = response.ok ? await response.json() : undefined;
      if (request !== controller) return;
      if (next) {
        const folders = after ? [...(data?.folders ?? []), ...next.folders] : next.folders;
        data = { ...next, folders: [...new Map(folders.map(item => [item.id, item])).values()] };
        trail = [...path.slice(0, -1), { id: destination.id, name: next.folderName }];
        invalidated = false;
      } else if (response.status === 404 && destination.id !== null && !after) {
        if (destination.id === folder.id) invalidated = true;
        failure = gone;
      } else if (response.status === 401) failure = 'Sign in again before moving this item.';
      else failure = 'Folders didn’t load. Try again.';
    } catch { if (request === controller) failure = 'Folders didn’t load. Try again.'; }
    finally { if (request === controller) reading = false; }
    await tick();
    if (request !== controller) return;
    if (failure) notice?.focus();
    else if (!after || !data?.next) heading.focus();
  }

  async function created(id: string, name: string, close: () => void) {
    if (folder.id === null) await onrootcreated(id, name);
    close();
    await browse([...trail, { id, name }]);
  }

  async function move() {
    if (!source || unavailable || alreadyHere) return;
    const entry = source, destination = folder, path = entryChangePath(entry.id);
    if (!path) return;
    failure = '';
    saving = true;
    try {
      const response = await fetch(path, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ kind: 'move', parentId: destination.id }), signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 200) {
        const row = await response.json();
        if (row?.id !== entry.id || row.parentId !== destination.id || row.kind !== entry.kind) throw new Error('Unexpected move receipt');
        await onmoved(entry.id, destination, () => dialog.close());
      } else if (response.status === 409) {
        failure = `There's already an item called “${label(entry.name)}” in ${label(destination.name)}. Rename one of them first.`;
      } else if ([401, 403, 404].includes(response.status)) {
        invalidated = true;
        failure = response.status === 401 ? 'Sign in again before moving this item.' :
          response.status === 404 && destination.id !== null ? gone : 'This item can’t be moved. Refresh My Drive.';
      } else throw new Error('Move unconfirmed');
    } catch { uncertain = true; failure = unknown; }
    finally { saving = false; }
    if (failure) { await tick(); notice?.focus(); }
  }
</script>

<dialog class="drive-dialog" bind:this={dialog} aria-labelledby={`${uid}-title`} closedby={saving ? 'none' : 'closerequest'}
  onkeydown={keys} oncancel={event => { event.preventDefault(); dismiss(); }}
  onpointerdown={event => { backdrop = event.target === dialog; }}
  onclick={event => { if (backdrop && event.target === dialog) dismiss(); }}>
  <div class="panel">
    <header>
      <h2 id={`${uid}-title`}>Move “<bdi>{label(source?.name ?? '')}</bdi>”</h2>
      <button class="close" type="button" aria-label="Close" aria-disabled={saving} bind:this={first} onclick={dismiss}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </header>
    {#if failure}<p class="notice" role="alert" tabindex="-1" bind:this={notice} dir="auto">{failure}</p>{/if}
    <section aria-labelledby={`${uid}-path`} aria-busy={reading}>
      <h3 id={`${uid}-path`} tabindex="-1" bind:this={heading}>{#each trail as part, i}{i ? ' / ' : ''}<bdi>{label(part.name)}</bdi>{/each}</h3>
      {#if parent}
        <button type="button" aria-disabled={reading || saving || uncertain} onclick={() => browse(trail.slice(0, -1))}>Up to <bdi>{label(parent.name)}</bdi></button>
      {/if}
      {#if data && !invalidated}
        {#if data.folders.length}
          <ul role="list">
            {#each data.folders as item (item.id)}
              {@const self = item.id === source?.id}
              <li>
                <button class="folder" type="button" aria-disabled={self || reading || saving || uncertain} aria-describedby={self ? `${uid}-self` : undefined}
                  onclick={() => browse([...trail, item])}>
                  <KindGlyph kind="folder" /><bdi>{label(item.name)}</bdi><span aria-hidden="true">›</span>
                </button>
                {#if self}<p class="reason" id={`${uid}-self`}>Can't move a folder into itself</p>{/if}
              </li>
            {/each}
          </ul>
        {:else}<p>No folders in <bdi>{label(folder.name)}</bdi>.</p>{/if}
        {#if data.next}<button type="button" aria-disabled={reading || saving || uncertain} onclick={() => browse(trail, data?.next ?? undefined)}>Show more folders</button>{/if}
      {:else if !reading && !parent && !uncertain}
        <button type="button" aria-disabled={saving} onclick={() => browse([root])}>Try again</button>
      {/if}
      {#if reading}<p>Opening <bdi>{label(folder.name)}</bdi>…</p>{/if}
    </section>
    <footer>
      <button class="create" type="button" aria-disabled={unavailable || tooDeepToCreate} title={tooDeepToCreate ? "Can’t make a folder at this depth" : undefined} onclick={event => {
        if (!unavailable && !tooDeepToCreate) nameDialog?.open(undefined, event.currentTarget);
      }}>New folder</button>
      <div class="confirm">
        <button class="primary" type="button" aria-disabled={unavailable || alreadyHere} aria-busy={saving}
          aria-describedby={alreadyHere ? `${uid}-here` : undefined} onclick={move}>{#if saving}Moving…{:else}Move to <bdi>{label(folder.name)}</bdi>{/if}</button>
        {#if alreadyHere}<p class="reason" id={`${uid}-here`}>Already here</p>{/if}
      </div>
      <button type="button" aria-disabled={saving} bind:this={last} onclick={dismiss}>Cancel</button>
    </footer>
    <NameDialog bind:this={nameDialog} available={false} parent={folder}
      items={data?.folders.map(item => ({ name: item.name, kind: 'Folder' })) ?? []} oncreated={created} />
  </div>
</dialog>

<style>
  header, footer { display: flex; align-items: start; gap: var(--drive-space-2); }
  header { justify-content: space-between; }
  footer { justify-content: flex-end; }
  h2, h3, p, button { overflow-wrap: anywhere; }
  h3 { margin: 0; font-size: var(--drive-font-size-ui); }
  p, ul { margin: 0; }
  section { display: grid; justify-items: start; gap: var(--drive-space-2); }
  ul { width: 100%; padding: 0; list-style: none; }
  li { border-bottom: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  button { min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-secondary); font: inherit; font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button:hover:not([aria-disabled='true']), button.primary[aria-disabled='true'] { background: var(--drive-color-bg-raised); }
  button[aria-disabled='true'] { cursor: default; }
  button.primary:not([aria-disabled='true']) { background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); }
  button.primary:hover:not([aria-disabled='true']) { background: var(--drive-color-accent-hover); }
  .folder { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--drive-space-2); text-align: start; width: 100%; min-height: var(--drive-size-row-admin); border-radius: var(--drive-radius-m); }
  .folder :global(svg), .close svg { display: block; width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); }
  .close { flex: none; padding-inline: var(--drive-space-2); }
  .create { margin-inline-end: auto; }
  .primary { width: 100%; min-height: var(--drive-size-control-md); }
  .reason { padding-inline: var(--drive-space-inset-room); color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-meta); }
  :is(button, h3, .notice):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { footer { flex-direction: column; align-items: stretch; } }
</style>
