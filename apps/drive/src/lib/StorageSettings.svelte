<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { useAnnounce } from './announcements';
  import DriveNav from './DriveNav.svelte';
  import { storageSettingsPath } from './drive-navigation';
  import { requestStorageSettings, sameStorageLocation, type SavedStorage, type StorageConfig } from './storage-settings';

  let { ownerInvites = false }: { ownerInvites?: boolean } = $props();
  const announce = useAnnounce();
  const emptyDraft = () => ({ endpoint: '', region: '', bucket: '', accessKeyId: '', pathStyle: false });
  let draft: StorageConfig = $state(emptyDraft());
  let saved: SavedStorage | undefined = $state();
  let secretField: HTMLInputElement | undefined = $state();
  let heading: HTMLHeadingElement;
  let busy: 'load' | 'test' | 'save' | null = $state('load');
  let feedback = $state('');
  let failed = $state(false);
  let needsRefresh = $state(false);
  let locked = $state(false);
  let denied = $state(false);

  const candidate = $derived({
    endpoint: draft.endpoint.trim(), region: draft.region.trim(),
    bucket: draft.bucket.trim(), accessKeyId: draft.accessKeyId.trim(), pathStyle: draft.pathStyle,
  });
  const keepSecret = $derived(!!saved?.config && sameStorageLocation(saved.config, candidate) &&
    saved.config.accessKeyId === candidate.accessKeyId);

  function clearSecret() {
    if (secretField) secretField.value = '';
  }

  function report(text: string, error = false) {
    feedback = text;
    failed = error;
    announce(text, error ? 'assertive' : 'polite');
  }

  function edited() {
    if (!failed) feedback = '';
  }

  async function load() {
    const previous = saved;
    busy = 'load';
    clearSecret();
    const result = await requestStorageSettings('load');
    busy = null;
    if ('settings' in result) {
      saved = result.settings;
      needsRefresh = false;
      locked = false;
      if (!previous) draft = { ...(saved.config ?? emptyDraft()) };
      if (previous) report('Latest settings loaded. Review your changes before testing or saving.');
      else feedback = '';
    } else if ('error' in result && result.error === 'denied') {
      denied = true;
      saved = undefined;
      draft = emptyDraft();
      report('Owner access is required. Sign in as the Drive owner.', true);
    } else {
      report('Storage settings are temporarily unavailable. Try loading them again.', true);
    }
  }

  function restoreLocation() {
    if (!saved?.config) return;
    draft = { ...saved.config, accessKeyId: draft.accessKeyId };
    clearSecret();
    locked = false;
    report('Saved storage location restored. Review your credentials before saving.');
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !saved || !secretField || needsRefresh) return;
    const button = event.submitter;
    const operation = button instanceof HTMLButtonElement && button.value === 'save' ? 'save' : 'test';
    const secret = secretField.value;
    if (!secret && !keepSecret) {
      secretField.required = true;
      secretField.reportValidity();
      return;
    }
    const revision = saved.revision;
    busy = operation;
    feedback = '';
    if (operation === 'save') clearSecret();
    const result = await requestStorageSettings(operation, {
      ...candidate, revision, ...(secret && { secretAccessKey: secret }),
    });
    busy = null;

    if ('settings' in result) {
      saved = result.settings;
      if (saved.config) draft = { ...saved.config };
      locked = false;
      report('Storage settings saved.');
    } else if ('verified' in result) {
      report('Connection verified. Select Save settings to apply your changes.');
    } else {
      clearSecret();
      switch (result.error) {
        case 'invalid_settings':
          report('Check the storage settings and enter a replacement secret if required.', true);
          break;
        case 'settings_conflict':
          needsRefresh = true;
          report('Storage settings changed in another session. Load the latest settings to review your edits.', true);
          break;
        case 'storage_location_locked':
          locked = true;
          report('This Drive’s storage location is locked. Use the saved destination to update credentials.', true);
          break;
        case 'connection_failed':
          report('Connection failed. Check the endpoint, credentials, and bucket permissions.', true);
          break;
        case 'denied':
          denied = true;
          saved = undefined;
          draft = emptyDraft();
          report('Owner access is required. Sign in as the Drive owner.', true);
          break;
        default:
          needsRefresh = operation === 'save';
          report(operation === 'save'
            ? 'Drive could not confirm the save. Load the latest settings before trying again.'
            : 'Drive could not test the connection. Try again.', true);
      }
    }
    await tick();
    if (document.activeElement === document.body) {
      if (button instanceof HTMLButtonElement && button.isConnected && !needsRefresh) button.focus();
      else if (needsRefresh) document.getElementById('storage-reload')?.focus();
      else heading.focus();
    }
  }

  onMount(() => { void load(); });
