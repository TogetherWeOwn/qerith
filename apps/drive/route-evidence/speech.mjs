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
  async function unavailable(id) {
    await page.goto(`${origin}/f/populated`);
    await browse(); await top();
    const destination = `${origin}/f/${id}`;
    // Arrival already reads the sole heading. Control+Home can be silent when NVDA is already there.
    const arrival = await hear(`${id}: direct full navigation`, async () => {
      const { result } = await nvda.capture(() => page.goto(destination).catch(error => error), { capture: true });
      if (result instanceof Error) throw result;
      assert.equal(page.url(), destination);
    }, /Folder unavailable\W+Drive, document\b/i, /heading\W+level 1\W+This folder isn't available\b/i);
    return [arrival, await title(id, /Folder unavailable.*Drive/i)];
  }
  const compareUnavailable = async () => {
    assert.deepEqual(await unavailable('denied'), await unavailable('missing'), 'Unavailable announcements differ');
  };
  await nvda.start({ capture: 'initial', restoreUserScreenReader: false });
  try {
    if (selfCheck) {
      await compareUnavailable();
      await page.goto(`${origin}/f/populated`);
    }
    await browse();
    if (selfCheck) {
      await heading('Self-check', /Route evidence self-check/i);
      await tab('Self-check', /New document/i);
      await follow('Self-check', /\/f\/next$/, /New document\W*Drive, document\b/i);
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
    await follow('Folder link', /\/f\/archive$/, /Archive notes\W*Drive, document\b/i);
    await heading('Empty', /Archive notes/i);
    await hear('EmptyFolder: H', () => perform(key.H), /heading.*2|level 2.*heading/i, /This folder is empty/i);
    await page.goto(`${origin}/f/populated`);
    await browse(); await top();
    await tab('Populated folder', /Archive notes/i);
    await tab('Populated next page', /Next page/i);
    await follow('Next page', /\/f\/populated\?page=/, /Project records\W*Drive, document\b/i);
    await heading('Past-end', /Project records/i);
    await hear('Past-end: P', () => perform(key.P), /No more items/i);
    await tab('Past-end', /First page/i);
    await follow('First page', /\/f\/populated\??$/, /Project records\W*Drive, document\b/i);
    await heading('First page', /Project records/i);
    await compareUnavailable();
  } finally {
    await nvda.stop();
  }
}
