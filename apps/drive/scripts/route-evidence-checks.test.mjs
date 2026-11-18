import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeSpeech, unavailableHeadingSpeech, unavailableResponse, verifyManifest } from './route-evidence-checks.mjs';

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('accepts the current Drive manifest and lock root', () => {
  verifyManifest(readJson('package.json'), readJson('package-lock.json'));
});

test('rejects drift and non-registry specs without resolving dependencies', () => {
  const fixture = (spec, name = 'fixturedep') => [{ name: 'fixture', version: '1.0.0', dependencies: { [name]: spec } }, {
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { [name]: spec } },
      [`node_modules/${name}`]: {
        version: spec, resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${spec}.tgz`,
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
  for (const bad of [
    { resolved: 'https://example.invalid/fixture.tgz' }, { integrity: undefined },
    { integrity: `sha512-${'A'.repeat(85)}B==` }, { link: true },
  ]) {
    lock.packages['node_modules/fixturedep'] = { ...entry, ...bad };
    assert.throws(() => verifyManifest(manifest, lock), /Expected registry source and integrity/);
  }
  verifyManifest(...fixture('1.2.3-preview.0', '@scope/fixturedep'));
  assert.throws(() => verifyManifest(...fixture('1.2.3', '@scope/..')), /Expected a locked exact registry version/);
  for (const spec of [
    'file:./fixture', 'git+https://example.invalid/fixture', 'https://example.invalid/fixture.tgz', 'npm:fixture@1.2.3', '^1.2.3',
    '1.2.3-preview_build', '01.2.3', '1.2.3-preview..1', '1.2.3-preview.01', '9007199254740992.2.3',
  ]) {
    assert.throws(() => verifyManifest(...fixture(spec)), /Expected a locked exact registry version/);
  }
});

const generic = '<main>Folder unavailable</main>';
function responseEvidence({ status = 200, headers = [], contentType = 'text/html', body = generic, date = 'first', redirect = null } = {}) {
  return unavailableResponse({
    request: () => ({ redirectedFrom: () => redirect }),
    status: () => status,
    headersArray: async () => [['Content-Type', contentType], ['Date', date], ...headers].map(([name, value]) => ({ name, value })),
    body: async () => Buffer.from(body),
  });
}

test('unavailable responses ignore dates and name casing, not repeated header values, order or body', async () => {
  const headers = [['X-Fixture', 'a'], ['x-fixture', 'b']];
  const reference = await responseEvidence({ headers });
  assert.deepEqual(await responseEvidence({ date: 'second', headers: [['x-fixture', 'a'], ['X-FIXTURE', 'b']] }), reference);
  assert.notDeepEqual(await responseEvidence({ headers: [['x-fixture', 'a, b']] }), reference);
  assert.notDeepEqual(await responseEvidence({ headers: headers.toReversed() }), reference);
  assert.notDeepEqual(await responseEvidence({ headers, body: `${generic} extra` }), reference);
  for (const [variant, error] of [
    [{ status: 403 }, /generic unavailable document status/], [{ redirect: {} }, /Expected a direct/],
    [{ contentType: 'application/json' }, /HTML document/], [{ headers: [['content-type', 'text/html']] }, /HTML document/],
  ]) await assert.rejects(responseEvidence(variant), error);
  for (const marker of ['Synthetic title that must not leak', 'Project records']) {
    for (const variant of [{ body: marker }, { headers: [['x-fixture', marker]] }, { date: marker }]) {
      await assert.rejects(responseEvidence(variant), /contains a private fixture marker/);
    }
  }
});

test('unavailable responses require UTF-8 but compare body bytes, not decoded text', async () => {
  const body = Buffer.from('<main>Project records</main>', 'utf16le');
  await assert.rejects(responseEvidence({ body, contentType: 'text/html; charset=UTF-16LE' }), /UTF-8/i);
  await assert.rejects(responseEvidence({ body: Buffer.concat([Buffer.from([0xff, 0xfe]), body]) }), /UTF-8/i);
  await assert.rejects(responseEvidence({ body }), /without NUL/);
  const contentType = 'Text/HTML; charset="UTF-8"';
  assert.notDeepEqual(await responseEvidence({ contentType, body: String.fromCharCode(0xfeff) + generic }), await responseEvidence({ contentType }));
});

test('speech normalization ignores whitespace but preserves extra phrases', () => {
  const reference = normalizeSpeech(['Folder', 'unavailable']);
  assert.equal(normalizeSpeech(['  Folder\n unavailable  ']), reference);
  assert.notEqual(normalizeSpeech(['Folder unavailable', 'Extra phrase']), reference);
});

test('unavailable arrival requires the exact spoken level-1 heading', () => {
  const document = 'Folder unavailable Drive, document. main landmark,';
  const heading = "heading, level 1, This folder isn't available";
  assert.match(normalizeSpeech([document, `${heading}.`]), unavailableHeadingSpeech);
  for (const wrong of ['', `${heading} to guest accounts.`, heading.replace('level 1', 'level 2')]) {
    assert.doesNotMatch(normalizeSpeech([document, wrong]), unavailableHeadingSpeech);
  }
});
