<script lang="ts">
  import { uploadToRoot } from './root-upload';
  import './tokens.css';

  let { announce, refresh }: { announce: (message: string) => void; refresh: () => Promise<void> } = $props();
  const id = $props.id();
  let picker: HTMLInputElement;
  let selected = $state<{ name: string; size: number }>();
  let busy = $state(false);
  let acceptedBytes = $state(0);
  let message = $state('');
  let published = $state(false);

  function openPicker() {
    if (!busy) picker.click();
  }

  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = true;
    selected = { name: file.name, size: file.size };
    acceptedBytes = 0;
    published = false;
    announce(`Uploading ${file.name} to My Drive.`);
    message = 'Uploading…';

    try {
      const result = await uploadToRoot(file, () => { acceptedBytes = file.size; });
      if (result.status === 'published') {
        published = true;
        message = 'Uploaded.';
        try { await refresh(); }
        catch { message = 'Uploaded. Refresh My Drive to see it.'; }
      } else if (result.status === 'name-taken') {
        message = 'A file with this name already exists in My Drive.';
      } else {
        message = 'Upload interrupted.';
      }
      announce(`${file.name}: ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

<button type="button" aria-disabled={busy} onclick={openPicker}>Upload</button>
<input type="file" hidden bind:this={picker} onchange={upload} />
{#if selected}
  <section aria-labelledby={`${id}-uploads`}>
    <h2 id={`${id}-uploads`}>Uploads</h2>
    <bdi id={`${id}-filename`}>{selected.name}</bdi>
    <p>{message}</p>
    <p class="bytes">{acceptedBytes.toLocaleString()} of {selected.size.toLocaleString()} bytes · My Drive</p>
    <progress aria-labelledby={`${id}-filename`} max={selected.size || 1} value={selected.size ? acceptedBytes : Number(published)}></progress>
  </section>
{/if}

<style>
  button { min-height: var(--drive-size-control-md); padding-inline: var(--drive-space-4); border: 0; border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font: inherit; font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button:not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button[aria-disabled='true'] { background: var(--drive-color-bg-raised); color: var(--drive-color-text-primary); }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  section { box-sizing: border-box; max-width: var(--drive-layout-rail-max); margin-block: var(--drive-space-3); padding: var(--drive-space-3); background: var(--drive-color-bg-surface); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-l); overflow-wrap: anywhere; }
  h2, p { margin: 0 0 var(--drive-space-2); }
  h2 { font-size: var(--drive-font-size-ui); }
  .bytes { color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-small); }
  progress { display: block; width: 100%; height: var(--drive-size-progress-row); accent-color: var(--drive-color-accent-default); }
  @media (max-width: 820px) { button { width: 100%; } }
</style>
