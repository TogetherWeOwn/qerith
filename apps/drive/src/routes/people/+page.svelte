<script lang="ts">
  import DriveNav from '../../lib/DriveNav.svelte';
  import OwnerInviteDialog from '../../lib/OwnerInviteDialog.svelte';
  import { issueOwnerInvite } from '../../lib/owner-invite';
</script>

<svelte:head>
  <title>Users and invites · Drive</title>
</svelte:head>

<DriveNav current="people" />
<main id="main" tabindex="-1">
  <header>
    <h1>Users and invites</h1>
    <OwnerInviteDialog onIssue={issueOwnerInvite} />
  </header>
  <p>Invite someone, then copy the link and send it to them yourself.</p>
</main>

<style>
  :global(body) { margin: 0; background: var(--drive-color-bg-canvas); }
  main { box-sizing: border-box; max-width: var(--drive-layout-container); margin-inline: auto; padding: var(--drive-space-4) var(--drive-layout-gutter-wide); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--drive-space-3); }
  h1 { margin: 0; font-size: var(--drive-font-size-h3); }
  p { color: var(--drive-color-text-secondary); line-height: var(--drive-line-height-body); }
  @media (max-width: 820px) {
    main { padding-inline: var(--drive-layout-gutter-compact); }
    header { grid-template-columns: minmax(0, 1fr); }
  }
</style>
