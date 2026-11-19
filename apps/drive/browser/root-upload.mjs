import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function captureRootUpload(page, origin, holdResponse) {
  const name = 'Drive round-trip.bin';
  const buffer = Buffer.from(Uint8Array.from({ length: 8193 }, (_, i) => (i ^ (i >> 5)) & 255));
  const file = { name, buffer, mimeType: 'application/octet-stream' };
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const status = page.getByRole('status');
  const link = page.getByRole('link', { name, exact: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // Keep Chromium's async chooser interception enabled before either keypress.
  const keepChooserIntercepted = () => {};
  page.on('filechooser', keepChooserIntercepted);
  const choose = async () => {
    await upload.evaluate(button => {
      const activation = [];
      button.dataset.fixtureActivation = JSON.stringify(activation);
      const record = source => event => {
        activation.push([source, event.type, event.isTrusted, navigator.userActivation.isActive]);
        button.dataset.fixtureActivation = JSON.stringify(activation);
      };
      button.addEventListener('keydown', record('button'), { once: true });
      button.addEventListener('click', record('button'), { once: true });
      document.querySelector('input[type="file"]').addEventListener('click', record('input'), { once: true });
    });
    let chooser;
    try {
      [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.keyboard.press('Enter')]);
    } catch (cause) {
      const activation = await upload.getAttribute('data-fixture-activation');
      throw new Error(`Enter did not open the picker; activation: ${activation}; page errors: ${JSON.stringify(pageErrors)}`, { cause });
    }
    assert.equal(chooser.isMultiple(), false);
    await chooser.setFiles(file);
  };

  const deniedAssets = [];
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/_app/') && response.status() >= 400) deniedAssets.push([path, response.status()]);
  });
  await page.bringToFront();
  await page.goto(origin);
  await page.getByText('Your drive is empty.', { exact: true }).waitFor();
  try {
    await upload.and(page.locator('[aria-disabled="false"]')).waitFor({ timeout: 10_000 });
  } catch (cause) {
    throw new Error(`Root picker did not hydrate; denied assets: ${JSON.stringify(deniedAssets)}`, { cause });
  }
  assert.equal(await status.count(), 1);
  await page.keyboard.press('Tab');
  assert.equal(await upload.evaluate(el => document.hasFocus() && document.activeElement === el), true);

  const requests = [], responses = [];
  let documents = 0;
  page.on('request', request => {
    if (request.isNavigationRequest()) documents++;
    if (new URL(request.url()).pathname.startsWith('/api/uploads')) requests.push(request.method());
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/uploads') || path === '/__data.json') {
      responses.push([response.request().method(), response.status()]);
    }
  });

  const releaseCompletion = holdResponse(path => path.startsWith('/api/uploads/') && path.endsWith('/complete'));
  const releaseRefresh = holdResponse(path => path === '/__data.json');
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
    const refreshing = page.waitForRequest(request => new URL(request.url()).pathname === '/__data.json');
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

  await upload.focus();
  await choose();
  const conflict = `${name}: An item with this name already exists in My Drive.`;
  await page.getByText(conflict, { exact: true }).waitFor();
  assert.equal(await status.textContent(), conflict);
  assert.equal(await link.count(), 1);
  assert.deepEqual(requests, ['POST', 'PUT', 'POST', 'POST', 'PUT', 'POST']);
  assert.deepEqual(responses.slice(4), [['POST', 201], ['PUT', 204], ['POST', 409]], 'a conflict neither refreshes nor retries');
  await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'root-upload-round-trip.json'), JSON.stringify({
    keyboard: 'Tab then Enter opened the single-file picker', statusRegions: 1, focusPreserved: true,
    documentsDuringRefresh: 0, responses, bytes: downloaded.length,
    sha256: createHash('sha256').update(downloaded).digest('hex'), byteIdentical: true,
  }, null, 2));
  console.log('Generated My Drive upload: keyboard picker, one status, publication refresh, byte-identical download and explicit conflict passed');
}
