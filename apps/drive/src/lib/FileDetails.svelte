<script lang="ts">
  import './tokens.css';

  export let id: string;
  export let name: string;
  export let size: string;
  export let bytes: number | null;
  export let kind: string;
  export let modifiedFull: string | undefined = undefined;
  export let uploaded: string | undefined = undefined;
  export let sharedWith: string[] | undefined = undefined;
  export let onClose: () => void;
</script>

<div class="facts" data-details-id={id} tabindex="-1" role="group" aria-label={name.trim() ? `Details for ${name}` : 'Details for whitespace-only name'}>
  <dl>
    <div><dt>Name</dt><dd dir="auto">{name}</dd></div>
    <div><dt>Size</dt><dd>{#if bytes === null}—{:else}{#if bytes >= 1000}{`${size} · `}{/if}<data value={bytes}>{bytes.toLocaleString()} {bytes === 1 ? 'byte' : 'bytes'}</data>{/if}</dd></div>
    <div><dt>Kind</dt><dd>{kind}</dd></div>
    {#if modifiedFull}<div><dt>Modified</dt><dd>{modifiedFull}</dd></div>{/if}
    {#if uploaded}<div><dt>Uploaded</dt><dd>{uploaded}</dd></div>{/if}
    {#if sharedWith?.length}<div><dt>Shared with</dt><dd>{sharedWith.join(', ')}</dd></div>{/if}
  </dl>
  <button type="button" on:click={onClose}>Hide details</button>
</div>

<style>
  .facts { padding: var(--drive-space-2) var(--drive-space-inset-card); background: var(--drive-color-bg-surface); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); font-size: var(--drive-font-size-ui); overflow-wrap: anywhere; }
  dl { margin: 0; }
  dl div { display: flex; justify-content: space-between; gap: var(--drive-space-3); }
  dl div + div { border-top: var(--drive-size-line) solid var(--drive-color-line-hairline); }
  dt { flex-shrink: 0; color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); }
  dd { min-width: 0; margin: 0; text-align: right; white-space: break-spaces; }
  dd[dir] { unicode-bidi: plaintext; }
  button { margin-top: var(--drive-space-2); min-height: var(--drive-size-control-sm); padding: 0 var(--drive-space-inset-room); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: transparent; color: var(--drive-color-text-primary); font: inherit; font-size: var(--drive-font-size-small); font-weight: var(--drive-font-weight-semibold); font-stretch: var(--drive-font-width-button); cursor: pointer; }
  button:hover { background: var(--drive-color-bg-raised); }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
