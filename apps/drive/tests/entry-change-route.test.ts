import assert from 'node:assert/strict';
import test from 'node:test';
import { entryChangeRequest } from '../src/lib/server/entry-change-route';

const origin = 'https://drive.example.test';
const path = '/api/entries/r%C3%A9sum%C3%A9';
const valid = '{"kind":"rename","name":"New name"}';
const headers = { origin, cookie: `__Host-drive-session=${'a'.repeat(43)}`, 'content-type': 'application/json' };
const DB = {
  prepare() { assert.fail('must not use raw DB'); },
  withSession() { assert.fail('rejected input must not open a DB session'); },
};
const fixture = { DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
const patch = (init?: RequestInit, url = origin + path) => new Request(url, { method: 'PATCH', body: valid, headers, ...init });

async function denied(pending: ReturnType<typeof entryChangeRequest>, status: number) {
  const response = await pending;
  assert.ok(response);
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), '');
  return response;
}

test('matches one exact entry URL and applies the fixture and mutation gates', async () => {
  for (const suffix of ['/', '/delete', '/read-grants']) {
    assert.equal(entryChangeRequest(patch(undefined, origin + path + suffix), fixture), undefined);
  }
  for (const invalid of [path + '?', path + '?q=x', '/api/entries/%ZZ', '/api/entries/%00',
    '/api/entries/%66oo', '/api/entries/' + 'a'.repeat(513)]) {
    await denied(entryChangeRequest(patch(undefined, origin + invalid), fixture), 404);
  }
  await denied(entryChangeRequest(patch(), { ...fixture, DRIVE_SIGN_IN_FIXTURE: '0' }), 404);
  const wrongMethod = await denied(entryChangeRequest(new Request(origin + path), fixture), 405);
  assert.equal(wrongMethod.headers.get('allow'), 'PATCH');
  for (const extra of [{ origin: '' }, { 'sec-fetch-site': 'same-site' }]) {
    await denied(entryChangeRequest(patch({ headers: { ...headers, ...extra } }), fixture), 403);
  }
  await denied(entryChangeRequest(patch({ headers: { ...headers, cookie: `${headers.cookie}; ${headers.cookie}` } }), fixture), 401);
});

test('rejects invalid commands and invalid or oversized JSON before dispatch', async () => {
  for (const body of ['[1]', '{', '{}', '{"kind":"delete"}', '{"kind":"rename"}', '{"kind":"move"}',
    '{"kind":"move","parentId":null,"name":null}', '{"kind":"move","parentId":null,"principalId":"other"}',
    ...['bad/name', ' ... ', 'é'.repeat(128)].map(name => JSON.stringify({ kind: 'rename', name })),
    ...[17, '', '\ud800', '💾'.repeat(129)].map(parentId => JSON.stringify({ kind: 'move', parentId })),
    new Uint8Array([0xff]), valid.padEnd(5121)]) {
    await denied(entryChangeRequest(patch({ body }), fixture), 400);
  }
  for (const extra of [{ 'content-length': '5121' }, { 'content-length': '42' },
    { 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) {
    await denied(entryChangeRequest(patch({ headers: { ...headers, ...extra } }), fixture), 400);
  }
});

test('rejects duplicate command fields before opening a D1 session', async () => {
  for (const body of [
    '{"kind":"rename","name":"First","name":"Second"}',
    '{"kind":"move","parentId":"folder","parentId":null}',
    String.raw`{"kind":"rename","ki\u006ed":"rename","name":"New name"}`,
  ]) {
    await denied(entryChangeRequest(patch({ body }), fixture), 400);
  }
});

test('accepts JSON string escapes and punctuation, and sanitizes unexpected D1 failures', async () => {
  const prepare = () => ({ bind() { return this; } });
  const failing = { ...DB, withSession() {
    return { prepare, async batch() { throw new Error('fixture-private failure'); } };
  } };
  const body = JSON.stringify({ kind: 'rename', name: 'Plan: ["draft"]' });
  await denied(entryChangeRequest(patch({ body }), { ...fixture, DB: failing }), 503);
});
