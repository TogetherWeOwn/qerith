<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import ShareDialog, { type ShareChange, type SharePage } from './ShareDialog.svelte';
  import { entryShare, isShareMutationId } from './share-client';

  let { entryId, name, kind, owner, isCurrent, onreturn }: {
    entryId: string; name: string; kind: 'File' | 'Folder';
    owner: { recipientId: string; driveOwner: boolean };
    isCurrent: () => boolean; onreturn: () => void;
  } = $props();

  // The parent mounts this component for a single dialog session and entry.
  let dialog: ReturnType<typeof ShareDialog>;
  const lifetime = new AbortController();
  const current = () => !lifetime.signal.aborted && isCurrent();
  const readMs = 5_000, batchMs = 15_000;
  const withTimeout = (ms: number) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(ms)]);
  type Client = ReturnType<typeof entryShare>;
  type Page = Awaited<ReturnType<Client['listAccessPage']>>;
  type View = {
    cursors: string[]; state: SharePage<unknown>['state']; data: Page | null; request: number;
  };
  const access = $state<View>({ cursors: [], state: 'loading', data: null, request: 0 });
  const candidates = $state<View>({ cursors: [], state: 'loading', data: null, request: 0 });
  const observed = new SvelteMap<string, { version: number; hasAccess: boolean }>();
  let completeVersion = $state(0);
  const observedIneligible = (id: string) => {
    const row = observed.get(id);
    return (row?.version ?? 0) < completeVersion || row?.hasAccess === true;
  };
  let client: Client, request = 0;

  onMount(() => {
    client = entryShare(entryId);
    void dialog.open();
    void refresh();
    return () => lifetime.abort();
  });

  async function read(...views: View[]) {
    if (!current()) return;
    const version = ++request;
    for (const view of views) {
      view.request = version;
      view.state = 'loading';
      view.data = null;
    }
    const cursor = views[0].cursors.at(-1);
    const page = await client.listAccessPage({ cursor, signal: withTimeout(readMs) }).catch(() => null);
    const active = views.filter(view => view.request === version);
    if (!current() || !active.length) return;
    for (const view of active) {
      view.data = page;
      view.state = page ? 'ready' : 'failed';
    }
    if (!page) return;
    // Only a full roster can make absence conclusive.
    if (page.complete) completeVersion = Math.max(completeVersion, version);
    // Both pagers read the same roster. A later request for an overlapping row takes precedence.
    for (const group of ['access', 'candidates'] as const) {
      for (const { recipientId } of page[group]) {
        if ((observed.get(recipientId)?.version ?? 0) < version) {
          observed.set(recipientId, { version, hasAccess: group === 'access' });
        }
      }
    }
  }

  function refresh() {
    if (access.cursors.at(-1) === candidates.cursors.at(-1)) {
      void read(access, candidates);
    } else {
      void read(access);
      void read(candidates);
    }
  }

  function page<K extends 'access' | 'candidates'>(view: View, key: K): SharePage<Page[K][number]> {
    const next = view.data?.nextCursor;
    return {
      state: view.state, complete: view.data?.complete, rows: view.data?.[key] ?? [],
      pageNumber: view.cursors.length || next ? view.cursors.length + 1 : null,
      previous: view.cursors.length ? () => { view.cursors.pop(); void read(view); } : undefined,
      next: next ? () => { view.cursors.push(next); void read(view); } : undefined,
      retry: () => { void read(view); }
    };
  }

  async function change(method: 'grant' | 'revoke', ids: readonly string[]): Promise<ShareChange> {
    const deadline = performance.now() + batchMs;
    const signal = withTimeout(batchMs);
    let confirmed = 0, uncertain = false;
    for (const id of ids) {
      if (!current() || signal.aborted || performance.now() >= deadline || !isShareMutationId(id)) break;
      try {
        await client[method](id, signal);
        confirmed++;
      } catch {
        // The server may have committed the write before the response was lost.
        uncertain = true;
        break;
      }
    }
    refresh();
    return { confirmed, uncertain };
  }
</script>

<ShareDialog bind:this={dialog} {name} {kind} {owner} {onreturn} {observedIneligible}
  nobodyElse={!!candidates.data?.complete && !candidates.data.access.length && !candidates.data.candidates.length}
  access={page(access, 'access')} candidates={page(candidates, 'candidates')}
  onShare={ids => change('grant', ids)} onRemove={id => change('revoke', [id])} />
