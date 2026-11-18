import assert from 'node:assert/strict';

// Each entry gets its own processes; neither route always occupies the first position.
export const routes = ['denied', 'missing', 'missing', 'denied'];

export function assertFreshArrivals(samples, origin) {
  assert.equal(samples.length, routes.length, 'Incomplete first-arrival schedule');
  const started = new Set();
  const profiles = new Set();
  const documentStarts = new Set();
  const reference = samples[0];
  for (const [index, sample] of samples.entries()) {
    const { route, screenReader, profile, control, controlTitle, arrived, navigationStarted, captureEnded } = sample;
    const step = `Fresh ${index + 1} ${routes[index]}`;
    assert.deepEqual(sample.errors, [], step);
    assert.equal(sample.index, index, step);
    assert.equal(route, routes[index], step);
    assert.equal(sample.reset, true, step);
    assert.equal(sample.stopped, true, step);
    assert(Number.isInteger(screenReader?.id) && screenReader.id > 0 && !started.has(screenReader.id), `${step}: NVDA instance was not fresh`);
    started.add(screenReader.id);
    assert.match(screenReader.configHash, /^[0-9a-f]{64}$/i, step);
    assert.equal(screenReader.configHash, reference.screenReader.configHash, `${step}: NVDA settings differ`);
    assert(profile && !profiles.has(profile), `${step}: Firefox profile was not fresh`);
    profiles.add(profile);
    assert(control?.foreground && control.ready === 'complete', `${step}: control not ready in foreground`);
    assert.equal(control.url, `${origin}/f/populated`, step);
    assert(controlTitle && controlTitle === reference.controlTitle, `${step}: control title speech differs`);
    assert(arrived?.foreground && arrived.ready === 'complete', `${step}: arrival not ready in foreground`);
    assert.equal(arrived.url, `${origin}/f/${route}`, step);
    assert([navigationStarted, control.documentStart, arrived.documentStart, captureEnded].every(Number.isFinite) &&
      control.documentStart < navigationStarted && navigationStarted <= arrived.documentStart && arrived.documentStart < captureEnded &&
      !documentStarts.has(arrived.documentStart), `${step}: not a new arrival document`);
    documentStarts.add(arrived.documentStart);
    assert(sample.arrival && sample.title, `${step}: missing separate arrival or title speech`);
    assert.equal(sample.arrival, reference.arrival, 'Unavailable announcements differ');
    assert.equal(sample.title, reference.title, 'Unavailable titles differ');
  }
}
