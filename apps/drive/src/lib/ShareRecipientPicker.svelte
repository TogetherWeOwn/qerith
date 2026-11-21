<script lang="ts">
  import { tick } from 'svelte';

  type Choice = { recipientId: string; displayName: string | null };
  // The caller supplies unique, eligible choices and owns the selection. No grants are written here.
  let { choices, selectedIds, onSelectionChange }: {
    choices: readonly Choice[];
    selectedIds: readonly string[];
    onSelectionChange: (ids: string[]) => void;
  } = $props();

  const id = $props.id();
  let input: HTMLInputElement;
  let query = $state('');
  let open = $state(false);
  let active = $state<string | null>(null);
  let announcement = $state('');
  const label = (choice: Choice) => choice.displayName?.trim() ? choice.displayName : 'Name unavailable';
  const picked = $derived(selectedIds.flatMap(key => choices.find(choice => choice.recipientId === key) ?? []));
  const search = $derived(query.trim().normalize().toLowerCase());
  const matchingNames = $derived(choices.filter(choice => !search || choice.displayName?.normalize().toLowerCase().includes(search)));
  const matches = $derived(matchingNames.filter(choice => !selectedIds.includes(choice.recipientId)));
  const expanded = $derived(open && matches.length > 0);
  const noMatch = $derived(open && !!search && !matches.length);
  const activeIndex = $derived(expanded ? matches.findIndex(choice => choice.recipientId === active) : -1);
  const optionId = (index: number) => `${id}-option-${index}`;

  function dismiss() {
    open = false;
    active = null;
  }

  function select(choice: Choice) {
    if (!expanded || !matches.includes(choice)) return;
    const next = [...picked.map(person => person.recipientId), choice.recipientId];
    announcement = `${label(choice)} selected. ${next.length} selected.`;
    onSelectionChange(next);
    query = '';
    dismiss();
  }

  function remove(choice: Choice) {
    input.focus();
    dismiss();
    announcement = `${label(choice)} removed. ${picked.length - 1} selected.`;
    onSelectionChange(picked.filter(person => person !== choice).map(person => person.recipientId));
  }

  async function keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape' && (expanded || noMatch)) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    } else if (event.key === 'Enter') {
      // Free text (even an exact match) is not a selection or form submission.
      event.preventDefault();
      if (activeIndex >= 0) select(matches[activeIndex]);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
      event.preventDefault();
      const index = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, matches.length - 1)
        : activeIndex < 0 ? matches.length - 1 : Math.max(activeIndex - 1, 0);
      open = true;
      active = matches[index].recipientId;
      await tick();
      if (activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
    }
  }

  function avatar(choice: Choice) {
    let hash = 0;
    for (const char of choice.recipientId) hash = (Math.imul(31, hash) + char.codePointAt(0)!) >>> 0;
    const initials = choice.displayName?.trim().split(/\s+/u).slice(0, 2)
      .map(word => Array.from(word)[0]?.toUpperCase()).join('');
    return { colour: `var(--drive-color-avatar-${hash % 12})`, initials };
  }
</script>

