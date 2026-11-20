<script lang="ts">
  import './tokens.css';

  let { current }: { current: 'home' | 'people' } = $props();
</script>

<a class="skip" href="#main">Skip to content</a>
<nav aria-label="Drive" data-sveltekit-reload>
  <a href="/" aria-current={current === 'home' ? 'page' : undefined}>My Drive</a>
  <a href="/people" aria-current={current === 'people' ? 'page' : undefined}>Users and invites</a>
</nav>

<style>
  nav { display: flex; flex-wrap: wrap; gap: var(--drive-space-4); padding-inline: var(--drive-space-4); color: var(--drive-color-text-primary); background: var(--drive-color-bg-canvas); font-family: var(--drive-font-ui); }
  nav a { display: inline-flex; align-items: center; min-height: var(--drive-size-control-md); color: inherit; }
  nav a:not([aria-current]):not(:hover) { text-decoration: none; }
  .skip { position: absolute; inset-block-start: var(--drive-space-3); inset-inline-start: var(--drive-space-3); display: inline-flex; align-items: center; min-height: var(--drive-size-control-sm); padding-inline: var(--drive-space-3); border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font-family: var(--drive-font-ui); }
  .skip:not(:focus) { clip-path: inset(50%); }
  a:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
