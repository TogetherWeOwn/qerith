<script lang="ts" module>
  export type RowAction = 'Download' | 'Share' | 'Rename' | 'Move' | 'Details' | 'Delete';
  let nextMenuId = 0;
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import './tokens.css';
  export let name: string;
  export let file = true;
  export let owned = true;
  export let onAction: (action: RowAction) => void;
  // The listing owns row navigation and dialog/removal focus after selection.
  export let onTab: (direction: 'next' | 'previous') => void;

  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement;
  let layer: HTMLDialogElement;
  let open = false;
  let compact = false;
  let opening = 0;
  let menuId = '';
  onMount(() => {
    menuId = `row-actions-menu-${++nextMenuId}`;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (open && (target === document || (target instanceof Element && target.contains(trigger) && !menu.contains(target)))) {
        const restore = menu.contains(document.activeElement);
        close();
        if (restore) trigger.focus({ preventScroll: true });
      }
    };
    window.addEventListener('scroll', onScroll, true);
    return () => { close(); window.removeEventListener('scroll', onScroll, true); };
  });
  let menuLeft = 0;
  let menuTop = 0;
  $: displayName = name.trim() ? name : `${name} (Whitespace-only name)`;
  $: actions = (owned
    ? [...(file ? ['Download'] : []), 'Share', 'Rename', 'Move', 'Details', 'Delete']
    : [...(file ? ['Download'] : []), 'Details']) as RowAction[];

  async function show(last = false) {
    const request = ++opening;
    compact = window.matchMedia('(max-width: 820px)').matches;
    open = true;
    await tick();
    if (!open || !menu || request !== opening) return;
    if (compact) layer.showModal();
    else layer.showPopover();
    const rect = menu.getBoundingClientRect();
    const anchor = trigger.getBoundingClientRect();
    menuLeft = Math.max(0, Math.min(anchor.left, window.innerWidth - rect.width));
    const below = window.innerHeight - anchor.bottom;
    const above = anchor.top;
    menuTop = Math.max(0, Math.min(below >= rect.height || below >= above ? anchor.bottom : anchor.top - rect.height, window.innerHeight - rect.height));
    await tick();
    if (!open || request !== opening) return;
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items[last ? items.length - 1 : 0]?.focus();
  }

  function close(restore = false) {
    ++opening;
    if (layer?.open) layer.close();
    else if (layer?.matches(':popover-open')) layer.hidePopover();
    open = false;
    if (restore) trigger.focus();
  }

  function keydown(event: KeyboardEvent) {
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); close(); onTab(event.shiftKey ? 'previous' : 'next'); return; }
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      next = items.findIndex((item, i) => i > index && item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
      if (next < 0) next = items.findIndex(item => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
    }
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
  }

  function outside(event: PointerEvent) {
    if (open && !layer.contains(event.target as Node) && !trigger.contains(event.target as Node)) close();
  }

  function backdropClick(event: MouseEvent) {
    if (event.target === layer) close(true);
  }

  // A parent row can call this for its pointer-only context menu.
  export function openFromContextMenu(event: MouseEvent) {
    event.preventDefault();
    void show();
  }
</script>