<div class="picker">
  <label for={id}>Add people</label>
  <div class="field">
    {#if picked.length}
      <ul class="chips" role="list" aria-label="Selected people">
        {#each picked as choice (choice.recipientId)}
          <li class="chip">
            <bdi>{label(choice)}</bdi>
            <button type="button" aria-label={`Remove ${label(choice)}`} onclick={() => remove(choice)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
    <input bind:this={input} bind:value={query} {id} role="combobox" autocomplete="off"
      aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-choices` : undefined}
      aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
      placeholder="Find someone by name" onfocus={() => open = true} onclick={() => open = true}
      oninput={() => { announcement = ''; active = null; open = true; }} onblur={dismiss} onkeydown={keydown} />
  </div>
  {#if expanded}
    <ul id={`${id}-choices`} role="listbox" aria-label="Available people" class="popover">
      {#each matches as choice, index (choice.recipientId)}
        {@const badge = avatar(choice)}
        <!-- svelte-ignore a11y_click_events_have_key_events (DOM focus stays on the combobox, which handles option keys) -->
        <li id={optionId(index)} role="option" aria-selected={index === activeIndex}
          onmousedown={event => event.preventDefault()} onclick={() => select(choice)}>
          <span class="avatar" style:background-color={badge.colour} aria-hidden="true">{badge.initials}</span>
          <bdi>{label(choice)}</bdi>
        </li>
      {/each}
    </ul>
  {/if}
  <div role="status" class:popover={noMatch} class:message={noMatch} class:visually-hidden={!noMatch}>
    {#if noMatch}{#if matchingNames.length}Matching people are already selected.{:else}Nobody called “<bdi>{query}</bdi>” is on this drive. The owner can invite them.{/if}{:else}{announcement}{/if}
  </div>
</div>

<style>
  .picker { position: relative; }
  label { display: block; margin-block-end: var(--drive-space-2); font-weight: var(--drive-font-weight-semibold); }
  .field {
    display: flex; align-items: center; flex-wrap: wrap; gap: var(--drive-space-1);
    padding-inline: var(--drive-space-inset-room); background: var(--drive-color-bg-canvas);
    border: var(--drive-size-line) solid var(--drive-color-line-control); border-radius: var(--drive-radius-m);
  }
  .field:hover { border-color: var(--drive-color-text-tertiary); }
  .field:has(input:focus-visible), button:focus-visible {
    outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring);
    outline-offset: var(--drive-size-focus-offset);
  }
  input {
    flex: 1 1 18ch; min-inline-size: 0; min-block-size: var(--drive-size-control-md);
    padding: 0; border: 0; outline: none; background: transparent; color: inherit;
    font: inherit; font-size: var(--drive-font-size-ui);
  }
  input::placeholder { color: var(--drive-color-text-tertiary); }
  .chips {
    display: flex; flex-wrap: wrap; gap: var(--drive-space-1); min-inline-size: 0;
    margin: 0; padding: 0; list-style: none;
  }
  .chip {
    display: inline-flex; align-items: center; max-inline-size: 100%; gap: var(--drive-space-1);
    padding-inline-start: var(--drive-space-3); border-radius: var(--drive-radius-pill);
    background: var(--drive-color-bg-raised); color: var(--drive-color-text-primary);
    border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong);
    font-size: var(--drive-font-size-small);
  }
  button {
    flex: none; inline-size: var(--drive-size-avatar-md); block-size: var(--drive-size-avatar-md);
    padding: 0; border: var(--drive-size-line) solid transparent; border-radius: var(--drive-radius-pill);
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  button:hover { background: var(--drive-color-bg-overlay); }
  .popover {
    position: absolute; z-index: 1; inset-inline: 0; margin: var(--drive-space-2) 0 0;
    padding: var(--drive-space-1); background: var(--drive-color-bg-overlay);
    border: var(--drive-size-line) solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m);
    max-block-size: min(calc(4 * var(--drive-size-row-dense)), 40dvh); overflow: auto;
  }
  .popover > li {
    display: flex; align-items: center; gap: var(--drive-space-3); cursor: pointer;
    min-block-size: var(--drive-size-avatar-lg); padding-inline: var(--drive-space-2);
    border-radius: var(--drive-radius-s); outline-offset: calc(-1 * var(--drive-size-focus-width));
  }
  .popover > li:hover { background: var(--drive-color-bg-raised); }
  .popover > li[aria-selected='true'] { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); }
  .avatar {
    flex: none; display: grid; place-items: center; inline-size: var(--drive-size-avatar-md);
    block-size: var(--drive-size-avatar-md); border-radius: var(--drive-radius-pill);
    color: var(--drive-color-avatar-text); font-size: var(--drive-font-size-label);
    font-weight: var(--drive-font-weight-semibold); overflow: hidden;
  }
  bdi { overflow-wrap: anywhere; }
  .message { padding: var(--drive-space-3); color: var(--drive-color-text-secondary); }
  .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
