import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import guidepup from '@guidepup/guidepup';

const { nvda, NVDAKeyCodeCommands, WindowsKeyCodes: key, WindowsModifiers: modifier } = guidepup;

export async function captureSpeech(page, path, selfCheck) {
  const perform = (code, ...modifiers) => nvda.perform({ keyCode: [code], modifiers }, { capture: true });
  async function hear(step, action, ...expected) {
    await nvda.clearSpokenPhraseLog();
    let phrases;
    try {
      await action();
    } finally {
      phrases = [...await nvda.spokenPhraseLog()];
      await appendFile(path, JSON.stringify({ step, url: page.url(), phrases }) + '\n');
    }
    assert(phrases.some(phrase => phrase.trim()), `No NVDA speech: ${step}`);
    for (const pattern of expected) assert.match(phrases.join(' '), pattern, step);
  }
  const top = () => perform(key.Home, modifier.Control);
  async function startAt(url) {
    await page.goto(url);
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    // Restore Firefox browse mode after programmatic navigation (NVDA #5758).
    for (const name of ['readNextFocusableItem', 'toggleBetweenBrowseAndFocusMode', 'toggleBetweenBrowseAndFocusMode', 'exitFocusMode']) {
      await nvda.perform(NVDAKeyCodeCommands[name], { capture: false });
    }
    await top();
  }
  async function follow(step, url, announcement) {
    await hear(step, async () => {
      await Promise.all([page.waitForEvent('domcontentloaded'), perform(key.Enter)]);
      assert.match(page.url(), url);
    }, announcement);
  }
  await nvda.start({ capture: 'initial', restoreUserScreenReader: false });
  try {
    const origin = new URL(page.url()).origin;
    await startAt(`${origin}/${selfCheck ? '' : 'f/populated'}`);
    if (selfCheck) {
      await hear('Self-check: H', () => perform(key.H), /heading/i, /Route evidence self-check/i);
      await hear('Self-check: Tab', () => perform(key.Tab), /link/i, /Next document/i);
      await follow('Self-check: Enter (full document)', /\/next$/, /New document/i);
      return;
    }
    await hear('Populated: report title', () => nvda.perform(NVDAKeyCodeCommands.reportTitle), /Project records.*Drive/i);
    await hear('Populated: H', () => perform(key.H), /heading.*1|level 1.*heading/i, /Project records/i);
    await hear('Populated: L', () => perform(key.L), /list/i, /2 items/i);
    await hear('Populated: I (first item)', () => perform(key.I), /Archive notes/i, /link/i, /Folder/i);
    await hear('Populated: I (second item)', () => perform(key.I), /Quarterly report/i, /File/i);
    await perform(key.Home, modifier.Control);
    await hear('Populated: Tab to folder', () => perform(key.Tab), /Archive notes/i, /link/i);
    await follow('Folder link: Enter (full document)', /\/f\/archive$/, /Archive notes/i);
    await hear('Empty: H, level 1', () => perform(key.H), /heading/i, /Archive notes/i);
    await hear('EmptyFolder: H, level 2', () => perform(key.H), /heading/i, /This folder is empty/i);
    await startAt(`${origin}/f/populated`);
    await hear('Populated: Tab twice to Next page', async () => { await perform(key.Tab); await perform(key.Tab); }, /Next page/i, /link/i);
    await follow('Next page: Enter (full document)', /\/f\/populated\?page=/, /Project records|No more items/i);
    await hear('Past-end: P (paragraph)', () => perform(key.P), /No more items/i);
    await hear('Past-end: Tab', () => perform(key.Tab), /First page/i, /link/i);
    await follow('First page: Enter (full document)', /\/f\/populated\??$/, /Project records/i);
    await hear('First page: H', () => perform(key.H), /heading/i, /Project records/i);
    for (const id of ['denied', 'missing']) {
      await startAt(`${origin}/f/${id}`);
      await hear(`${id}: report title`, () => nvda.perform(NVDAKeyCodeCommands.reportTitle), /Folder unavailable.*Drive/i);
      await hear(`${id}: H`, () => perform(key.H), /heading/i, /This folder isn't available/i);
    }
  } finally {
    await nvda.stop();
  }
}
