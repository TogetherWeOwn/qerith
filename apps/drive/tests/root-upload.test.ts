import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadToRoot } from '../src/lib/root-upload';

const intent = () => Response.json({ id: 'opaque-intent' }, { status: 201 });
const part = () => new Response(null, { status: 204 });
const entryId = '12345678-aaaa-bbbb-cccc-123456789000';
const file = new File([new Uint8Array([0, 255, 12])], 'résumé 日本.bin');

function replies(...responses: Array<Response | Error>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (path, init) => {
    calls.push({ path: String(path), init });
    const response = responses.shift();
    if (!response || response instanceof Error) throw response ?? new Error('unexpected request');
    return response;
  };
  return { fetcher, calls };
}

test('posts one intent, the original file as part one, then the root destination', async () => {
  const { fetcher, calls } = replies(intent(), part(), Response.json({ id: entryId }, { status: 201 }));
  const milestones: number[] = [];
  assert.deepEqual(await uploadToRoot(file, () => milestones.push(calls.length), fetcher), { status: 'published', id: entryId });
  assert.deepEqual(milestones, [2]);
  assert.deepEqual(calls.map(({ path, init }) => [path, init?.method]), [
    ['/api/uploads', 'POST'], ['/api/uploads/opaque-intent/parts/1', 'PUT'], ['/api/uploads/opaque-intent/complete', 'POST'],
  ]);
  for (const { init } of calls) {
    assert.equal(init?.mode, 'same-origin');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).has('Content-Length'), false);
  }
  assert.equal(new Headers(calls[0].init?.headers).get('content-type'), 'application/json');
  assert.equal(calls[0].init?.body, '{"size":3}');
  assert.equal(calls[1].init?.body, file);
  assert.equal(new Headers(calls[2].init?.headers).get('content-type'), 'application/json');
  assert.equal(calls[2].init?.body, '{"parentId":null,"name":"résumé 日本.bin"}');
});

test('accepts zero bytes and the inclusive 16 MiB limit, but makes no request above that limit', async () => {
  const limit = 16 * 1024 * 1024;
  for (const size of [0, limit, limit + 1]) {
    const file = new File([new ArrayBuffer(size)], 'file.bin');
    const { fetcher, calls } = replies(intent(), part(), Response.json({ id: entryId }));
    const result = await uploadToRoot(file, () => {}, fetcher);
    assert.equal(result.status, size > limit ? 'interrupted' : 'published');
    assert.equal(calls.length, size > limit ? 0 : 3);
    if (size <= limit) assert.equal(calls[0].init?.body, JSON.stringify({ size }));
  }
});

test('only the explicit completion conflict is distinct; no failure is replayed', async () => {
  const conflict = () => Response.json({ code: 'name-taken' }, { status: 409 });
  for (const [responses, expected] of [
    [[conflict()], 'interrupted'],
    [[new Error('intent response lost')], 'interrupted'],
    [[Response.json({ id: '..' }, { status: 201 })], 'interrupted'],
    [[intent(), conflict()], 'interrupted'],
    [[intent(), new Error('part response lost')], 'interrupted'],
    [[intent(), part(), new Error('completion response lost')], 'interrupted'],
    [[intent(), part(), new Response(null, { status: 409 })], 'interrupted'],
    [[intent(), part(), Response.json({ code: 'name-taken' }, { status: 403 })], 'interrupted'],
    [[intent(), part(), Response.json({ id: '/not-an-entry' }, { status: 201 })], 'interrupted'],
    [[intent(), part(), conflict()], 'name-taken'],
  ] as const) {
    const { fetcher, calls } = replies(...responses);
    assert.deepEqual(await uploadToRoot(file, () => {}, fetcher), { status: expected });
    assert.equal(calls.length, responses.length);
  }
});
