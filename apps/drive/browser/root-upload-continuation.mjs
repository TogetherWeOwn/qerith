import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const intentId = '00000000-0000-4000-8000-000000000101';
const entryId = '00000000-0000-4000-8000-000000000102';
const freshId = '00000000-0000-4000-8000-000000000103';
const name = 'Re-picked.txt';
const partBytes = 16 * 1024 * 1024;
const file = buffer => ({ name, mimeType: 'text/plain', buffer });
const repicked = Buffer.alloc(partBytes + 1, 42);
repicked[partBytes] = 33; // The suffix hash must differ from the first byte's hash.
const prefix = repicked.subarray(0, partBytes);
const cases = [
  { label: 'acknowledged', bytes: repicked, parts: [prefix, repicked.subarray(partBytes)] },
  { label: 'empty', bytes: Buffer.alloc(0), parts: [] },
  { label: 'empty-acknowledged', bytes: Buffer.alloc(0), parts: [Buffer.alloc(0)] },
  { label: 'suffix', bytes: repicked, parts: [prefix] },
];
const allocate = '/api/uploads';
const resume = `${allocate}/${intentId}/resume`;
const part = (id, number = 1) => `${allocate}/${id}/parts/${number}`;
const complete = id => `${allocate}/${id}/complete`;
const destination = JSON.stringify({ parentId: null, name });
const number = value => value.toLocaleString('en-US');

