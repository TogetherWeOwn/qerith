<script lang="ts">
  import './tokens.css';

  export let root: boolean;
  export let onUpload: () => void;
</script>

<section class="empty" aria-labelledby="empty-title">
  <h2 id="empty-title">{root ? 'Your drive is empty.' : 'This folder is empty.'}</h2>
  <p>{root ? 'Upload a file or make a folder to start.' : 'Drop files here or use Upload.'}</p>
  <button type="button" onclick={onUpload}>Upload files</button>
</section>

<style>
  .empty { padding: var(--drive-space-9) var(--drive-space-4); text-align: center; color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  h2 { margin: 0; font-size: var(--drive-font-size-title); }
  p { margin: var(--drive-space-2) 0 var(--drive-space-4); color: var(--drive-color-text-secondary); }
  button { min-height: var(--drive-size-control-sm); padding: 0 var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-primary); font: inherit; cursor: pointer; }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
