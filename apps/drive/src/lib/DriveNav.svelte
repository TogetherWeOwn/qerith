<script lang="ts">
  import './tokens.css';

  let { current, shared = false, owner = true }: { current: 'home' | 'people' | 'shared'; shared?: boolean; owner?: boolean } = $props();
</script>

<a class="skip" href="#main">Skip to content</a>
<header>
  <nav aria-label="Drive" data-sveltekit-reload>
    <a href="/" aria-current={current === 'home' ? 'page' : undefined}>My Drive</a>
    {#if shared}<a href="/shared" aria-current={current === 'shared' ? 'page' : undefined}>Shared with me</a>{/if}
    {#if owner}<a href="/people" aria-current={current === 'people' ? 'page' : undefined}>Users and invites</a>{/if}
  </nav>
</header>

<style>
  header { background: var(--drive-color-bg-canvas); }
  nav { display: flex; flex-wrap: wrap; align-items: center; gap: var(--drive-space-2); box-sizing: border-box; max-width: var(--drive-layout-container); min-height: var(--drive-size-header-compact); margin-inline: auto; padding-inline: var(--drive-layout-gutter-wide); font-family: var(--drive-font-ui); }
  nav a { display: inline-flex; align-items: center; min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-3); border-radius: var(--drive-radius-pill); font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-medium); color: var(--drive-color-text-secondary); text-decoration: none; }
  nav a[aria-current] { background: var(--drive-color-bg-raised); color: var(--drive-color-text-primary); }
  nav a[aria-current], nav a:hover { text-decoration: underline; }
  @media (max-width: 820px) { nav { padding-inline: var(--drive-layout-gutter-compact); } }
  .skip { position: absolute; inset-block-start: var(--drive-space-3); inset-inline-start: var(--drive-space-3); display: inline-flex; align-items: center; min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-3); border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font-family: var(--drive-font-ui); }
  .skip:not(:focus) { clip-path: inset(50%); }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