export async function exerciseRootUploadContinuation(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', serviceWorkers: 'block' });
    const unexpected = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const dataRequest = url.pathname.startsWith('/api/') || url.pathname.endsWith('/__data.json');
      if (url.origin === origin && !dataRequest) return route.continue();
      unexpected.push(url.pathname);
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const requests = [], evidence = {};
      let projection, bound = false, interruptSuffix = false;
      await page.exposeFunction('fixtureUploadRequest', (method, path, body) => {
        requests.push([method, path, body]);
        if (method === 'GET' && path === resume) return [200, projection];
        if (method === 'POST' && path === allocate) return [201, { id: bound ? intentId : freshId }];
        if (method === 'PUT' && bound && path === part(intentId, 2)) return [interruptSuffix ? 503 : 204];
        if (method === 'PUT' && [part(intentId), part(freshId), part(freshId, 2)].includes(path)) return [204];
        if (method === 'POST' && [complete(intentId), complete(freshId)].includes(path)) return [201, { id: entryId }];
        throw new Error('Unexpected fixture upload request');
      });
      await page.addInitScript(candidate => {
        window.fixtureRootUpload = {
          intentId: new URLSearchParams(location.search).has('no-candidate') ? undefined : candidate,
          fetcher: async (path, { method, body }) => {
            const [status, json] = await window.fixtureUploadRequest(method, path, body instanceof Blob ? body.size : body ?? null);
            if (window.holdFixtureEvidence && path === `/api/uploads/${candidate}/resume`) {
              await new Promise(release => { window.releaseFixtureEvidence = release; });
            }
            if (status === 204 && path === `/api/uploads/${candidate}/parts/2`) {
              await new Promise(release => { window.releaseFixtureSuffix = release; });
            }
            if (path === `/api/uploads/${candidate}/complete`) {
              await new Promise(release => { window.releaseFixtureCompletion = release; });
            }
            return json === undefined ? new Response(null, { status }) : Response.json(json, { status });
          },
        };
      }, intentId);
      const url = `${origin}/?root-upload`;
      const fresh = page.getByRole('button', { name: 'Upload', exact: true });
      const continuation = page.getByRole('button', { name: 'Continue upload', exact: true });
      const status = page.getByRole('status');
      const progress = page.getByRole('progressbar', { name, exact: true });
      const refreshes = () => page.getByRole('main').getAttribute('data-refreshes');
      const assertState = async (message, accepted, total, value, count) => {
        await page.getByText(message, { exact: true }).waitFor();
        const bytes = `${number(accepted)} of ${number(total)} bytes · My Drive`;
        assert.equal(await page.getByText(bytes, { exact: true }).count(), 1);
        assert.deepEqual(await progress.evaluate(el => [el.value, el.max]), [value, total || 1]);
        assert.equal(await refreshes(), String(count));
        return { message, bytes, value, refreshes: count, requests: [...requests] };
      };
      const pick = async (button, selection) => {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.press('Enter')]);
        assert.equal(chooser.isMultiple(), false);
        if (selection === null) await chooser.element().dispatchEvent('cancel');
        await chooser.setFiles(selection ?? []);
      };

      await page.goto(`${url}&no-candidate`);
      await fresh.waitFor();
      assert.equal(await continuation.count(), 0);
      assert.deepEqual(requests, []);
      await page.goto(url);
      await continuation.waitFor();
      await page.keyboard.press('Tab');
      assert.equal(await fresh.evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.equal(await continuation.evaluate(el => el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid'), true);
      await pick(continuation, null);
      assert.equal(await progress.count(), 0);
      assert.equal(await status.textContent(), '');
      assert.equal(await refreshes(), '0');
      assert.deepEqual(requests, []);
      evidence.canceled = { requests: [], refreshes: 0 };

      for (const { label, bytes, parts } of cases) {
        if (label !== 'acknowledged') {
          await page.goto(url);
          await continuation.waitFor();
        }
        assert.deepEqual(requests, []);
        if (label === 'suffix') await page.evaluate(() => { window.holdFixtureEvidence = true; });
        projection = { declaredSize: bytes.length, parts: parts.map((part, index) => ({
          partNumber: index + 1, sizeBytes: part.length, sha256: createHash('sha256').update(part).digest('hex'),
        })) };
        await pick(continuation, file(bytes));
        const expected = [['GET', resume, null]];
        if (label === 'suffix') {
          await page.waitForFunction(() => typeof window.releaseFixtureEvidence === 'function');
          const pending = await assertState('Continuing upload…', 0, bytes.length, 0, 0);
          assert.equal(await page.getByText('Uploaded.', { exact: true }).count(), 0);
          assert.equal(await status.textContent(), `Continuing upload of ${name} to My Drive.`);
          assert.deepEqual(requests, expected);
          await page.evaluate(() => window.releaseFixtureEvidence());
          const refused = await assertState('Upload interrupted.', 0, bytes.length, 0, 0);
          assert.equal(await status.textContent(), `${name}: Upload interrupted.`);
          evidence[label] = { pending, refused };
        } else {
          if (!parts.length) expected.push(['PUT', part(intentId), 0]);
          expected.push(['POST', complete(intentId), destination]);
          await page.waitForFunction(() => typeof window.releaseFixtureCompletion === 'function');
          const pending = await assertState('Finishing upload…', bytes.length, bytes.length, bytes.length, 0);
          assert.equal(await page.getByText('Uploaded.', { exact: true }).count(), 0);
          assert.equal(await status.textContent(), `Continuing upload of ${name} to My Drive.`);
          assert.equal(await fresh.getAttribute('aria-disabled'), 'true');
          assert.equal(await continuation.getAttribute('aria-disabled'), 'true');
          assert.deepEqual(requests, expected);
          // Capture before releasing completion, including the zero-byte rail at 0/1.
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: resolve(output, `root-continuation-${label}-finishing-${width}.png`) });
          await page.evaluate(() => window.releaseFixtureCompletion());
          const published = await assertState('Uploaded.', bytes.length, bytes.length, bytes.length || 1, 1);
          assert.equal(await status.textContent(), `${name}: Uploaded.`);
          if (label === 'acknowledged') await page.screenshot({ path: resolve(output, `root-continuation-uploaded-${width}.png`) });
          evidence[label] = { pending, published };
        }
        assert.deepEqual(requests.splice(0), expected);
        if (label === 'suffix') {
          await pick(continuation, null);
          await assertState('Upload interrupted.', 0, bytes.length, 0, 0);
        }
      }

      await page.screenshot({ path: resolve(output, `root-continuation-suffix-interrupted-${width}.png`) });
      await page.evaluate(axe);
      const results = await page.evaluate(() => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      }));
      await writeFile(resolve(output, `axe-root-continuation-${width}.json`), JSON.stringify(results, null, 2));
      assert.deepEqual(results.violations, []);
      assert.deepEqual(requests, []); // No automatic retry or fresh allocation after refusal.

      // Same page and exact refused file: only a deliberate fresh click allocates.
      await pick(fresh, file(repicked));
      evidence.fresh = await assertState('Uploaded.', repicked.length, repicked.length, repicked.length, 1);
      assert.deepEqual(requests, [
        ['POST', allocate, JSON.stringify({ size: repicked.length })],
        ['PUT', part(freshId), partBytes],
        ['PUT', part(freshId, 2), 1],
        ['POST', complete(freshId), destination],
      ]);
      requests.length = 0;
      bound = interruptSuffix = true;
      const bytes = repicked.length;
      const sha256 = data => createHash('sha256').update(data).digest('hex');
      const expectedPartSha256s = sha256(prefix) + sha256(repicked.subarray(partBytes));
      projection = { declaredSize: bytes, parts: [{ partNumber: 1, sizeBytes: partBytes, sha256: sha256(prefix) }], expectedPartSha256s };
      const captureBound = async state => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: resolve(output, `root-bound-${state}-${width}.png`) });
        const report = await page.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        }));
        await writeFile(resolve(output, `axe-root-bound-${state}-${width}.json`), JSON.stringify(report, null, 2));
        assert.deepEqual(report.violations, []);
      };
      // The normal multipart picker starts with no injected candidate.
      await page.goto(`${url}&no-candidate`);
      await fresh.waitFor();
      assert.equal(await continuation.count(), 0);
      await page.evaluate(axe);
      await pick(fresh, file(repicked));
      const stopped = await assertState('Upload interrupted.', partBytes, bytes, partBytes, 0);
      assert.deepEqual(requests.splice(0), [
        ['POST', allocate, JSON.stringify({ size: bytes, expectedPartSha256s })],
        ['PUT', part(intentId), partBytes], ['PUT', part(intentId, 2), 1],
      ]);
      await captureBound('interrupted');
      await pick(continuation, null);
      assert.deepEqual(requests, []);
      assert.equal(await status.textContent(), `${name}: Upload interrupted.`);

      const wrong = Buffer.from(repicked);
      wrong[partBytes] ^= 1;
      await page.evaluate(() => { window.holdFixtureEvidence = true; });
      await pick(continuation, file(wrong));
      await page.waitForFunction(() => typeof window.releaseFixtureEvidence === 'function');
      await assertState('Continuing upload…', 0, bytes, 0, 0);
      await page.evaluate(() => { window.holdFixtureEvidence = false; window.releaseFixtureEvidence(); });
      const refused = await assertState('Upload interrupted.', 0, bytes, 0, 0);
      assert.deepEqual(requests.splice(0), [['GET', resume, null]]);
      await captureBound('mismatch');

      interruptSuffix = false;
      await pick(continuation, file(repicked));
      await page.waitForFunction(() => typeof window.releaseFixtureSuffix === 'function');
      const pending = await assertState('Continuing upload…', partBytes, bytes, partBytes, 0);
      assert.equal(await continuation.getAttribute('aria-disabled'), 'true');
      assert.deepEqual(requests, [['GET', resume, null], ['PUT', part(intentId, 2), 1]]);
      await captureBound('continuing');
      await page.evaluate(() => window.releaseFixtureSuffix());
      await page.waitForFunction(() => typeof window.releaseFixtureCompletion === 'function');
      const finishing = await assertState('Finishing upload…', bytes, bytes, bytes, 0);
      await captureBound('finishing');
      await page.evaluate(() => window.releaseFixtureCompletion());
      const published = await assertState('Uploaded.', bytes, bytes, bytes, 1);
      assert.equal(await continuation.count(), 0);
      assert.equal(await fresh.evaluate(el => el === document.activeElement), true);
      assert.equal(await status.textContent(), `${name}: Uploaded.`);
      assert.deepEqual(requests.splice(0), [
        ['GET', resume, null], ['PUT', part(intentId, 2), 1], ['POST', complete(intentId), destination],
      ]);
      await captureBound('uploaded');
      evidence.bound = { stopped, refused, pending, finishing, published };
      assert.deepEqual(unexpected, []);
      await writeFile(resolve(output, `root-continuation-${width}.json`), JSON.stringify(evidence, null, 2));
    } finally {
      await context.close();
    }
  }
}
