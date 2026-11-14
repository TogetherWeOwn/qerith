<script>
  let activated = $state(false);
</script>

<main>
  <h1>Browser evidence fixture</h1>
  <button onclick={() => activated = true}>Activate fixture</button>
  <p role="status">{activated ? 'Activated' : 'Not activated'}</p>
</main>
