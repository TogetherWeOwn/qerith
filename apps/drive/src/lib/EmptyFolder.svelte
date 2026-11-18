<script lang="ts">
  import './tokens.css';

  export let root: boolean;
  export let onUpload: (() => void) | undefined = undefined;
</script>

<section class="empty" aria-labelledby="empty-title">
  <div>
    <h2 id="empty-title">{root ? 'Your drive is empty.' : 'This folder is empty.'}</h2>
    {#if onUpload}<p>{root ? 'Upload a file or make a folder to start.' : 'Drop files here or use Upload.'}</p>{/if}
  </div>
  {#if onUpload}<button type="button" onclick={onUpload}>Upload files</button>{/if}
</section>

<style>
  @font-face {
    font-family: 'Qerith Sans';
    src: url('./fonts/QerithSans-latin.woff2') format('woff2');
    font-weight: 200 900;
    font-stretch: 75% 125%;
    font-display: swap;
    unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  .empty { display: flex; align-items: center; justify-content: space-between; gap: var(--drive-space-4); padding: var(--drive-space-5); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  h2 { margin: 0; font-size: var(--drive-font-size-body); font-weight: var(--drive-font-weight-semibold); }
  p { margin: var(--drive-space-2) 0 0; color: var(--drive-color-text-secondary); font-size: var(--drive-font-size-small); }
  @media (max-width: 820px) { .empty { align-items: flex-start; flex-direction: column; } }
  button { min-height: var(--drive-size-control-sm); padding: 0 var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-primary); font: inherit; cursor: pointer; }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
