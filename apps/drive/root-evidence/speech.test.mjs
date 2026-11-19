import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { safeSpeech } from './speech.mjs';

const toolRequire = createRequire(new URL('../route-evidence/package.json', import.meta.url));

test('preserves raw unicode speech and rejects an entire record with an unsafe phrase', () => {
  const raw = ['Résumé 2026.pdf', 'link', ''];
  assert(safeSpeech(raw, ['fixture-proof']));
  assert.deepEqual(raw, ['Résumé 2026.pdf', 'link', '']);
  for (const phrase of ['fixture-proof', 'A'.repeat(43), 'C:\\work\\runner', 'https://example.test/', '<user>@example.test', 'a\0b', null]) {
    assert(!safeSpeech([...raw, phrase], ['fixture-proof']));
  }
});

test('the pinned Guidepup package exposes the keyboard inputs used in capture', () => {
  const { NVDAKeyCodeCommands: commands, WindowsKeyCodes: keys, WindowsModifiers: modifiers } = toolRequire('@guidepup/guidepup');
  for (const [table, names] of [
    [keys, ['Home', 'H', 'T', 'Down', 'Right', 'Tab', 'L', 'I', 'P']],
    [modifiers, ['Control', 'Alt']],
    [commands, ['readNextFocusableItem', 'toggleBetweenBrowseAndFocusMode', 'exitFocusMode']],
  ]) for (const name of names) assert.notEqual(table[name], undefined, name);
});
