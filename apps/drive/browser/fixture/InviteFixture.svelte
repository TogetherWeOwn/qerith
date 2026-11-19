<script>
  import InviteAcceptance from '../../src/lib/InviteAcceptance.svelte';

  const variant = new URLSearchParams(location.search).get('invite');
  const metadata = { inviter: 'Mora', displayName: 'Pell', note: 'Welcome to Drive!' };
  let state = $state(variant === 'dead-link' ? { kind: 'dead-link' }
    : variant === 'signed-in' ? { kind: 'signed-in', signedInName: 'Juno' }
    : variant === 'unnamed' ? { kind: 'valid' }
    : variant === 'long-note' ? { ...metadata, kind: 'valid', inviter: 'مورا', note: '<b>' + 'ع'.repeat(133) + '</b>' }
    : { ...metadata, kind: variant });

  function setup(name) {
    document.body.dataset.attempts = String(Number(document.body.dataset.attempts ?? 0) + 1);
    document.body.dataset.name = name;
    state = { ...state, kind: 'waiting' };
  }
</script>

<svelte:window onfixture-expire-invite={() => { state = { kind: 'dead-link' }; }} />
<InviteAcceptance {state} onSetup={setup} onCancel={() => { state = { ...state, kind: 'cancelled' }; }} />
