<script module lang="ts">
  import type { ShareRecipient } from './share-client';
  export type ShareAccess = ShareRecipient & { direct: boolean; inheritedFrom: string | null };
  export type SharePage<T> = {
    // Rows are one bounded page. Only complete effective access may establish emptiness.
    complete?: boolean; pageNumber: number | null; // One-based; null for unpaged results.
    state: 'loading' | 'failed' | 'ready'; rows: readonly T[];
    previous?: () => void; next?: () => void; retry?: () => void;
  };
</script>
<script lang="ts">
  import { tick } from 'svelte';
  import ShareRecipientPicker, { avatar } from './ShareRecipientPicker.svelte';
  import './dialog.css';
  let { name, kind, owner, access, candidates, nobodyElse = false, onInvite, onShare, onRemove }: {
    name: string; kind: 'File' | 'Folder'; owner: { recipientId: string; driveOwner: boolean };
    access: SharePage<ShareAccess>;
    // The caller must exclude anyone with effective access, including access not on the current page.
    candidates: SharePage<ShareRecipient>; nobodyElse?: boolean; onInvite?: () => void;
    // Resolve only after confirmation and refreshing the page(s); reject on failure or uncertainty.
    onShare: (ids: readonly string[]) => Promise<void>; onRemove: (id: string) => Promise<void>;
  } = $props();
  const id = $props.id();
  const label = (person: ShareRecipient) => person.displayName?.trim() ? person.displayName : 'Name unavailable';
  let dialog: HTMLDialogElement, accessTitle: HTMLElement, opener: HTMLElement | undefined;
  let first: HTMLButtonElement, last: HTMLButtonElement, backdrop = false;
  let notice = $state<HTMLElement>(), session = $state(0);
  let picked = $state<ShareRecipient[]>([]), added = $state<string[]>([]);
  let confirm = $state<string | null>(null), pending = $state<'share' | 'remove' | null>(null);
  let error = $state(''), live = $state(''), status = $state('');
  let paging = $state<'access' | 'candidates' | null>(null);
  const pageText = (page: SharePage<ShareRecipient>, subject: string, unpaged = '') => page.state === 'loading' ? `Loading ${subject}…` :
    page.state === 'ready' ? page.pageNumber === null ? unpaged : `Showing page ${page.pageNumber} of ${subject}.` : '';
  const allowed = $derived(candidates.rows.filter(person => person.recipientId !== owner.recipientId &&
    !access.rows.some(row => row.recipientId === person.recipientId)));
  const shareBlocked = $derived(!!pending || !picked.length || candidates.state !== 'ready' || access.state !== 'ready' ||
    picked.some(person => access.rows.some(row => row.recipientId === person.recipientId)));
  const nobody = $derived(nobodyElse && candidates.state === 'ready' && !candidates.previous && !candidates.next && !candidates.rows.length);
  const pageStatus = $derived(paging === 'access' ? pageText(access, 'people with access', 'Loaded people with access.') :
    paging ? pageText(candidates, 'people to add', 'Loaded people to add.') : '');
  const accessPagerEmpty = $derived(paging === 'access' && access.state === 'ready' && !access.previous && !access.next);
  $effect(() => { if (paging) live = pageStatus; });
  $effect(() => { if (accessPagerEmpty && document.activeElement?.id === `${id}-access-pager`) accessTitle.focus(); });
  // Mount per entry; its identity and owner must not change during a dialog session.
  export async function open(from: HTMLElement) {
    if (dialog.open) return;
    opener = from; session++; picked = []; confirm = paging = null; error = live = status = ''; added = [];
    dialog.showModal(); await tick();
    if (dialog.open) (dialog.querySelector<HTMLInputElement>('[role="combobox"]') ?? last).focus();
  }
  function close() { if (!pending) { dialog.close(); opener?.focus(); } }
  function keys(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const [from, to] = event.shiftKey ? [first, last] : [last, first];
    if (document.activeElement === from) { event.preventDefault(); to.focus(); }
  }
  function load(event: MouseEvent, key: NonNullable<typeof paging>, action: () => void) {
    if (pending) return;
    (event.currentTarget as HTMLButtonElement).parentElement?.focus();
    confirm = null; paging = key; live = status = '';
    action();
  }
  function onPageFeedback(message: string, clear?: string) {
    if (message) { live = message; status = ''; }
    else if (live === clear) live = '';
  }
  function select(ids: string[]) { if (!pending) picked = ids.flatMap(key => [...picked, ...allowed].find(person => person.recipientId === key) ?? []); }
  async function apply(person?: ShareAccess) {
    if (pending || (person ? !person.direct || confirm !== person.recipientId || access.state !== 'ready' : shareBlocked)) return;
    pending = person ? 'remove' : 'share'; paging = null; error = live = status = '';
    try {
      if (person) {
        await onRemove(person.recipientId); confirm = null;
        const inherited = person.inheritedFrom?.trim();
        status = `Removed direct access for ${label(person)}.${inherited ? ` Access through ${person.inheritedFrom} remains.` : ''}`;
      } else {
        const submitted = picked, ids = submitted.map(choice => choice.recipientId);
        await onShare(ids);
        added = [...new Set([...added, ...ids])]; picked = [];
        status = `Shared with ${submitted.length === 1 ? label(submitted[0]) : `${submitted.length} people`}`;
      }
    } catch {
      error = `${person ? 'Couldn’t confirm removal of direct access.' : 'Couldn’t confirm sharing.'} Check who has access before trying again.`;
    } finally {
      pending = null;
      await tick();
      if (error) notice?.focus();
      else if (dialog.open && !dialog.contains(document.activeElement)) (person ? accessTitle : last).focus();
    }
  }
