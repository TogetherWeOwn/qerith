import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadMultipartToRoot, uploadToRoot } from '../src/lib/root-upload';
import { MAX_PART_BYTES, MAX_PARTS, MIN_PART_BYTES } from '../src/lib/server/s3/multipart-completion';

const intentId = '87654321-dddd-eeee-ffff-123456789000';
const intent = () => Response.json({ id: intentId }, { status: 201 });
const part = () => new Response(null, { status: 204 });
const entryId = '12345678-aaaa-bbbb-cccc-123456789000';
const file = new File([new Uint8Array([0, 255, 12])], 'résumé 日本.bin');

function replies(...responses: Array<Response | Error | Promise<Response>>) {
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
    ['/api/uploads', 'POST'], [`/api/uploads/${intentId}/parts/1`, 'PUT'], [`/api/uploads/${intentId}/complete`, 'POST'],
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
    const milestones: number[] = [];
    assert.deepEqual(await uploadToRoot(file, () => milestones.push(calls.length), fetcher), { status: expected });
    assert.deepEqual(milestones, responses.length === 3 ? [2] : []);
    assert.equal(calls.length, responses.length);
  }
});

const fiveGiB = 5 * 1024 ** 3;
// Reuse one part-sized backing blob to model large files without allocating their contents.
const slab = new Blob([new Uint8Array(MAX_PART_BYTES)]);
function virtualFile(size: number) {
  const file = new File([], 'large.bin');
  const slices: [number, number][] = [];
  Object.defineProperty(file, 'size', { value: size });
  file.slice = (start = 0, end = size) => {
    slices.push([start, end]);
    return slab.slice(0, end - start);
  };
  file.arrayBuffer = () => { throw new Error('whole-file buffering'); };
  return { file, slices };
}

test('sends bounded slices for exact multiples, a short final part, and a virtual 5 GiB file', async () => {
  for (const [size, count] of [[2 * MAX_PART_BYTES, 2], [2 * MAX_PART_BYTES + 1, 3], [fiveGiB, 320]]) {
    const { file, slices } = virtualFile(size);
    const { fetcher, calls } = replies(intent(), ...Array.from({ length: count }, part), Response.json({ id: entryId }));
    const accepted: number[] = [];
    const result = await uploadMultipartToRoot(file, (bytes) => {
      accepted.push(bytes);
      assert.equal(slices.length, accepted.length);
      assert.equal(calls.length, accepted.length + 1);
    }, fetcher);
    assert.deepEqual(result, { status: 'published', id: entryId });
    assert.equal(calls.length, count + 2);
    assert.equal(slices.length, count);
    assert.ok(slices.length <= MAX_PARTS);
    assert.equal(calls[0].init?.body, JSON.stringify({ size }));
    for (let i = 0; i < count; i++) {
      const end = Math.min((i + 1) * MAX_PART_BYTES, size);
      assert.deepEqual(slices[i], [i * MAX_PART_BYTES, end]);
      assert.equal(accepted[i], end);
      const { path, init } = calls[i + 1];
      assert.equal(path, `/api/uploads/${intentId}/parts/${i + 1}`);
      assert.equal(init?.method, 'PUT');
      assert.ok(init.body instanceof Blob);
      assert.equal(init.body.size, end - i * MAX_PART_BYTES);
      if (i + 1 < count) assert.ok(init.body.size >= MIN_PART_BYTES);
    }
    assert.equal(calls.at(-1)?.path, `/api/uploads/${intentId}/complete`);
    assert.equal(calls.at(-1)?.init?.body, '{"parentId":null,"name":"large.bin"}');
  }
});

test('uploads one empty part for zero bytes and does not allocate above 5 GiB', async () => {
  const empty = new File([], 'empty.bin');
  const { fetcher, calls } = replies(intent(), part(), Response.json({ id: entryId }, { status: 201 }));
  const accepted: number[] = [];
  const onAccepted = (bytes: number) => accepted.push(bytes);
  assert.deepEqual(await uploadMultipartToRoot(virtualFile(fiveGiB + 1).file, onAccepted, fetcher), { status: 'interrupted' });
  assert.deepEqual(calls, []);
  assert.deepEqual(accepted, []);
  assert.deepEqual(await uploadMultipartToRoot(empty, onAccepted, fetcher), { status: 'published', id: entryId });
  assert.deepEqual(accepted, [0]);
  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/uploads', `/api/uploads/${intentId}/parts/1`, `/api/uploads/${intentId}/complete`,
  ]);
  assert.equal(calls[1].init?.body, empty);
});

test('waits for each part acknowledgment and stops without replay or completion on failure', async () => {
  for (const outcome of ['lost', 'wrong-status']) {
    const { file, slices } = virtualFile(3 * MAX_PART_BYTES);
    const second = Promise.withResolvers<Response>();
    const { fetcher, calls } = replies(intent(), part(), second.promise);
    const accepted: number[] = [];
    const transfer = uploadMultipartToRoot(file, (bytes) => accepted.push(bytes), fetcher);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expectedPaths = ['/api/uploads', `/api/uploads/${intentId}/parts/1`, `/api/uploads/${intentId}/parts/2`];
    assert.deepEqual(calls.map(({ path }) => path), expectedPaths);
    assert.equal(slices.length, 2);
    assert.deepEqual(accepted, [MAX_PART_BYTES]);
    if (outcome === 'lost') second.reject(new Error('second part response lost'));
    else second.resolve(new Response(null, { status: 200 }));
    assert.deepEqual(await transfer, { status: 'interrupted' });
    assert.deepEqual(calls.map(({ path }) => path), expectedPaths);
    assert.equal(slices.length, 2);
    assert.deepEqual(accepted, [MAX_PART_BYTES]);
  }
});
