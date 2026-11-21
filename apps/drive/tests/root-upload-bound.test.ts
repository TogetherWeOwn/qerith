import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { hashMultipartFile } from '../src/lib/multipart-upload-plan';
import { resumeBoundMultipartToRoot, uploadBoundMultipartToRoot, type UploadResumeCandidate } from '../src/lib/root-upload';

const id = '87654321-dddd-eeee-ffff-123456789000';
const candidate = id as UploadResumeCandidate; // Independently exercise resume with a previously retained ID.
const path = `/api/uploads/${id}`;
const publishedId = '12345678-aaaa-bbbb-cccc-123456789000';
const published = { status: 'published', id: publishedId };
const interrupted = { status: 'interrupted' };
const partBytes = 16 * 1024 ** 2;
const head = new Uint8Array(partBytes);
const two = new File([head, 'tail'], 'test.bin');
const empty = new File([], 'empty.bin');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const prefix = { partNumber: 1, sizeBytes: partBytes, sha256: digest(head) };
const tail = { partNumber: 2, sizeBytes: 4, sha256: digest('tail') };
const vector = prefix.sha256 + tail.sha256;
const evidence = { declaredSize: two.size, parts: [prefix], expectedPartSha256s: vector };
const ack = () => new Response(null, { status: 204 });
const allocated = () => Response.json({ id }, { status: 201 });
const complete = () => Response.json({ id: publishedId }, { status: 201 });

function transport(...replies: Array<Response | Error>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const milestones: number[][] = [];
  const retained: [UploadResumeCandidate, number][] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const reply = replies.shift();
    if (!reply || reply instanceof Error) throw reply ?? new Error('unexpected request');
    return reply;
  };
  const progress = (bytes: number) => milestones.push([bytes, calls.length]);
  return {
    calls, milestones, retained, urls: () => calls.map(({ url }) => url),
    fresh: (file: File) => uploadBoundMultipartToRoot(file, progress, (value) => retained.push([value, calls.length]), fetcher),
    resume: (file: File) => resumeBoundMultipartToRoot(candidate, file, progress, fetcher),
  };
}

function brokenJson(value: unknown, status: number): Response {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent) controller.error(new Error('reply body lost before EOF'));
      else controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      sent = true;
    },
  }), { status, headers: { 'content-type': 'application/json' } });
}

test('fresh hashing reads only sequential planned slices, including one empty slice', async () => {
  const file = new File([two], two.name);
  const slice = file.slice.bind(file), slices: number[][] = [];
  file.arrayBuffer = async () => { throw new Error('whole-file read'); };
  file.slice = (start = 0, end = file.size) => {
    slices.push([start, end]);
    return slice(start, end);
  };
  assert.equal(await hashMultipartFile(file), vector);
  assert.deepEqual(slices, [[0, partBytes], [partBytes, two.size]]);
  assert.equal(await hashMultipartFile(empty), digest(''));
});

test('fresh allocation sends the exact packed body and retains only the intent ID before any PUT', async () => {
  const run = transport(allocated(), ack(), ack(), complete());
  assert.deepEqual(await run.fresh(two), published);
  assert.deepEqual(run.urls(), ['/api/uploads', `${path}/parts/1`, `${path}/parts/2`, `${path}/complete`]);
  assert.equal(run.calls[0].init?.body, `{"size":${two.size},"expectedPartSha256s":"${vector}"}`);
  assert.deepEqual(run.retained, [[id, 1]]);
  assert.deepEqual(run.milestones, [[partBytes, 2], [two.size, 3]]);
});

test('invalid file size, short file read, denied allocation, or lost allocation reply cannot retain a candidate', async () => {
  const oversized = new File([], 'large.bin');
  Object.defineProperty(oversized, 'size', { value: 5 * 1024 ** 3 + 1 });
  const shortRead = new File(['a'], 'short.bin');
  shortRead.slice = () => new Blob();
  for (const file of [oversized, shortRead]) {
    const run = transport();
    assert.deepEqual(await run.fresh(file), interrupted);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.retained, []);
  }
  for (const reply of [Response.json({ id }, { status: 403 }), brokenJson({ id }, 201), Response.json({ id: 'not-a-uuid' }, { status: 201 })]) {
    const run = transport(reply);
    assert.deepEqual(await run.fresh(empty), interrupted);
    assert.deepEqual(run.urls(), ['/api/uploads']);
    assert.deepEqual(run.retained, []);
    assert.deepEqual(run.milestones, []);
  }
});