</script>
{#snippet pager(page: SharePage<ShareRecipient>, key: NonNullable<typeof paging>, subject: string)}
  <div class="paging" role="group" id={`${id}-${key}-pager`} aria-label={`Pages of ${subject}`} tabindex="-1">
    <p>{pageText(page, subject)}</p>
    {#if page.state === 'failed'}<p role="alert">Couldn’t load {subject}.</p>
      {#if page.retry}<button type="button" aria-label={`Retry loading ${subject}`} aria-disabled={!!pending} onclick={event => load(event, key, page.retry!)}>Retry</button>{/if}
    {:else if page.state === 'ready'}
      {#if page.previous}<button type="button" aria-label={`Previous page of ${subject}`} aria-disabled={!!pending} onclick={event => load(event, key, page.previous!)}>Previous</button>{/if}
      {#if page.next}<button type="button" aria-label={`Next page of ${subject}`} aria-disabled={!!pending} onclick={event => load(event, key, page.next!)}>Next</button>{/if}
    {/if}
  </div>
{/snippet}
<dialog class="drive-dialog" bind:this={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-rules`}
  onkeydown={keys} oncancel={event => { event.preventDefault(); close(); }}
  onpointerdown={event => { backdrop = event.target === dialog; }} onclick={event => { if (backdrop && event.target === dialog) close(); }}>
  <div class="panel">
    <header><h2 id={`${id}-title`}>Share “<bdi>{name}</bdi>”</h2>
      <button type="button" class="close" aria-label="Close" aria-disabled={!!pending} bind:this={first} onclick={close}>×</button>
    </header>
    <p id={`${id}-rules`}>People you add can view and download. They can’t change, delete or re-share it.{kind === 'Folder' ? ' They also see anything you add to it later.' : ''}</p>
    {#if error}<p class="notice" role="alert" tabindex="-1" bind:this={notice}>{error}</p>{/if}
    {#if nobody}
      <div class="empty"><strong>There’s nobody else on this drive yet.</strong>
        {#if owner.driveOwner && onInvite}<button type="button" aria-disabled={!!pending} onclick={() => { if (!pending) { close(); onInvite?.(); } }}>Invite someone</button>
        {:else if !owner.driveOwner}<p>Ask the owner to invite them.</p>{/if}
      </div>
    {:else}
      {#snippet candidatePages()}{@render pager(candidates, 'candidates', 'people to add')}{/snippet}
      {#key session}
        <ShareRecipientPicker choices={candidates.state === 'ready' ? allowed : []} selectedChoices={picked} selectedIds={picked.map(person => person.recipientId)}
          onSelectionChange={select} {onPageFeedback} afterField={candidatePages} locked={!!pending || candidates.state !== 'ready'} />
      {/key}
    {/if}
    <p class:sr={!status} role="status">{status || live}</p>
    <section aria-labelledby={`${id}-access`}>
      <h3 id={`${id}-access`} tabindex="-1" bind:this={accessTitle}>People with access</h3>
      <ul role="list">
        <li><strong>You · owner</strong></li>
        {#each access.rows.filter(row => row.recipientId !== owner.recipientId && (row.direct || row.inheritedFrom !== null)) as person (person.recipientId)}
          {@const badge = avatar(person)}
          <li class:added={added.includes(person.recipientId)}>
            <span class="avatar" style:background-color={badge.colour} style:color="var(--drive-color-avatar-text)" aria-hidden="true">{badge.initials}</span>
            <div class="person"><strong><bdi>{label(person)}</bdi></strong>
              {#if person.inheritedFrom !== null}<small>Through <bdi>{person.inheritedFrom.trim() || 'a folder'}</bdi></small>{/if}
            </div>
            <span class="tag">Can view</span>
            {#if person.direct && access.state === 'ready'}
              {@const action = person.inheritedFrom !== null ? 'direct access' : 'access'}
              <button type="button" class="danger" aria-label={`Remove ${label(person)}’s ${action}`} aria-expanded={confirm === person.recipientId}
                aria-disabled={!!pending} onclick={() => { if (!pending) confirm = confirm === person.recipientId ? null : person.recipientId; }}>Remove</button>
              {#if confirm === person.recipientId}
                <div class="confirmation"><p>Remove <bdi>{label(person)}</bdi>’s {action}?{person.inheritedFrom !== null ? ' They’ll still have access through this folder.' : ''}</p>
                  <button type="button" class="danger" aria-label={`${pending === 'remove' ? 'Removing' : 'Confirm removal of'} direct access for ${label(person)}`}
                    aria-busy={pending === 'remove'} aria-disabled={!!pending} onclick={() => apply(person)}>{pending === 'remove' ? 'Removing…' : 'Remove'}</button>
                  <button type="button" aria-disabled={!!pending} onclick={event => { if (!pending) { confirm = null; event.currentTarget.closest('li')?.querySelector('button')?.focus(); } }}>Cancel</button>
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if access.state === 'ready' && access.complete && !access.next && !access.previous && !access.rows.length}<p>Only you can see this.</p>{/if}
      {@render pager(access, 'access', 'people with access')}
    </section>
    {#if !picked.length}<p id={`${id}-pick`}>Pick someone to share with</p>{/if}
    <footer>
      <button type="button" class="primary" aria-disabled={shareBlocked} aria-busy={pending === 'share'} aria-describedby={!picked.length ? `${id}-pick` : undefined}
        onclick={() => apply()}>{pending === 'share' ? 'Sharing…' : picked.length > 1 ? `Share with ${picked.length} people` : 'Share'}</button>
      <button type="button" aria-disabled={!!pending} bind:this={last} onclick={close}>Done</button>
    </footer>
  </div>
</dialog>
<style>
  header, footer, li, .paging, .confirmation { display: flex; align-items: center; flex-wrap: wrap; gap: var(--drive-space-2); }
  header { flex-wrap: nowrap; justify-content: space-between; }
  footer { justify-content: flex-end; }
  h2, h3, p, li { overflow-wrap: anywhere; }
  .sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
  h3, ul { margin: 0; font-size: var(--drive-font-size-ui); }
  p, small, button { color: var(--drive-color-text-secondary); }
  p { margin: 0; font-size: var(--drive-font-size-small); }
  ul { padding: 0; list-style: none; }
  li { min-height: var(--drive-size-control-md); border-block-end: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  li.added, .tag, button[aria-disabled='true'] { background: var(--drive-color-bg-raised); }
  .avatar, .tag, button { border-radius: var(--drive-radius-pill); }
  .avatar { display: grid; place-items: center; inline-size: var(--drive-size-control-sm); block-size: var(--drive-size-control-sm); }
  .person { flex: 1 0 10ch; min-width: 0; }
  small { display: block; font-size: var(--drive-font-size-meta); }
  .confirmation { flex-basis: 100%; }
  .tag { padding-inline: var(--drive-space-3); }
  .empty { padding: var(--drive-space-inset-card); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); }
  button { min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid transparent; background: transparent; font: inherit; font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button.close { min-width: var(--drive-size-control-sm); padding: 0; }
  button.danger { color: var(--drive-color-state-danger); }
  button:not(.primary):not([aria-disabled='true']):hover { background: var(--drive-color-bg-raised); }
  .primary { min-height: var(--drive-size-control-md); }
  button.primary:not([aria-disabled='true']) { background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); }
  button[aria-disabled='true'] { cursor: default; }
  :is(button, h3, .notice, .paging):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { footer { flex-direction: column; align-items: stretch; } }
</style>
