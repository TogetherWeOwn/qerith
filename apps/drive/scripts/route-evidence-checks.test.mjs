import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { assessArrivalTrials, observeRouterClick, trials } from '../route-evidence/arrival-diagnostic.mjs';
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

test('the synthetic hook delays only delegated root click registration and releases it after speech', () => {
  for (const [mode, pathname, held] of [['held', '/f/denied', true], ['immediate', '/f/missing', false], ['held', '/f/populated', false]]) {
    const observed = [];
    class EventTarget {
      addEventListener(type, listener) { observed.push(listener); }
    }
    const root = new EventTarget();
    const window = {};
    window.top = window;
    const router = async event => event.composedPath()[0] instanceof SVGAElement;
    let now = 0;
    runInNewContext(`(${observeRouterClick})()`, {
      window, EventTarget, location: { pathname, href: `http://localhost${pathname}` },
      document: { documentElement: root, visibilityState: 'visible', hasFocus: () => true },
      sessionStorage: { getItem: () => mode }, performance: { now: () => ++now, timeOrigin: 1 }
    });
    const other = () => {};
    root.addEventListener('click', other);
    root.addEventListener('click', router);
    new EventTarget().addEventListener('click', router);
    root.addEventListener('submit', router);
    assert.deepEqual(observed, held ? [other, router, router] : [other, router, router, router]);
    const trace = window.finishRouteEvidenceArrival?.();
    if (held) assert.deepEqual(observed, [other, router, router, router]);
    if (trace) assert.equal(trace.registrations[0].attached > trace.windowClosed, held);
    else assert.equal(pathname, '/f/populated');
  }
});

test('the timing diagnosis requires separated phases and clickable to follow timing in both route orders', () => {
  const samples = trials.map((trial, i) => {
    const destination = `http://localhost/f/${trial.route}`;
    const immediate = trial.mode === 'immediate';
    return { ...trial, destination, errors: [], title: 'Folder unavailable Drive',
      arrival: immediate ? 'Folder unavailable Drive, document clickable' : 'Folder unavailable Drive, document',
      navigationStarted: 1, speechRead: 4, trace: { mode: trial.mode, url: destination, documentStart: i + 2,
        foreground: true, windowClosed: 3, registrations: [{ requested: 1, attached: immediate ? 2 : 4 }] } };
  });
  assert.equal(assessArrivalTrials(samples), 'clickable-follows-registration');
  for (const change of [
    copy => copy.pop(),
    copy => { copy[0].position = 1; },
    copy => { copy[2].trace.registrations[0].attached = 2; },
    copy => { copy[2].trace.registrations[0].requested = 4; },
    copy => { copy[2].trace.documentStart = copy[0].trace.documentStart; },
    copy => { copy[2].trace.url = copy[3].trace.url; },
    copy => { copy[2].title += ' different'; },
    copy => { copy[2].arrival += ' clickable'; },
    copy => { copy[0].arrival = copy[2].arrival; },
    copy => { copy[0].trace.foreground = false; },
  ]) {
    const copy = structuredClone(samples);
    change(copy);
    assert.equal(assessArrivalTrials(copy), 'inconclusive');
  }
});
