import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import guidepup from '@guidepup/guidepup';
import { normalizeSpeech } from '../scripts/route-evidence-checks.mjs';

const { nvda, NVDAKeyCodeCommands: commands, WindowsKeyCodes: key, WindowsModifiers: modifier } = guidepup;

export async function captureSpeech(page, path, selfCheck) {
  const perform = (code, ...modifiers) => nvda.perform({ keyCode: [code], modifiers }, { capture: true });
  async function hear(step, action, ...expected) {
    await nvda.clearSpokenPhraseLog();
    let phrases;
    try { await action(); }
    finally {
      phrases = [...await nvda.spokenPhraseLog()];
      await appendFile(path, JSON.stringify({ step, url: page.url(), phrases }) + '\n');
    }
    const speech = normalizeSpeech(phrases);
    assert(speech, `No NVDA speech: ${step}`);
    assert.doesNotMatch(speech, /Synthetic title that must not leak/i, step);
    for (const pattern of expected) assert.match(speech, pattern, step);
    return speech;
  }
  const top = () => perform(key.Home, modifier.Control);
  const heading = (step, label) => hear(`${step}: Control+Home`, top, /heading.*1|level 1.*heading/i, label);
  const title = (step, label) => hear(`${step}: report title`, () => nvda.perform(commands.reportTitle, { capture: true }), label);
  const tab = (step, label) => hear(`${step}: Tab`, () => perform(key.Tab), /link/i, label);
  async function browse() {
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    // Restore Firefox browse mode after programmatic navigation (NVDA #5758).
    for (const name of ['readNextFocusableItem', 'toggleBetweenBrowseAndFocusMode', 'toggleBetweenBrowseAndFocusMode', 'exitFocusMode']) {
      await nvda.perform(commands[name], { capture: false });
    }
  }
  async function follow(step, url, announcement) {
    await hear(`${step}: Enter (full document)`, async () => {
      await Promise.all([page.waitForEvent('domcontentloaded'), nvda.act({ capture: true })]);
      assert.match(page.url(), url);
    }, announcement);
  }
  const origin = new URL(page.url()).origin;
  await nvda.start({ capture: 'initial', restoreUserScreenReader: false });
  try {
    await browse();
    if (selfCheck) {
      await heading('Self-check', /Route evidence self-check/i);
      await tab('Self-check', /Next document/i);
      await follow('Self-check', /\/f\/next$/, /New document/i);
      return;
    }
    await title('Populated', /Project records.*Drive/i);
    await heading('Populated', /Project records/i);
    await hear('Populated: L', () => perform(key.L), /list/i, /2 items/i);
    await top();
    await hear('Populated: I (first item)', () => perform(key.I), /Archive notes/i, /link/i, /Folder/i);
    await hear('Populated: I (second item)', () => perform(key.I), /Quarterly report/i, /File/i);
    await top();
    await tab('Populated folder', /Archive notes/i);
    await follow('Folder link', /\/f\/archive$/, /Archive notes/i);
    await heading('Empty', /Archive notes/i);
    await hear('EmptyFolder: H', () => perform(key.H), /heading.*2|level 2.*heading/i, /This folder is empty/i);
    await page.goto(`${origin}/f/populated`);
    await browse(); await top();
    await tab('Populated folder', /Archive notes/i);
    await tab('Populated next page', /Next page/i);
    await follow('Next page', /\/f\/populated\?page=/, /Project records|No more items/i);
    await heading('Past-end', /Project records/i);
    await hear('Past-end: P', () => perform(key.P), /No more items/i);
    await tab('Past-end', /First page/i);
    await follow('First page', /\/f\/populated\??$/, /Project records/i);
    await heading('First page', /Project records/i);
    async function unavailable(id) {
      await page.goto(`${origin}/f/populated`);
      await browse(); await top();
      const arrival = await hear(`${id}: direct full navigation`, () => nvda.capture(() => page.goto(`${origin}/f/${id}`), { capture: true }), /Folder unavailable|This folder isn't available/i);
      await browse();
      return [arrival, await title(id, /Folder unavailable.*Drive/i), await heading(id, /This folder isn't available/i)];
    }
    assert.deepEqual(await unavailable('denied'), await unavailable('missing'), 'Unavailable announcements differ');
  } finally {
    await nvda.stop();
  }
}
