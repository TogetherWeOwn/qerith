import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeSpeech, unavailableResponse, verifyManifest } from './route-evidence-checks.mjs';

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('accepts the current Drive manifest and lock root', () => {
  verifyManifest(readJson('package.json'), readJson('package-lock.json'));
});

test('rejects drift and non-registry specs without resolving dependencies', () => {
  const fixture = (spec) => [{ name: 'fixture', version: '1.0.0', dependencies: { fixturedep: spec } }, {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { fixturedep: spec } },
      'node_modules/fixturedep': {
        version: spec, resolved: `https://registry.npmjs.org/fixturedep/-/fixturedep-${spec}.tgz`,
        integrity: `sha512-${'A'.repeat(86)}==`,
      },
    },
  }];
  const [manifest, lock] = fixture('1.2.3');
  verifyManifest(manifest, lock);
  const [unversioned, unversionedLock] = fixture('1.2.3');
  delete unversioned.version;
  delete unversionedLock.packages[''].version;
  verifyManifest({ ...unversioned, private: true }, unversionedLock);
  assert.throws(() => verifyManifest(unversioned, lock), /Manifest\/lock drift: version/);
  assert.throws(() => verifyManifest({ ...manifest, dependencies: { fixturedep: '2.0.0' } }, lock), /Manifest\/lock drift/);
  assert.throws(() => verifyManifest({ ...manifest, overrides: {} }, lock), /Unsupported projection/);
  assert.throws(() => verifyManifest({}, { lockfileVersion: 1, packages: { '': [] } }), /Unsupported projection/);
  const entry = lock.packages['node_modules/fixturedep'];
  lock.packages['node_modules/fixturedep'] = { ...entry, version: '2.0.0' };
  assert.throws(() => verifyManifest(manifest, lock), /Expected a locked exact registry version/);
  for (const bad of [{ resolved: 'https://example.invalid/fixture.tgz' }, { integrity: undefined }, { link: true }]) {
    lock.packages['node_modules/fixturedep'] = { ...entry, ...bad };
    assert.throws(() => verifyManifest(manifest, lock), /Expected registry source and integrity/);
  }
  verifyManifest(...fixture('1.2.3-preview.0'));
  for (const spec of [
    'file:./fixture', 'git+https://example.invalid/fixture', 'https://example.invalid/fixture.tgz', 'npm:fixture@1.2.3', '^1.2.3',
    '1.2.3-preview_build', '01.2.3', '1.2.3-preview..1', '1.2.3-preview.01', '9007199254740992.2.3',
  ]) {
    assert.throws(() => verifyManifest(...fixture(spec)), /Expected a locked exact registry version/);
  }
});

const generic = '<main>Folder unavailable</main>';
function mockResponse({ status = 200, extra = {}, body = generic, date = 'first', redirect = null } = {}) {
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
  for (const status of [403, 500]) {
    await assert.rejects(unavailableResponse(mockResponse({ status })), /generic unavailable document status/);
  }
  for (const variant of [{ extra: { 'cache-control': 'no-store' } }, { body: `${generic} extra` }]) {
    assert.notDeepEqual(await unavailableResponse(mockResponse(variant)), reference);
  }
  await assert.rejects(unavailableResponse(mockResponse({ redirect: {} })), /Expected a direct/);
  await assert.rejects(unavailableResponse(mockResponse({ extra: { 'content-type': 'application/json' } })), /HTML document/);
  for (const marker of ['Synthetic title that must not leak', 'Project records']) {
    await assert.rejects(unavailableResponse(mockResponse({ body: marker })), /contains a private fixture marker/);
    await assert.rejects(unavailableResponse(mockResponse({ extra: { 'x-fixture': marker } })), /contains a private fixture marker/);
  }
});

test('speech normalization ignores whitespace but preserves extra phrases', () => {
  const reference = normalizeSpeech(['Folder', 'unavailable']);
  assert.equal(normalizeSpeech(['  Folder\n unavailable  ']), reference);
  assert.notEqual(normalizeSpeech(['Folder unavailable', 'Extra phrase']), reference);
});
