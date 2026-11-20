<script lang="ts">
  import { onMount } from 'svelte';
  import { observeInviteLinks } from '../../lib/invite-link';
  import InviteAcceptance, { type InviteAcceptanceView, type InvitePasskeyPhase } from '../../lib/InviteAcceptance.svelte';

  let view = $state<InviteAcceptanceView>();
  let phase = $state<InvitePasskeyPhase>('valid');
  let committing = $state(false);
  let token = '';
  let attempt: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function post(step: 'present' | 'challenge' | 'enroll', fields: object = {}, signal?: AbortSignal) {
    return fetch(`/api/invite/${step}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...fields }),
      cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
      // Keep Origin on same-origin POSTs without sending a Referer.
      referrerPolicy: 'same-origin', referrer: '',
    });
  }

  onMount(() => {
    let load: AbortController | undefined;
    const reset = () => {
      load?.abort();
      attempt?.abort();
      attempt = undefined;
      clearTimeout(retry);
      token = '';
    };
    const stop = observeInviteLinks(next => {
      // The new fragment is already stripped. Finish the in-flight save first.
      if (committing) return;
      reset();
      token = next;
      view = undefined;
      phase = 'valid';
      load = new AbortController();
      void present(load.signal);
    });
    return () => { stop(); reset(); };
  });

  async function present(signal: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { view = { kind: 'dead-link' }; return; }
    try {
      const session = await fetch('/invite', { method: 'HEAD', cache: 'no-store', redirect: 'error', signal });
      signal.throwIfAborted();
      if (session.status === 204) { view = { kind: 'signed-in' }; return; }
      if (session.status !== 200) throw new Error('Invite session unavailable');
      const response = await post('present', {}, signal);
      signal.throwIfAborted();
      if (response.status === 404) { view = { kind: 'dead-link' }; return; }
      if (!response.ok) throw new Error('Invite presentation unavailable');
      const { displayName, note } = await response.json();
      signal.throwIfAborted();
      if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials ||
          typeof PublicKeyCredential.parseCreationOptionsFromJSON !== 'function' ||
          typeof PublicKeyCredential.prototype.toJSON !== 'function') phase = 'unsupported';
      view = { kind: 'invite', displayName: displayName ?? undefined, note: note ?? undefined };
    } catch {
      if (!signal.aborted) view = { kind: 'unavailable' };
    }
  }

  async function setup(displayName: string) {
    if (attempt) return;
    const current = attempt = new AbortController();
    const { signal } = current;
    phase = 'waiting';
    try {
      const issued = await post('challenge', {}, signal);
      signal.throwIfAborted();
      if (issued.status === 404) { view = { kind: 'dead-link' }; return; }
      if (issued.status === 429) {
        phase = 'rate-limited';
        retry = setTimeout(() => { phase = 'valid'; }, 60_000);
        return;
      }
      if (!issued.ok) throw new Error('Invite challenge unavailable');
      const { options } = await issued.json();
      // The edited name labels the device's passkey, not the server account.
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON({ ...options, user: { ...options.user, displayName } });
      const credential = await navigator.credentials.create({ publicKey, signal });
      signal.throwIfAborted();
      if (!(credential instanceof PublicKeyCredential)) { phase = 'cancelled'; return; }
      // A verification POST can commit even if its response is lost. Do not offer cancel after dispatch.
      committing = true;
      const redeemed = await post('enroll', { challenge: options.challenge, response: credential.toJSON() });
      if (attempt !== current) return;
      if (redeemed.status === 204) { window.location.replace('/sign-in'); return; }
      // A rejected ceremony does not tell us whether the invitation itself remains usable.
      view = { kind: 'unavailable' };
    } catch (error) {
      if (attempt !== current) return;
      if (!committing && (signal.aborted || (error instanceof DOMException && error.name === 'NotAllowedError'))) {
        phase = 'cancelled';
      } else view = { kind: 'unavailable' };
    } finally {
      if (attempt === current) { attempt = undefined; committing = false; }
    }
  }
</script>

<InviteAcceptance {view} {phase} onSetup={setup} cancellable={!committing} onCancel={() => { if (!committing) attempt?.abort(); }} />