<svelte:window onpointerdown={outside} onresize={() => { if (open) close(true); }} />
<div class="anchor">
  <button class="trigger" type="button" bind:this={trigger} aria-label={`Actions for ${displayName}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onclick={() => open ? close(true) : show()} onkeydown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); void show(event.key === 'ArrowUp'); } }}>
    <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="13" cy="8" r="1.2"/></svg>
  </button>
  {#if open}
    <dialog class="layer" bind:this={layer} popover={compact ? undefined : 'manual'} aria-label={`Actions for ${displayName}`} style:--menu-left={`${menuLeft}px`} style:--menu-top={`${menuTop}px`} oncancel={(event) => { event.preventDefault(); close(true); }} onclick={backdropClick}>
    <div class="menu" id={menuId} role="menu" aria-label={`Actions for ${displayName}`} tabindex="-1" bind:this={menu} onkeydown={keydown}>
      <div class="sheet-title" aria-hidden="true">{displayName}</div>
      {#each actions as action}
        {#if action === 'Delete'}<div class="separator" role="separator"></div>{/if}
        <button role="menuitem" type="button" class:danger={action === 'Delete'} tabindex="-1" onclick={() => { close(true); onAction(action); }}>
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d={action === 'Download' ? 'M8 2v8m-3-3 3 3 3-3M3 12v2h10v-2' : action === 'Share' ? 'M6 5 11 2m-5 9 5 3M5 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7-5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z' : action === 'Rename' ? 'M3 13l3-.5L13 5 11 3 3.5 10.5 3 13Z' : action === 'Move' ? 'M2 4h5l1 2h6v7H2V4Zm5 5h5m-2-2 2 2-2 2' : action === 'Details' ? 'M8 7v4m0-7v1M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z' : 'M3 4h10M6 4V2h4v2m2 0-.5 10h-7L4 4m2 2v6m4-6v6'}/></svg>
          {action}
        </button>
      {/each}
    </div>
    </dialog>
  {/if}
</div>

<style>
  .anchor { position: relative; display: inline-block; }
  button { font: inherit; color: var(--drive-color-text-primary); cursor: pointer; }
  button:focus-visible { outline: var(--drive-size-focus-width) solid var(--drive-color-focus-ring); outline-offset: var(--drive-size-focus-offset); }
  .trigger { display: grid; place-items: center; width: var(--drive-size-control-sm); height: var(--drive-size-control-sm); border: 1px solid var(--drive-color-line-control); border-radius: var(--drive-radius-pill); background: transparent; }
  svg { width: var(--drive-size-icon-sm); height: var(--drive-size-icon-sm); flex: none; }
  .trigger svg { fill: currentColor; }
  .layer { position: fixed; top: var(--menu-top); right: auto; bottom: auto; left: var(--menu-left); margin: 0; padding: 0; border: 0; overflow: visible; background: transparent; }
  .layer::backdrop { background: transparent; }
  .menu { box-sizing: border-box; max-height: 100dvh; max-width: 100vw; overflow-y: auto; min-width: var(--drive-size-menu-min); padding: var(--drive-space-1); border: 1px solid var(--drive-color-line-hairline-strong); border-radius: var(--drive-radius-m); background: var(--drive-color-bg-overlay); font-family: var(--drive-font-ui); }
  .menu button { display: flex; align-items: center; gap: var(--drive-space-3); width: 100%; min-height: var(--drive-size-control-nav); padding: 0 var(--drive-space-3); border: 0; border-radius: var(--drive-radius-s); text-align: left; background: transparent; }
  .menu button:hover, .menu button:focus-visible { background: var(--drive-color-bg-raised); }
  .menu button.danger { color: var(--drive-color-state-danger); }
  .separator { border-top: 1px solid var(--drive-color-line-hairline-strong); margin: var(--drive-space-1) 0; }
  .sheet-title { display: none; }
  @media (max-width: 820px) { .trigger { width: var(--drive-size-control-md); height: var(--drive-size-control-md); } .trigger svg { width: var(--drive-size-icon-md); height: var(--drive-size-icon-md); } .layer { inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; background: var(--drive-color-scrim-sheet); backdrop-filter: blur(var(--drive-elevation-blur)); } .menu { position: absolute; right: 0; bottom: 0; left: 0; width: 100%; min-width: 0; max-width: none; max-height: 90dvh; padding: var(--drive-space-4) var(--drive-space-4) calc(var(--drive-space-4) + env(safe-area-inset-bottom)); border-radius: var(--drive-radius-l) var(--drive-radius-l) 0 0; } .sheet-title { display: block; white-space: break-spaces; overflow-wrap: anywhere; color: var(--drive-color-text-primary); padding: var(--drive-space-3); font-weight: var(--drive-font-weight-semibold); } .menu button { min-height: var(--drive-size-sheet-row); } }
</style>
