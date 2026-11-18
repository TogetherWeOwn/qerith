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
    <div><dt>Size</dt><dd>{#if bytes === null}—{:else}{#if bytes >= 1000}{size} · {/if}<data value={bytes}>{bytes.toLocaleString()} {bytes === 1 ? 'byte' : 'bytes'}</data>{/if}</dd></div>
    <div><dt>Kind</dt><dd>{kind}</dd></div>
    {#if modifiedFull}<div><dt>Modified</dt><dd>{modifiedFull}</dd></div>{/if}
    {#if uploaded}<div><dt>Uploaded</dt><dd>{uploaded}</dd></div>{/if}
    {#if sharedWith?.length}<div><dt>Shared with</dt><dd>{sharedWith.join(', ')}</dd></div>{/if}
  </dl>
  <button type="button" on:click={onClose}>Hide details</button>
</div>

<style>
  .facts { padding: var(--drive-space-3); background: var(--drive-color-bg-surface); overflow-wrap: anywhere; }
  dl { margin: 0; }
  dl div { display: flex; gap: var(--drive-space-3); }
  dt { min-width: 8em; color: var(--drive-color-text-secondary); }
  dd { margin: 0; white-space: break-spaces; }
  dd[dir] { unicode-bidi: plaintext; }
  button { min-height: var(--drive-size-control-sm); }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
</style>
