import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function captureRootUpload(page, origin) {
  const name = 'Drive round-trip.bin';
  const buffer = Buffer.from(Uint8Array.from({ length: 8193 }, (_, i) => (i ^ (i >> 5)) & 255));
  const file = { name, buffer, mimeType: 'application/octet-stream' };
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const status = page.getByRole('status');
  const link = page.getByRole('link', { name, exact: true });
  const choose = async () => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
    assert.equal(chooser.isMultiple(), false);
    await chooser.setFiles(file);
  };

  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByText('Your drive is empty.', { exact: true }).waitFor();
  assert.equal(await status.count(), 1);
  await page.keyboard.press('Tab');
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);

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

  const complete = `${origin}/api/uploads/*/complete`;
  const release = Promise.withResolvers();
  await page.route(complete, async route => { await release.promise; await route.fallback(); }, { times: 1 });
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
  } finally {
    release.resolve();
  }
  await link.waitFor();
  await page.getByText(`${name}: Uploaded.`, { exact: true }).waitFor();
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
