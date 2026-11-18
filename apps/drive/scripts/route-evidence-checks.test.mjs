import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeSpeech, unavailableResponse, verifyManifest } from './route-evidence-checks.mjs';

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('accepts the current Drive manifest and lock root', () => {
  verifyManifest(readJson('package.json'), readJson('package-lock.json'));
});

test('rejects drift and non-registry specs without resolving dependencies', () => {
  const fixture = (spec) => [{ name: 'fixture', version: '1.0.0', dependencies: { fixtureDep: spec } }, {
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { fixtureDep: spec } },
      'node_modules/fixtureDep': { version: spec },
    },
  }];
  const [manifest, lock] = fixture('1.2.3');
  verifyManifest(manifest, lock);
  assert.throws(() => verifyManifest({ ...manifest, dependencies: { fixtureDep: '2.0.0' } }, lock), /Manifest\/lock drift/);
  assert.throws(() => verifyManifest({ ...manifest, overrides: {} }, lock), /Unsupported projection/);
  lock.packages['node_modules/fixtureDep'].version = '2.0.0';
  assert.throws(() => verifyManifest(manifest, lock), /Expected a locked exact registry version/);
  for (const spec of ['file:./fixture', 'git+https://example.invalid/fixture', 'https://example.invalid/fixture.tgz', 'npm:fixture@1.2.3', '^1.2.3']) {
    assert.throws(() => verifyManifest(...fixture(spec)), /Expected a locked exact registry version/);
  }
});

const generic = '<main>Folder unavailable</main>';
function mockResponse({ status = 404, extra = {}, body = generic, date = 'first', redirect = null } = {}) {
  return {
    request: () => ({ redirectedFrom: () => redirect }),
    status: () => status,
    allHeaders: async () => ({ 'content-type': 'text/html', date, ...extra }),
    text: async () => body,
  };
}

test('unavailable responses match across dates but not status, headers or body', async () => {
  const reference = await unavailableResponse(mockResponse());
  assert.deepEqual(await unavailableResponse(mockResponse({ date: 'second' })), reference);
  for (const variant of [{ status: 403 }, { extra: { 'cache-control': 'no-store' } }, { body: `${generic} extra` }]) {
    assert.notDeepEqual(await unavailableResponse(mockResponse(variant)), reference);
  }
  await assert.rejects(unavailableResponse(mockResponse({ redirect: {} })), /Expected a direct/);
  for (const body of ['Synthetic title that must not leak', 'Project records']) {
    await assert.rejects(unavailableResponse(mockResponse({ body })), /contains a private fixture marker/);
  }
});

test('speech normalization ignores whitespace but preserves extra phrases', () => {
  const reference = normalizeSpeech(['Folder', 'unavailable']);
  assert.equal(normalizeSpeech(['  Folder\n unavailable  ']), reference);
  assert.notEqual(normalizeSpeech(['Folder unavailable', 'Extra phrase']), reference);
});
