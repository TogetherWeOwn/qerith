import assert from 'node:assert/strict';
import test from 'node:test';
import { handle } from '../src/hooks.server';

const origin = 'https://example.test';
const token = 'A'.repeat(43);
const cookie = `__Host-drive-session=${token}`;

function request(url: string, init?: RequestInit, configuredOrigin = origin, broken = false) {
  let lookups = 0;
  let resolved = false;
  const env = { DRIVE_ORIGIN: configuredOrigin, DB: { prepare: () => {
    lookups++;
    if (broken) throw new Error('database unavailable');
    return { bind: () => ({ first: async () => ({ id: 'member', role: 'member' }) }) };
  } } };
  const event = { request: new Request(url, init), locals: {}, platform: { env } };
  return handle({ event, resolve: async () => {
    resolved = true;
    return new Response('resolved', { headers: { 'cache-control': 'public, max-age=60' } });
  } } as unknown as Parameters<typeof handle>[0]).then((response) => ({ response, lookups, resolved, event }));
}

for (const value of ['', 'http://example.test', `${origin}/`, 'invalid']) {
  test(`invalid trusted origin (${value || 'empty'}) fails closed`, async () => {
    const result = await request(`${origin}/private`, { headers: { cookie } }, value);
    assert.equal(result.response.status, 503);
    assert.equal(result.lookups, 0);
    assert.equal(result.resolved, false);
  });
}

test('wrong destination and unsafe methods without the exact Origin are denied before D1', async () => {
  const requests: [string, RequestInit][] = [
    ['https://alias.test/private', { headers: { cookie } }],
    [`${origin}/private`, { method: 'PUT', headers: { cookie } }],
    [`${origin}/private`, { method: 'POST', headers: { origin: 'https://other.example.test', cookie } }],
    [`${origin}/private`, { method: 'DELETE', headers: { origin: 'null', cookie } }]
  ];
  for (const [url, init] of requests) {
    const result = await request(url, init);
    assert.equal(result.response.status, 403);
    assert.equal(result.lookups, 0);
    assert.equal(result.resolved, false);
  }
});

test('absent, malformed and ambiguous session cookies never resolve a route', async () => {
  for (const value of ['', `${cookie}%00`, `${cookie}; ${cookie}`, `drive-session=${token}`]) {
    const result = await request(`${origin}/private`, { headers: { cookie: value } });
    assert.equal(result.response.status, 401);
    assert.equal(result.lookups, 0);
    assert.equal(result.resolved, false);
  }
});

test('same-origin authenticated requests resolve with a private, non-cacheable response', async () => {
  for (const method of ['GET', 'POST']) {
    const result = await request(`${origin}/private`, { method, headers: { origin, cookie } });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.lookups, 1);
    assert.deepEqual(result.event.locals, { driveSession: { token, principal: { id: 'member', role: 'member' } } });
  }
});

test('database failure is unavailable and never reaches the private route', async () => {
  const result = await request(`${origin}/private`, { headers: { cookie } }, origin, true);
  assert.equal(result.response.status, 503);
  assert.equal(await result.response.text(), '');
  assert.equal(result.resolved, false);
});