test('verified bound resume sends only the same-intent missing suffix and reports cumulative acknowledged bytes', async () => {
  const run = transport(Response.json(evidence), ack(), complete());
  assert.deepEqual(await run.resume(two), published);
  assert.deepEqual(run.urls(), [`${path}/resume`, `${path}/parts/2`, `${path}/complete`]);
  assert.deepEqual(run.calls.map(({ init }) => init?.method), ['GET', 'PUT', 'POST']);
  assert.equal(await (run.calls[1].init?.body as Blob).text(), 'tail');
  assert.equal(run.calls[2].init?.body, '{"parentId":null,"name":"test.bin"}');
  assert.deepEqual(run.milestones, [[partBytes, 1], [two.size, 2]]);
});

test('correct prefix with wrong suffix bytes, unbound or invalid evidence never reaches a PUT', async () => {
  const changed = new File([head, 'Tail'], two.name);
  for (const [file, response] of [
    [changed, Response.json(evidence)],
    [two, Response.json({ declaredSize: two.size, parts: [prefix, tail] })],
    [two, Response.json({ ...evidence, declaredSize: two.size - 1 })],
    [two, Response.json({ ...evidence, expectedPartSha256s: vector.toUpperCase() })],
    [two, Response.json({ ...evidence, expectedPartSha256s: prefix.sha256 })],
    [two, Response.json({ ...evidence, parts: [tail] })],
    [two, Response.json({ ...evidence, parts: [{ ...prefix, sizeBytes: partBytes - 1 }] })],
    [two, Response.json({ ...evidence, parts: [{ ...prefix, sha256: tail.sha256 }] })],
    [empty, Response.json({ declaredSize: 0, parts: [], expectedPartSha256s: tail.sha256 })],
    [two, brokenJson(evidence, 200)],
    [two, new Response(null, { status: 403 })],
  ] as const) {
    const run = transport(response);
    assert.deepEqual(await run.resume(file), interrupted);
    assert.deepEqual(run.urls(), [`${path}/resume`]);
    assert.deepEqual(run.milestones, []);
  }
});

test('resume stops after the first denied or lost part acknowledgement, with no replay or completion', async () => {
  for (const failure of [new Response(null, { status: 403 }), new Response(null, { status: 200 }), new Error('PUT reply lost')]) {
    const run = transport(Response.json({ ...evidence, parts: [] }), ack(), failure);
    assert.deepEqual(await run.resume(two), interrupted);
    assert.deepEqual(run.urls(), [`${path}/resume`, `${path}/parts/1`, `${path}/parts/2`]);
    assert.deepEqual(run.milestones, [[partBytes, 2]]);
  }
});

test('zero-byte allocation and continuation require the one empty slot acknowledgement', async () => {
  const fresh = transport(allocated(), ack(), complete());
  assert.deepEqual(await fresh.fresh(empty), published);
  assert.equal(fresh.calls[0].init?.body, `{"size":0,"expectedPartSha256s":"${digest('')}"}`);
  assert.equal((fresh.calls[1].init?.body as Blob).size, 0);
  assert.deepEqual(fresh.milestones, [[0, 2]]);

  for (const acknowledged of [false, true]) {
    const parts = acknowledged ? [{ partNumber: 1, sizeBytes: 0, sha256: digest('') }] : [];
    const run = transport(Response.json({ declaredSize: 0, parts, expectedPartSha256s: digest('') }),
      ...(acknowledged ? [] : [ack()]), brokenJson({ id: publishedId }, 201));
    assert.deepEqual(await run.resume(empty), interrupted);
    assert.deepEqual(run.urls(), [`${path}/resume`, ...(acknowledged ? [] : [`${path}/parts/1`]), `${path}/complete`]);
    assert.deepEqual(run.milestones, [[0, acknowledged ? 1 : 2]]);
    if (!acknowledged) assert.equal((run.calls[1].init?.body as Blob).size, 0);
  }
});
