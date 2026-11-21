import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import guidepup from '@guidepup/guidepup';
import { normalizeSpeech, unavailableHeadingSpeech } from '../scripts/route-evidence-checks.mjs';

const unavailableTitle = /Folder unavailable.*Drive/i;
const arrivalPatterns = [/Folder unavailable\W+Drive, document\b/i, unavailableHeadingSpeech];
const { nvda, NVDAKeyCodeCommands: commands, WindowsKeyCodes: key, WindowsModifiers: modifier } = guidepup;
const start = () => nvda.start({ capture: 'initial', restoreUserScreenReader: false });
export const nvdaAssetVersion = nvda.version;

function speechRecorder(page, path) {
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
  async function unavailable(step, destination, trace = {}) {
    // Read the sole heading on arrival, without corrective focus or a second reading.
    const arrivalStep = `${step}: direct full navigation`;
    const phrases = await recordSpeech(arrivalStep, async () => {
      const { result } = await nvda.capture(async () => {
        if (trace.controlTitle) trace.control = await documentState(page);
        trace.navigationStarted = Date.now();
        return page.goto(destination).catch(error => error);
      }, { capture: true });
      trace.captureEnded = Date.now();
      if (result instanceof Error) throw result;
      assert(result && !result.request().redirectedFrom(), `${step}: expected a direct document response`);
      assert.equal(page.url(), destination);
    });
    trace.arrived = await documentState(page);
    const spokenTitle = await title(step, unavailableTitle);
    return [requireSpeech(arrivalStep, phrases, ...arrivalPatterns), spokenTitle];
  }
  return { browse, top, heading, tab, hear, title, follow, perform, unavailable };
}

function documentState(page) {
  return page.evaluate(() => ({ url: location.href, documentStart: performance.timeOrigin,
    foreground: document.hasFocus() && document.visibilityState === 'visible', ready: document.readyState }));
}

export async function captureFreshArrival(page, path, sample, inspectNVDA) {
  const { browse, top, title, unavailable } = speechRecorder(page, path);
  await start();
  try {
    const step = `Fresh ${sample.index + 1} ${sample.route}`;
    await browse(); await top();
    sample.screenReader = await inspectNVDA();
    sample.controlTitle = await title(`${step}: control`, /Route evidence self-check/i);
    sample.control = await documentState(page);
    assert(sample.control.foreground && sample.control.ready === 'complete', `${step}: control not ready in foreground`);
    [sample.arrival, sample.title] = await unavailable(step, sample.destination, sample);
    assert.equal(await page.getByRole('link').count(), 0, `${step}: expected a no-link fixture`);
  } finally {
    await nvda.stop();
  }
}

export async function captureSpeech(page, path, selfCheck) {
  const { browse, top, heading, tab, hear, title, follow, perform, unavailable } = speechRecorder(page, path);
  const origin = new URL(page.url()).origin;
  async function captureUnavailable(id) {
    await page.goto(`${origin}/f/populated`);
    await browse(); await top();
    return unavailable(id, `${origin}/f/${id}`);
  }
  await start();
  try {
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
    assert.deepEqual(await captureUnavailable('denied'), await captureUnavailable('missing'), 'Unavailable announcements differ');
  } finally {
    await nvda.stop();
  }
}
