<script>
  import OwnerInviteDialog from '../../src/lib/OwnerInviteDialog.svelte';

  let finish;
  async function onIssue(metadata) {
    document.body.dataset.issues = String(Number(document.body.dataset.issues ?? 0) + 1);
    document.body.dataset.metadata = JSON.stringify(metadata);
    const outcome = await new Promise(resolve => { finish = resolve; });
    if (outcome === 'not-issued') return { kind: 'not-issued' };
    if (outcome === 'uncertain') throw new Error('Synthetic interruption');
    return { token: 'fixture_'.padEnd(43, 'x'), expiresAt: Date.UTC(2026, 10, 21, 18) };
  }
</script>

<svelte:head><title>Invite someone · Drive</title></svelte:head>
<svelte:window onfixture-issue-result={event => finish?.(event.detail)} />
<main id="owner-invite-fixture">
  <header><h1>Users and invites</h1><OwnerInviteDialog {onIssue} /></header>
</main>

<style>
  :global(body:has(#owner-invite-fixture)) { margin: 0; }
  main { min-height: 100dvh; box-sizing: border-box; padding: var(--drive-space-6) var(--drive-layout-gutter-wide); background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--drive-space-4); max-width: var(--drive-layout-container); margin-inline: auto; }
  h1 { margin: 0; font-size: var(--drive-font-size-h3); font-weight: var(--drive-font-weight-display); }
  @media (max-width: 820px) { main { padding-inline: var(--drive-layout-gutter-compact); } }
</style>
