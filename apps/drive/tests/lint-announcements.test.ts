import assert from 'node:assert/strict';
import test from 'node:test';
import { lintAnnouncements } from '../scripts/lint-announcements.mjs';

test('rejects new explicit live regions and preserves native status semantics', () => {
  const lint = (source: string) => lintAnnouncements('src/lib/Example.svelte', source);
  assert.deepEqual(lint(`<!-- <p role="alert"> -->
    <form><output aria-live="off">15</output><progress value="1" max="2"></progress></form>`), []);
  assert.equal(lint(`{#if busy}<div\n role='alert'></div>{/if}
    {#snippet feedback()}<p aria-live={priority}></p>{/snippet}
    <div role="log region"></div><svelte:element this={tag} aria-live=polite></svelte:element>`).length, 4);
});

test('permits existing field feedback once at its ratcheted path', () => {
  const field = '<span id={`${id}-error`} role="alert" dir="auto">{invalid}</span>';
  assert.deepEqual(lintAnnouncements('src/lib/NameDialog.svelte', field), []);
  assert.equal(lintAnnouncements('src/lib/NameDialog.svelte', field + field).length, 1);
  assert.equal(lintAnnouncements('src/lib/Example.svelte', field).length, 1);
});
