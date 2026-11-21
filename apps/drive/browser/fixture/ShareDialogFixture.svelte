<script lang="ts">
  import ShareDialog, { type ShareAccess } from '../../src/lib/ShareDialog.svelte';
  import '../../src/lib/tokens.css';
  let { mode }: { mode: string } = $props();
  const person = (recipientId: string, displayName: string | null) => ({ recipientId, displayName });
  const pell = person('opaque-1', 'Pell Quinn'), sam = person('opaque-2', 'Sam Mora'), zoe = person('opaque-3', 'Zoë Chen');
  const lee = person('opaque-4', 'Lee Ray'), unnamed = person('opaque-5', null), owner = person('opaque-6', 'Owner');
  const grant = (choice: ReturnType<typeof person>, direct: boolean, inheritedFrom: string | null = null) => ({ ...choice, direct, inheritedFrom });
  let grants = $state<ShareAccess[]>([grant(pell, true), grant(sam, true, 'Projects'), grant(zoe, false, 'Projects')]);
  let accessState = $state<'ready' | 'failed' | 'loading'>('ready');
  let second = $state(false), invited = $state(false), accessPage = $state(1);
  let dialog: ReturnType<typeof ShareDialog>;
  let attempts = 0;
  let writes = $state<string[]>([]);
  const alone = $derived(mode === 'owner' || mode === 'member');
  const eligible = $derived([lee, sam, owner, unnamed].filter(({ recipientId }) =>
    recipientId !== owner.recipientId && !grants.some(row => row.recipientId === recipientId)));
  function settle(mutation = true) {
    return new Promise<void>((resolve, reject) => window.addEventListener('fixture-settle', () => mutation && [1, 3].includes(++attempts) ? reject() : resolve(), { once: true }));
  }
  async function nextAccess() { accessState = 'loading'; await settle(false); accessPage = 2; accessState = 'ready'; }
  async function share(ids: readonly string[]) {
    writes = [...writes, ...ids];
    await settle();
    grants = [...grants, ...[lee, unnamed].filter(choice => ids.includes(choice.recipientId)).map(choice => grant(choice, true))];
  }
  async function remove(id: string) {
    writes = [...writes, id];
    await settle();
    grants = grants.flatMap(row => row.recipientId !== id ? [row] : row.inheritedFrom === null ? [] : [{ ...row, direct: false }]);
  }
</script>
<svelte:window onfixture-refresh-access={() => { grants = [...grants]; }} />
<main data-writes={JSON.stringify(writes)}>
  <h1>My Drive</h1>
  <button type="button" onclick={event => { accessState = mode === 'failed' ? 'failed' : 'ready'; dialog.open(event.currentTarget); }}>Open Share</button>
  {#if invited}<p>Users and invites</p>{/if}
  <ShareDialog bind:this={dialog} name={mode === 'file' ? 'Budget.pdf' : 'Taxes 2025'} kind={mode === 'file' ? 'File' : 'Folder'}
    owner={{ recipientId: owner.recipientId, driveOwner: mode !== 'member' }} nobodyElse={alone} onInvite={() => invited = true}
    access={{ state: accessState, rows: alone || accessState !== 'ready' ? [] : mode === 'partial' ? grants.slice(0, accessPage - 1) : grants,
      complete: mode !== 'partial', ...(mode === 'partial' ? { pageNumber: accessPage, next: accessPage === 1 ? nextAccess : undefined } : { pageNumber: null, retry: () => accessState = 'ready' }) }}
    candidates={{ state: 'ready', pageNumber: alone ? null : second ? 2 : 1, rows: alone ? [] : eligible.slice(second ? 1 : 0, second ? 2 : 1),
      ...(!alone && (second ? { previous: () => second = false } : eligible.length > 1 ? { next: () => second = true } : {})) }} onShare={share} onRemove={remove} />
</main>
<style>
  :global(body) { background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
</style>