</script>

<svelte:window onpagehide={() => { clearSecret(); edited(); }} />

<DriveNav current="storage" owner={ownerInvites} storage />
<main id="main" tabindex="-1">
  <h1 bind:this={heading} tabindex="-1">Storage settings</h1>
  <noscript><p>Enable JavaScript to manage your storage connection.</p></noscript>
  {#if !denied && busy === 'load'}
    <p>Loading storage settings…</p>
  {/if}

  {#if saved}
    <div class="settings">
      <section class="saved">
        {#if saved.config}
          <h2>Connected</h2>
          <p>The storage location is locked after setup. You can update its access keys.</p>
          <dl>
            <div><dt>Endpoint</dt><dd><bdi>{saved.config.endpoint}</bdi></dd></div>
            <div><dt>Region</dt><dd><bdi>{saved.config.region}</bdi></dd></div>
            <div><dt>Bucket</dt><dd><bdi>{saved.config.bucket}</bdi></dd></div>
            <div><dt>Access key ID</dt><dd><bdi>{saved.config.accessKeyId}</bdi></dd></div>
            <div><dt>Addressing</dt><dd>{saved.config.pathStyle ? 'Path-style' : 'Virtual-hosted'}</dd></div>
          </dl>
        {:else}
          <h2>Storage unconfigured</h2>
          <p>Connect an S3-compatible bucket to enable file uploads and downloads.</p>
        {/if}
      </section>

      <form method="post" action={storageSettingsPath} autocomplete="off" onsubmit={submit}>
        <fieldset disabled={busy !== null}>
          <legend>{saved.config ? 'Edit connection' : 'Connect storage'}</legend>
          <div class="field">
            <label for="storage-endpoint">HTTPS endpoint</label>
            <span id="storage-endpoint-hint">Use the service URL, for example https://s3.example.com.</span>
            <input type="url" id="storage-endpoint" name="endpoint" bind:value={draft.endpoint}
              aria-describedby="storage-endpoint-hint" pattern="https://.+" required spellcheck="false"
              autocapitalize="none" autocorrect="off" oninput={edited} />
          </div>
          <div class="field">
            <label for="storage-region">Region</label>
            <input id="storage-region" name="region" bind:value={draft.region} required spellcheck="false"
              autocapitalize="none" autocorrect="off" oninput={edited} />
          </div>
          <div class="field">
            <label for="storage-bucket">Bucket</label>
            <input id="storage-bucket" name="bucket" bind:value={draft.bucket} required spellcheck="false"
              autocapitalize="none" autocorrect="off" oninput={edited} />
          </div>
          <div class="field">
            <label for="storage-key-id">Access key ID</label>
            <input id="storage-key-id" name="accessKeyId" bind:value={draft.accessKeyId} required spellcheck="false"
              autocapitalize="none" autocorrect="off" oninput={edited} />
          </div>
          <div class="field">
            <label for="storage-secret">Secret access key</label>
            <span id="storage-secret-hint">{keepSecret ? 'Leave blank to keep the saved secret, or enter a replacement.' : 'Enter the secret for this access key.'}</span>
            <!-- Only the explicit JSON requests can include the secret. -->
            <input type="password" id="storage-secret" bind:this={secretField} aria-describedby="storage-secret-hint"
              autocomplete="off" required={!keepSecret} spellcheck="false" autocapitalize="none" autocorrect="off" oninput={edited} />
          </div>
          <label class="check">
            <input type="checkbox" name="pathStyle" bind:checked={draft.pathStyle} onchange={edited} />
            Use path-style addressing
          </label>
        </fieldset>
        <div class="actions">
          <button type="submit" value="test" aria-disabled={busy !== null || needsRefresh}>Test connection</button>
          <button class="primary" type="submit" value="save" aria-disabled={busy !== null || needsRefresh}>Save settings</button>
        </div>
      </form>
    </div>
  {/if}

  {#if busy === 'test' || busy === 'save'}
    <p>{busy === 'test' ? 'Testing connection…' : 'Verifying and saving settings…'}</p>
  {/if}
  {#if feedback}<p class="feedback" class:failed>{feedback}</p>{/if}
  {#if denied}
    <a href="/sign-in?next=%2Fsettings%2Fstorage" data-sveltekit-reload>Sign in</a>
  {:else if (needsRefresh || !saved) && busy !== 'load'}
    <button id="storage-reload" type="button" onclick={load}>Load latest settings</button>
  {:else if locked && saved?.config && !busy}
    <button type="button" onclick={restoreLocation}>Use saved destination</button>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: var(--drive-color-bg-canvas); }
  main { box-sizing: border-box; max-width: var(--drive-layout-container); margin-inline: auto; padding: var(--drive-space-4) var(--drive-layout-gutter-wide); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  h1 { margin: 0 0 var(--drive-space-5); font-size: var(--drive-font-size-h3); }
  h2, legend { margin: 0; font-size: var(--drive-font-size-ui); font-weight: var(--drive-font-weight-semibold); }
  p, .field span, dt { color: var(--drive-color-text-secondary); line-height: var(--drive-line-height-body); }
  .settings { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); align-items: start; gap: var(--drive-space-5); max-inline-size: 56rem; }
  .saved { padding: var(--drive-space-4); border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); }
  .saved p:last-child, dl { margin-block-end: 0; }
  dl { display: grid; gap: var(--drive-space-3); font-size: var(--drive-font-size-ui); }
  dd { margin: 0; overflow-wrap: anywhere; }
  form, fieldset { display: grid; gap: var(--drive-space-3); min-inline-size: 0; }
  fieldset { margin: 0; padding: 0; border: 0; }
  legend { margin-block-end: var(--drive-space-3); padding: 0; }
  .field { display: grid; gap: var(--drive-space-1); }
  label, button { font-weight: var(--drive-font-weight-medium); }
  .field span { font-size: var(--drive-font-size-ui); }
  input:not([type="checkbox"]) { box-sizing: border-box; width: 100%; min-height: var(--drive-size-control-md); padding: var(--drive-space-2) var(--drive-space-inset-room); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-m); color: inherit; background: var(--drive-color-bg-canvas); font: inherit; }
  .check { display: flex; align-items: center; gap: var(--drive-space-2); min-block-size: var(--drive-size-control-md); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--drive-space-2); }
  button { min-height: var(--drive-size-control-md); padding-inline: var(--drive-space-inset-room); border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: var(--drive-color-bg-canvas); color: inherit; font-family: inherit; font-size: var(--drive-font-size-ui); cursor: pointer; }
  button.primary { background: var(--drive-color-accent-default); color: var(--drive-color-text-on-accent); border-color: transparent; }
  button:not([aria-disabled="true"]):hover { background: var(--drive-color-bg-raised); }
  button.primary:not([aria-disabled="true"]):hover { background: var(--drive-color-accent-hover); }
  button[aria-disabled="true"] { background: var(--drive-color-bg-raised); color: var(--drive-color-text-secondary); cursor: default; }
  .feedback { color: var(--drive-color-text-primary); }
  .failed { color: var(--drive-color-state-danger); }
  a { color: inherit; }
  :is(a, button, h1, input):focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  @media (max-width: 820px) { main { padding-inline: var(--drive-layout-gutter-compact); } }
  @media (max-width: 620px) { .settings { grid-template-columns: minmax(0, 1fr); } }
</style>
