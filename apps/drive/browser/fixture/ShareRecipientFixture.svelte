<script lang="ts">
  import ShareRecipientPicker from '../../src/lib/ShareRecipientPicker.svelte';
  import '../../src/lib/tokens.css';

  const choices = ['Sam Mora', 'Zoë Chen', '<b>Riley & Co.</b>', 'ΟΣΑ', 'Mina Park', null]
    .map((displayName, index) => ({ recipientId: `fixture-choice-${index + 1}`, displayName }));
  let selectedIds = $state<string[]>([]);
  let submits = $state(0);
</script>

<main data-selection={JSON.stringify(selectedIds)} data-submits={submits}>
  <h1>Share recipient picker</h1>
  <form onsubmit={event => { event.preventDefault(); submits++; }}>
    <ShareRecipientPicker {choices} {selectedIds} onSelectionChange={ids => selectedIds = ids} />
    <button type="submit">Continue</button>
  </form>
</main>

<style>
  @font-face {
    font-family: 'Qerith Sans';
    src: url('../../src/lib/fonts/QerithSans-latin.woff2') format('woff2');
    font-weight: 200 900;
    font-stretch: 75% 125%;
  }
  :global(body) { margin: 0; background: var(--drive-color-bg-canvas); color: var(--drive-color-text-primary); font-family: var(--drive-font-ui); }
  main {
    max-inline-size: 36rem; margin: var(--drive-space-8) auto 0; padding: var(--drive-space-6);
    background: var(--drive-color-bg-surface); border-radius: var(--drive-radius-l);
  }
  h1 { margin: 0 0 var(--drive-space-5); font-size: var(--drive-font-size-h3); }
</style>
