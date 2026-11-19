import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function captureRootUpload(page, origin, holdResponse, failRefresh) {
  const listingPath = '/api/root-listing';
  const name = 'Drive round-trip.bin';
  const buffer = Buffer.from(Uint8Array.from({ length: 8193 }, (_, i) => (i ^ (i >> 5)) & 255));
  const file = { name, buffer, mimeType: 'application/octet-stream' };
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const status = page.getByRole('status');
  const link = page.getByRole('link', { name, exact: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // Keep interception armed; Playwright page evaluations would grant their own user gesture.
  page.on('filechooser', () => {});
  const cdp = await page.context().newCDPSession(page);
  async function inspect(expression) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    });
    assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
    return result.value;
  }
  const buttonSelector = 'main > header > button[type="button"]';
  const button = `document.querySelector(${JSON.stringify(buttonSelector)})`;
  const choose = async (selection = file) => {
    assert.equal(await inspect(`document.hasFocus() && document.activeElement === ${button}`), true);
    let chooser;
    try {
      [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.keyboard.press('Enter')]);
    } catch (cause) {
      throw new Error(`Enter did not open the picker; page errors: ${JSON.stringify(pageErrors)}`, { cause });
    }
    assert.equal(chooser.isMultiple(), false);
    await chooser.setFiles(selection);
  };

  const deniedAssets = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/_app/') && response.status() >= 400) deniedAssets.push([path, response.status()]);
  });
  await page.bringToFront();
  await page.goto(origin);
  try {
    await inspect(`new Promise((resolve, reject) => {
      const ready = () => ${button}?.getAttribute('aria-disabled') === 'false';
      if (ready()) return resolve(true);
      const observer = new MutationObserver(() => {
        if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Picker not ready')); }, 10_000);
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-disabled'] });
    })`);
  } catch (cause) {
    throw new Error(`Root picker did not hydrate; denied assets: ${JSON.stringify(deniedAssets)}`, { cause });
  }
  assert.equal(await inspect(`document.querySelector('main').textContent.includes('Your drive is empty.')`), true);
  assert.equal(await inspect(`document.querySelectorAll('[role="status"]').length`), 1);
  assert.equal(await inspect('navigator.userActivation.isActive'), false, 'no activation before Tab');
  await page.keyboard.press('Tab');

  const requests = [], responses = [];
  let documents = 0;
  page.on('request', request => {
    if (request.isNavigationRequest()) documents++;
    if (new URL(request.url()).pathname.startsWith('/api/uploads')) requests.push(request.method());
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/uploads') || path === listingPath) {
      responses.push([response.request().method(), response.status()]);
    }
  });

  const releaseCompletion = holdResponse(path => path.startsWith('/api/uploads/') && path.endsWith('/complete'));
  const releaseRefresh = holdResponse(path => path === listingPath);
  try {
    await choose();
    await page.getByText(`Uploading ${name} to My Drive.`, { exact: true }).waitFor();
    await page.waitForFunction(size => document.querySelector('progress')?.value === size, buffer.length);
    assert.equal(await status.textContent(), `Uploading ${name} to My Drive.`);
    assert.equal(await upload.getAttribute('aria-disabled'), 'true');
    assert.equal(await link.count(), 0, 'no row before acknowledged publication');
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await capture(page, 'uploading', width);
    }
    const refreshing = page.waitForRequest(request => new URL(request.url()).pathname === listingPath);
    releaseCompletion();
    await refreshing;
    await page.getByText(`${name}: Uploaded.`, { exact: true }).waitFor();
    assert.equal(await upload.getAttribute('aria-disabled'), 'false', 'publication unlocks the picker during refresh');
    assert.equal(await link.count(), 0, 'the server listing response is still held');
  } finally {
    releaseCompletion();
    releaseRefresh();
  }
  await link.waitFor();
  assert.equal(await status.count(), 1);
  assert.equal(await status.textContent(), `${name}: Uploaded.`);
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);
  assert.equal(documents, 0, 'listing refresh did not navigate the document');
  assert.deepEqual(requests, ['POST', 'PUT', 'POST'], 'upload was not replayed');
  assert.deepEqual(responses, [['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 200]]);
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await capture(page, 'uploaded', width);
  }

  assert.match(await link.getAttribute('href'), /^\/api\/download\/[0-9a-f-]{36}$/);
  const [download] = await Promise.all([page.waitForEvent('download'), link.press('Enter')]);
  assert.equal(download.suggestedFilename(), name);
  const downloaded = await readFile(await download.path());
  assert.deepEqual(downloaded, buffer);

  await inspect(`${button}.focus()`);
  const differentBytes = { ...file, buffer: Buffer.from('must not replace the original') };
  await choose(differentBytes);
  const conflict = `${name}: An item with this name already exists in My Drive.`;
  await page.getByText(conflict, { exact: true }).waitFor();
  assert.equal(await status.textContent(), conflict);
  assert.equal(await link.count(), 1);
  assert.deepEqual(requests, ['POST', 'PUT', 'POST', 'POST', 'PUT', 'POST']);
  assert.deepEqual(responses.slice(4), [['POST', 201], ['PUT', 204], ['POST', 409]], 'a conflict neither refreshes nor retries');
  const [original] = await Promise.all([page.waitForEvent('download'), link.press('Enter')]);
  assert.deepEqual(await readFile(await original.path()), buffer);

  await inspect(`${button}.focus()`);
  failRefresh();
  const interruptedRefresh = 'Second.bin: Uploaded. Refresh My Drive to see it.';
  await choose({ ...file, name: 'Second.bin' });
  await page.getByText(interruptedRefresh, { exact: true }).waitFor();
  assert.equal(await status.textContent(), interruptedRefresh);
  assert.equal(await inspect(`document.activeElement === ${button}`), true);
  assert.equal(await link.count(), 1, 'a failed refresh leaves the previous listing mounted');
  assert.deepEqual(requests.slice(6), ['POST', 'PUT', 'POST']);
  assert.deepEqual(responses.slice(7), [['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 503]]);

  await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'root-upload-round-trip.json'), JSON.stringify({
    keyboard: 'Tab then Enter opened the single-file picker', statusRegions: 1, focusPreserved: true,
    documentsDuringRefresh: 0, refresh503PreservedUpload: true, responses, bytes: downloaded.length,
    sha256: createHash('sha256').update(downloaded).digest('hex'), byteIdentical: true,
  }, null, 2));
  console.log('Generated My Drive upload: keyboard picker, one status, publication refresh, byte-identical download and explicit conflict passed');
}
