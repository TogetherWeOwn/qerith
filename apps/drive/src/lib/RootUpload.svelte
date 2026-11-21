<script lang="ts">
  import { resumeMultipartToRoot, uploadMultipartToRoot, uploadToRoot } from './root-upload';
  import type { DriveUploadMode } from './server/request-auth';
  import './tokens.css';

  let { mode, announce, refresh, paginated, busy = $bindable(false), fixtureResumeIntentId, fixtureFetcher }: {
    mode: Exclude<DriveUploadMode, 'disabled'>;
    announce: (message: string) => void; refresh: () => Promise<void>; paginated: boolean; busy: boolean;
    // Only the disposable fixture supplies these. Never discover or persist an intent here.
    fixtureResumeIntentId?: string; fixtureFetcher?: typeof fetch;
  } = $props();
  const id = $props.id();
  let picker = $state<HTMLInputElement>();
  let continuePicker = $state<HTMLInputElement>();
  let selected = $state<{ name: string; size: number }>();
  let acceptedBytes = $state(0);
  let message = $state('');
  let published = $state(false);
  let selection = 0;

  function openPicker() {
    if (!busy) picker?.click();
  }

  async function upload(event: Event, intentId?: string) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = true;
    const attempt = ++selection;
    selected = { name: file.name, size: file.size };
    acceptedBytes = 0;
    published = false;

    try {
      const continuing = intentId !== undefined;
      announce(continuing ? `Continuing upload of ${file.name} to My Drive.` : `Uploading ${file.name} to My Drive.`);
      message = continuing ? 'Continuing upload…' : 'Uploading…';
      const partAccepted = (bytes: number) => { acceptedBytes = bytes; };
      const result = continuing
        ? await resumeMultipartToRoot(intentId, file, bytes => {
            partAccepted(bytes);
            message = 'Finishing upload…';
          }, fixtureFetcher)
        : mode === 'multipart'
          ? await uploadMultipartToRoot(file, partAccepted, fixtureFetcher)
          : await uploadToRoot(file, () => partAccepted(file.size), fixtureFetcher);
      if (result.status === 'published') {
        published = true;
        message = 'Uploaded.';
        // A slow listing read must not keep a completed upload busy or replace newer feedback.
        void refresh().catch(() => {
          if (attempt !== selection) return;
          message = paginated ? 'Uploaded. Go back to the first page to refresh My Drive.' : 'Uploaded. Refresh My Drive to see it.';
          announce(`${file.name}: ${message}`);
        });
      } else if (result.status === 'name-taken') {
        message = 'An item with this name already exists in My Drive.';
      } else {
        message = 'Upload interrupted.';
      }
      announce(`${file.name}: ${message}`);
    } finally {
      busy = false;
    }
  }
</script>

<button type="button" aria-disabled={!picker || busy} onclick={openPicker}>Upload</button>
<input type="file" hidden bind:this={picker} onchange={event => upload(event)} />
{#if mode === 'multipart' && fixtureResumeIntentId !== undefined}
  {#key fixtureResumeIntentId}
    <button class="quiet" type="button" aria-disabled={!continuePicker || busy}
      onclick={() => { if (!busy) continuePicker?.click(); }}>Continue upload</button>
    <input type="file" hidden bind:this={continuePicker} onchange={event => {
      if (mode === 'multipart' && fixtureResumeIntentId !== undefined) void upload(event, fixtureResumeIntentId);
    }} />
  {/key}
{/if}
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
  button { min-height: var(--drive-size-control-md); padding-inline: var(--drive-space-4); border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill); background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); font: inherit; font-weight: var(--drive-font-weight-semibold); cursor: pointer; }
  button:not(.quiet):not([aria-disabled='true']):hover { background: var(--drive-color-accent-hover); }
  button.quiet, button[aria-disabled='true'] { background: var(--drive-color-bg-raised); color: var(--drive-color-text-primary); }
  button.quiet:not([aria-disabled='true']):hover { border-color: var(--drive-color-line-hairline-strong); }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  section { grid-column: 1 / -1; box-sizing: border-box; max-width: var(--drive-layout-rail-max); margin-block: var(--drive-space-3); padding: var(--drive-space-3); background: var(--drive-color-bg-surface); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-l); overflow-wrap: anywhere; }
  h2, p { margin: 0 0 var(--drive-space-2); }
  h2 { font-size: var(--drive-font-size-ui); }
  .bytes { color: var(--drive-color-text-tertiary); font-family: var(--drive-font-data); font-size: var(--drive-font-size-small); }
  progress { display: block; width: 100%; height: var(--drive-size-progress-row); accent-color: var(--drive-color-accent-default); }
  @media (max-width: 820px) { button { width: 100%; } }
</style>
