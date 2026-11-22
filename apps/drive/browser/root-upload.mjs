import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function captureRootUpload(page, origin, holdResponse, failRefresh, db) {
  const listingPath = '/api/root-listing';
  const name = 'Drive round-trip.bin';
  const file = { name, mimeType: 'application/octet-stream', buffer: Buffer.from(Uint8Array.from({ length: 8193 }, (_, i) => (i ^ (i >> 5)) & 255)) };
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const regions = page.locator('[data-drive-announcements]');
  const status = regions.getByRole('status');
  const error = regions.locator('[aria-live="assertive"]');
  const link = page.getByRole('link', { name, exact: true });
  // Keep interception armed; Playwright page evaluations would grant their own user gesture.
  page.on('filechooser', () => {});
  const cdp = await page.context().newCDPSession(page);
  async function inspect(expression) {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    assert.equal(exceptionDetails, undefined, exceptionDetails?.exception?.description);
    return result.value;
  }
  const button = `document.querySelector('main > header > button[type="button"]')`;
  const choose = async (selection = file) => {
    if (selection !== file) await inspect(`${button}.focus()`);
    assert.equal(await inspect(`document.hasFocus() && document.activeElement === ${button}`), true);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.keyboard.press('Enter')]);
    assert.equal(chooser.isMultiple(), false);
    await chooser.setFiles(selection);
  };
  const atWidths = async run => {
    for (const [width, height] of widths) await page.setViewportSize({ width, height }).then(() => run(width));
  };
  const assertStatus = async (message, priority = 'polite') => {
    const [target, other] = priority === 'assertive' ? [error, status] : [status, error];
    await target.filter({ hasText: message }).waitFor();
    assert.deepEqual([await target.textContent(), await other.textContent()], [message, '']);
    assert.match(await target.ariaSnapshot(), /Upload|upload|My Drive/);
    const live = page.locator('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]');
    assert.equal(await live.filter({ hasText: message }).count(), 1);
  };
  await page.bringToFront();
  const invalid = await page.goto(`${origin}/?page=invalid`);
  assert.match(await invalid.text(), /data-drive-announcements=""><div role="status" aria-live="polite" aria-atomic="true"><\/div> <div aria-live="assertive" aria-atomic="true"><\/div>/);
  assert.equal(await upload.count(), 0);
  await page.goto(origin);
  await inspect(`(async () => {
    const deadline = performance.now() + 10000;
    while (${button}?.getAttribute('aria-disabled') !== 'false') {
      if (performance.now() >= deadline) throw new Error('Picker not ready');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
  assert.equal(await inspect(`document.querySelector('main').textContent.includes('Your drive is empty.')`), true);
  assert.equal(await inspect(`document.querySelectorAll('[role="status"]').length`), 1);
  assert.deepEqual(await inspect(`Array.from(document.querySelectorAll('[data-drive-announcements] [aria-live]'), el => el.textContent)`), ['', ''], 'hydration starts with empty regions');
  await inspect(`(() => {
    window.uploadAnnouncementChanges = [];
    new MutationObserver(records => {
      for (const region of new Set(records.map(record => record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target))) {
        if (region.textContent) window.uploadAnnouncementChanges.push([region.getAttribute('aria-live'), region.textContent]);
      }
    }).observe(document.querySelector('[data-drive-announcements]'), { childList: true, characterData: true, subtree: true });
  })()`);
  assert.equal(await inspect('navigator.userActivation.isActive'), false, 'no activation before Tab');
  await page.keyboard.press('Tab');
  const responses = [];
  let documents = 0, requests = 0;
  page.on('request', request => {
    if (request.isNavigationRequest()) documents++;
    if (new URL(request.url()).pathname.startsWith('/api/uploads')) requests++;
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/uploads') || path === listingPath) responses.push([response.request().method(), response.status()]);
  });
  const releaseCompletion = holdResponse(path => path.startsWith('/api/uploads/') && path.endsWith('/complete'));
  const releaseRefresh = holdResponse(path => path === listingPath);
  try {
    await choose();
    await page.waitForFunction(size => document.querySelector('progress')?.value === size, file.buffer.length);
    await assertStatus(`Uploading ${name} to My Drive.`);
    assert.equal(await page.getByRole('progressbar', { name, exact: true }).count(), 1);
    assert.equal(await upload.getAttribute('aria-disabled'), 'true');
    await atWidths(width => capture(page, 'uploading', width));
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await inspect('document.documentElement.scrollWidth <= innerWidth'), true);
    const grey = await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await capture(page, 'uploading-greyscale', 320, false);
    await grey.evaluate(el => el.remove());
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await capture(page, 'uploading-forced-colours', 320, false);
    await page.emulateMedia({ forcedColors: null, reducedMotion: null });
    const refreshing = page.waitForRequest(request => new URL(request.url()).pathname === listingPath);
    releaseCompletion();
    await refreshing;
    await assertStatus(`${name}: Uploaded.`);
    assert.equal(await upload.getAttribute('aria-disabled'), 'false', 'publication unlocks the picker during refresh');
    assert.equal(await link.count(), 0, 'the server listing response is still held');
  } finally {
    releaseCompletion();
    releaseRefresh();
  }
  await link.waitFor();
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);
  assert.equal(documents, 0, 'listing refresh did not navigate the document');
  assert.equal(requests, 3, 'upload was not replayed');
  await atWidths(width => capture(page, 'uploaded', width));
  assert.match(await link.getAttribute('href'), /^\/api\/download\/[0-9a-f-]{36}$/);
  const [download] = await Promise.all([page.waitForEvent('download'), link.press('Enter')]);
  assert.equal(download.suggestedFilename(), name);
  const downloaded = await readFile(await download.path());
  assert.deepEqual(downloaded, file.buffer);
  const conflict = `${name}: An item with this name already exists in My Drive.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await choose({ ...file, buffer: Buffer.from('must not replace the original') });
    await page.waitForFunction(({ conflict, attempt }) => window.uploadAnnouncementChanges.filter(([, text]) => text === conflict).length === attempt, { conflict, attempt });
    await assertStatus(conflict, 'assertive');
    assert.equal(requests, 3 + attempt * 3, 'a conflict does not retry');
  }
  const conflicts = await page.evaluate(conflict => window.uploadAnnouncementChanges.filter(([, text]) => text === conflict), conflict);
  assert.deepEqual(conflicts, [['assertive', conflict], ['assertive', conflict]]);
  const [original] = await Promise.all([page.waitForEvent('download'), link.press('Enter')]);
  assert.deepEqual(await readFile(await original.path()), file.buffer);
  failRefresh();
  await choose({ ...file, name: 'Second.bin' });
  await assertStatus('Second.bin: Uploaded. Refresh My Drive to see it.');
  assert.equal(await inspect(`document.activeElement === ${button}`), true);
  assert.equal(await link.count(), 1, 'a failed refresh leaves the previous listing mounted');
  assert.equal(requests, 12, 'a failed listing refresh does not replay the upload');
  const proof = {
    keyboard: 'Tab then Enter opened the single-file picker', statusRegions: 1, focusPreserved: true,
    documentsDuringRefresh: 0, refresh503PreservedUpload: true, responses: [...responses], bytes: downloaded.length,
    announcements: { startsAndReceipts: 'polite', conflicts, singleLiveSource: true, emptySSRAndHydration: true },
    sha256: createHash('sha256').update(downloaded).digest('hex'), byteIdentical: true,
  };

  await db.prepare(`WITH RECURSIVE pages(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM pages WHERE n < 99)
    INSERT INTO drive_entries (id, owner_id, name, kind)
    SELECT printf('00000000-0000-4000-8000-%012d', n), 'fixture-owner', printf('Folder %03d', n), 'folder' FROM pages`).run();
  await page.goto(origin);
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'false', 'main > header > button');
  const releaseDisplacement = holdResponse(path => path === listingPath);
  try {
    await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === listingPath),
      choose({ ...file, name: 'A.bin' })]);
    const folders = page.getByRole('link', { name: /^Folder \d{3}$/ });
    const folderCount = await folders.count();
    assert.equal(folderCount, 99);
    const next = page.getByRole('link', { name: 'Next page', exact: true });
    await atWidths(async width => {
      const step = async (key, control) => {
        await page.keyboard.press(key);
        assert.equal(await control.evaluate(el => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid' && el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
        }), true, `${key} reaches ${await control.textContent()} with a visible ring at ${width}px`);
      };
      await upload.focus();
      await step('Tab', folders.first());
      await step('Shift+Tab', upload);
      await step('Tab', folders.first());
      for (let index = 1; index < folderCount - 1; index++) await page.keyboard.press('Tab');
      await step('Tab', folders.last());
      await step('Tab', link);
      await step('Tab', next);
      await step('Shift+Tab', link);
      await step('Shift+Tab', folders.last());
    });
    await page.keyboard.press('Tab');
    assert.equal(await link.evaluate(el => document.activeElement === el), true);
  } finally { releaseDisplacement(); }
  await page.getByRole('link', { name: 'A.bin', exact: true }).waitFor();
  assert.equal(await link.count(), 0, 'the old download link moved to page two');
  assert.equal(await inspect(`document.activeElement === ${button}`), true, 'focus returns to Upload when the focused row leaves the page');
  await assertStatus('A.bin: Uploaded.');
  const [folderDocument] = await Promise.all([
    page.waitForNavigation({ timeout: 5_000 }),
    page.getByRole('link', { name: 'Folder 001', exact: true }).click(),
  ]);
  assert.equal(folderDocument?.url(), `${origin}/f/00000000-0000-4000-8000-000000000001`);
  assert.deepEqual([folderDocument.status(), folderDocument.headers()['cache-control']], [200, 'private, no-store']);
  await page.getByRole('heading', { name: 'Folder 001', exact: true }).waitFor();
  assert.deepEqual(await regions.locator('[aria-live]').allTextContents(), ['', ''], 'a routed document does not inherit upload feedback');
  await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'root-upload-round-trip.json'), JSON.stringify({
    ...proof, focusRestored: true, rootFolderDocumentNavigation: true,
  }, null, 2));
}
