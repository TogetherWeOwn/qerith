import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resumeMultipartToRoot } from '../src/lib/root-upload';

const partBytes = 16 * 1024 ** 2;
const candidate = '87654321-dddd-eeee-ffff-123456789000';
const published = { status: 'published', id: '12345678-aaaa-bbbb-cccc-123456789000' };
const interrupted = { status: 'interrupted' };
const path = `/api/uploads/${candidate}`;
const head = new Blob([new Uint8Array(partBytes)]);
const file = new File([head, 'tail'], 'résumé.bin', { lastModified: 19 });
const empty = new File([], 'empty.bin');
const part = (number: number, bytes: Uint8Array | string) => ({
  partNumber: number, sizeBytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'),
});
const prefix = part(1, new Uint8Array(partBytes));
const evidence = () => Response.json({ declaredSize: file.size, parts: [prefix, part(2, 'tail')] });
const emptyEvidence = (acknowledged: boolean) => Response.json({ declaredSize: 0, parts: acknowledged ? [part(1, '')] : [] });
const ack = () => new Response(null, { status: 204 });
const complete = (status = 201) => Response.json({ id: published.id }, { status });

function transfer(file: File, replies: Array<Response | Error | Promise<Response>>, id = candidate) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const milestones: number[][] = [];
  const result = resumeMultipartToRoot(id, file, (bytes) => milestones.push([bytes, calls.length]), async (input, init) => {
    calls.push({ path: String(input), init });
    const reply = replies.shift();
    if (!reply || reply instanceof Error) throw reply ?? new Error('unexpected request');
    return reply;
  });
  return { result, calls, milestones, paths: () => calls.map(({ path }) => path) };
}

test('a verified full prefix reports accepted bytes and completes without resending any part', async () => {
  for (const status of [201, 200]) {
    const run = transfer(file, [evidence(), complete(status)]);
    assert.deepEqual(await run.result, published);
    assert.deepEqual(run.milestones, [[file.size, 1]]);
    assert.deepEqual(run.paths(), [`${path}/resume`, `${path}/complete`]);
    const [get, post] = run.calls.map(({ init }) => init);
    assert.equal(get?.method, 'GET');
    assert.equal(get?.body, undefined);
    assert.equal(post?.method, 'POST');
    assert.equal(post?.body, '{"parentId":null,"name":"résumé.bin"}');
    for (const init of [get, post]) {
      assert.equal(init?.mode, 'same-origin');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).has('content-length'), false);
    }
  }
});

test('nonempty suffix stays read-only even with a correct prefix', async () => {
  for (const parts of [[], [prefix]]) {
    const run = transfer(file, [Response.json({ declaredSize: file.size, parts })]);
    assert.deepEqual(await run.result, interrupted);
    assert.deepEqual(run.paths(), [`${path}/resume`]);
    assert.deepEqual(run.milestones, []);
  }
});

test('changed final bytes are rejected even with identical name, size and mtime', async () => {
  const changed = new File([head, 'Tail'], file.name, { lastModified: file.lastModified });
  const run = transfer(changed, [evidence()]);
  assert.deepEqual(await run.result, interrupted);
  assert.deepEqual(run.paths(), [`${path}/resume`]);
  assert.deepEqual(run.milestones, []);
});

test('an acknowledged zero-byte part skips PUT; no parts requires one acknowledged empty PUT', async () => {
  for (const acknowledged of [true, false]) {
    const run = transfer(empty, [emptyEvidence(acknowledged), ...(acknowledged ? [] : [ack()]), complete()]);
    assert.deepEqual(await run.result, published);
    assert.deepEqual(run.paths(), [`${path}/resume`, ...(acknowledged ? [] : [`${path}/parts/1`]), `${path}/complete`]);
    assert.deepEqual(run.milestones, [[0, acknowledged ? 1 : 2]]);
    if (!acknowledged) {
      assert.equal(run.calls[1].init?.body, empty);
      assert.equal(run.calls[1].init?.method, 'PUT');
    }
  }
});

test('waits for the empty suffix acknowledgment and never retries an interrupted PUT', async () => {
  for (const outcome of ['lost', 404, 409, 200]) {
    const put = Promise.withResolvers<Response>();
    const run = transfer(empty, [emptyEvidence(false), put.promise]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(run.paths(), [`${path}/resume`, `${path}/parts/1`]);
    assert.deepEqual(run.milestones, []);
    if (outcome === 'lost') put.reject(new Error('PUT acknowledgment lost'));
    else put.resolve(new Response(null, { status: outcome }));
    assert.deepEqual(await run.result, interrupted);
    assert.deepEqual(run.paths(), [`${path}/resume`, `${path}/parts/1`]);
    assert.deepEqual(run.milestones, []);
  }
});

test('denied, lost, malformed, or oversized evidence never causes progress or a write', async () => {
  const options = { headers: { 'content-type': 'application/json' } };
  for (const response of [
    ...[401, 403, 404, 503].map((status) => new Response(null, { status })),
    new Error('evidence unavailable'), new Response('{', options), new Response(new Uint8Array([0xff]), options),
    new Response('{"declaredSize":0,"parts":[]}' + ' '.repeat(64 * 1024), options),
    new Response('{"declaredSize":0,"parts":[]}'), Response.json({ declaredSize: 1, parts: [] }),
    Response.json({ declaredSize: 0, parts: [{ ...part(1, ''), partNumber: 2 }] }),
  ]) {
    const run = transfer(empty, [response]);
    assert.deepEqual(await run.result, interrupted);
    assert.deepEqual(run.paths(), [`${path}/resume`]);
    assert.deepEqual(run.milestones, []);
  }
});

test('rejects invalid candidates and oversized files locally, and bounds the destination before PUT', async () => {
  const oversized = new File([], 'large.bin');
  Object.defineProperty(oversized, 'size', { value: 5 * 1024 ** 3 + 1 });
  for (const run of [transfer(oversized, []), transfer(empty, [], 'not/a-candidate'), transfer(empty, [], candidate.toUpperCase())]) {
    assert.deepEqual(await run.result, interrupted);
    assert.deepEqual(run.paths(), []);
  }
  const run = transfer(new File([], '界'.repeat(1500)), [emptyEvidence(false)]);
  assert.deepEqual(await run.result, interrupted);
  assert.deepEqual(run.paths(), [`${path}/resume`]);
});

test('completion failures are not retried; only the explicit conflict is name-taken', async () => {
  for (const [response, expected] of [
    [new Error('completion acknowledgment lost'), interrupted],
    [new Response(null, { status: 404 }), interrupted],
    [new Response(null, { status: 409 }), interrupted],
    [Response.json({ id: 'invalid' }), interrupted],
    [Response.json({ code: 'name-taken' }, { status: 409 }), { status: 'name-taken' }],
  ] as const) {
    const run = transfer(empty, [emptyEvidence(true), response]);
    assert.deepEqual(await run.result, expected);
    assert.deepEqual(run.paths(), [`${path}/resume`, `${path}/complete`]);
  }
});
