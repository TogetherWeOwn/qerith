<script lang="ts">
  export let kind: 'folder' | 'folder-shared' | 'file' | 'image' | 'video' | 'audio' | 'document' | 'archive';
</script>

<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
  {#if kind === 'folder' || kind === 'folder-shared'}
    <path d="M3 19V5h6l2 2h10v12H3Z" />
    {#if kind === 'folder-shared'}<circle cx="15" cy="12" r="1.5" /><path d="M12 17c0-2 1.3-3 3-3s3 1 3 3" />{/if}
  {:else}
    <path d="M5 3h9l5 5v13H5V3Z M14 3v5h5" />
    {#if kind === 'image'}<circle cx="9" cy="11" r="1" /><path d="m7 18 4-4 2 2 1-1 3 3" />
    {:else if kind === 'video'}<path d="m10 11 5 3-5 3v-6Z" />
    {:else if kind === 'audio'}<path d="M13 11v5a2 2 0 1 1-1.75-2 M13 11l3-1" />
    {:else if kind === 'document'}<path d="M8 11h8 M8 14h8 M8 17h6" />
    {:else if kind === 'archive'}<path d="M11 10h2 M11 12h2 M11 14h2 M11 16h2 M12 18v1" />{/if}
  {/if}
</svg>

<style>
  svg { width: var(--drive-size-icon-md); height: var(--drive-size-icon-md); flex: none; color: var(--drive-color-text-secondary); }
  @media (forced-colors: active) { svg { color: CanvasText; } }
</style>
