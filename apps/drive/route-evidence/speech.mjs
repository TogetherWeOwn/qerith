import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import guidepup from '@guidepup/guidepup';
import { normalizeSpeech, unavailableHeadingSpeech } from '../scripts/route-evidence-checks.mjs';
import { assessArrivalTrials, observeRouterClick, trials } from './arrival-diagnostic.mjs';

const { nvda, NVDAKeyCodeCommands: commands, WindowsKeyCodes: key, WindowsModifiers: modifier } = guidepup;

export async function captureSpeech(page, path, selfCheck) {
  const perform = (code, ...modifiers) => nvda.perform({ keyCode: [code], modifiers }, { capture: true });
  const record = data => appendFile(path, JSON.stringify(data) + '\n');
  async function recordSpeech(step, action) {
    await nvda.clearSpokenPhraseLog();
    let phrases;
    try { await action(); }
    finally {
      phrases = [...await nvda.spokenPhraseLog()];
      await record({ step, url: page.url(), phrases });
    }
    return phrases;
  }
  function requireSpeech(step, phrases, ...expected) {
    const speech = normalizeSpeech(phrases);
    assert(speech, `No NVDA speech: ${step}`);
    assert.doesNotMatch(speech, /Synthetic title that must not leak/i, step);
    for (const pattern of expected) assert.match(speech, pattern, step);
    return speech;
  }
  const hear = async (step, action, ...expected) => requireSpeech(step, await recordSpeech(step, action), ...expected);
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
  const unavailableTitle = /Folder unavailable.*Drive/i;
  const arrivalPatterns = [/Folder unavailable\W+Drive, document\b/i, unavailableHeadingSpeech];
  async function prepareArrival(mode) {
    await page.goto(`${origin}/f/populated`);
    if (mode) await page.evaluate(mode => sessionStorage.setItem('route-evidence-click', mode), mode);
    await browse(); await top();
  }
  async function navigateAndCapture(destination) {
    const { result } = await nvda.capture(() => page.goto(destination).catch(error => error), { capture: true });
    if (result instanceof Error) throw result;
    assert.equal(page.url(), destination);
  }
  async function unavailable(id) {
    await prepareArrival();
    // Arrival already reads the sole heading. Control+Home can be silent when NVDA is already there.
    const arrival = await hear(`${id}: direct full navigation`, () => navigateAndCapture(`${origin}/f/${id}`), ...arrivalPatterns);
    if (selfCheck) assert.equal(await page.getByRole('link').count(), 0, `${id}: expected a no-link fixture`);
    return [arrival, await title(id, unavailableTitle)];
  }
  const compareUnavailable = async () => {
    assert.deepEqual(await unavailable('denied'), await unavailable('missing'), 'Unavailable announcements differ');
  };
  async function diagnoseArrival() {
    await page.addInitScript(observeRouterClick);
    const samples = [];
    try {
      for (const trial of trials) {
        const { mode, route, pair } = trial;
        const step = `Timing ${pair} ${mode} ${route}`;
        const sample = { ...trial, destination: `${origin}/f/${route}`, errors: [] };
        samples.push(sample);
        await prepareArrival(mode);
        try {
          const phrases = await recordSpeech(`${step}: direct full navigation`, async () => {
            sample.navigationStarted = Date.now();
            await navigateAndCapture(sample.destination);
          });
          sample.speechRead = Date.now();
          sample.arrival = requireSpeech(step, phrases, ...arrivalPatterns);
        } catch (error) { sample.errors.push(error.message); }
        finally {
          // Read and persist raw arrival speech before releasing the listener on this document.
          try { sample.trace = await page.evaluate(() => window.finishRouteEvidenceArrival?.()); }
          catch (error) { sample.errors.push(error.message); }
        }
        try {
          sample.title = await title(step, unavailableTitle);
          assert.equal(await page.getByRole('link').count(), 0, `${step}: expected a no-link fixture`);
        } catch (error) { sample.errors.push(error.message); }
      }
    } finally {
      await record({ step: 'Synthetic timing diagnostic (not qualification)', finding: assessArrivalTrials(samples), samples });
    }
  }
  await nvda.start({ capture: 'initial', restoreUserScreenReader: false });
  try {
    if (selfCheck) {
      let ordinaryFailure;
      try { await compareUnavailable(); }
      catch (error) { ordinaryFailure = error; }
      try { await diagnoseArrival(); }
      finally { if (ordinaryFailure) throw ordinaryFailure; }
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
