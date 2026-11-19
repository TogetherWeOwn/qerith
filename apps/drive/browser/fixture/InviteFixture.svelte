<script>
  import InviteAcceptance from '../../src/lib/InviteAcceptance.svelte';

  const variant = new URLSearchParams(location.search).get('invite');
  const metadata = { kind: 'invite', inviter: 'Mora', displayName: 'Pell', note: 'Welcome to Drive!' };
  let view = $state(variant === 'dead-link' ? { kind: 'dead-link' }
    : variant === 'signed-in' ? { kind: 'signed-in', signedInName: 'Juno' }
    : variant === 'unnamed' ? { kind: 'invite' }
    : variant === 'long-note' ? { ...metadata, inviter: 'مورا', note: '<b>' + 'ع'.repeat(133) + '</b>', displayName: '🙂'.repeat(40) + '\nPell' }
    : metadata);
  let phase = $state(['waiting', 'cancelled', 'unsupported', 'rate-limited'].includes(variant) ? variant : 'valid');
  let finishSetup;

  async function setup(name) {
    document.body.dataset.attempts = String(Number(document.body.dataset.attempts ?? 0) + 1);
    document.body.dataset.name = name;
    if (variant === 'delayed') {
      await new Promise(resolve => { finishSetup = resolve; });
      if (phase === 'cancelled') return;
    }
    phase = 'waiting';
  }
</script>

<svelte:window onfixture-expire-invite={() => { view = { kind: 'dead-link' }; }}
  onfixture-refresh-user={() => { view = { kind: 'signed-in', signedInName: 'Sam' }; }}
  onfixture-finish-setup={() => finishSetup?.()} />
<InviteAcceptance {view} {phase} onSetup={setup} onCancel={() => { phase = 'cancelled'; finishSetup?.(); }} />
