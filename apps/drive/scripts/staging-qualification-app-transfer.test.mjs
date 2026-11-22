import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test as nodeTest } from 'node:test';
import { exerciseQualificationLargeTransfer, exerciseQualificationResume, exerciseQualificationResumeFixture } from './staging-qualification-app-transfer.mjs';
import { readinessHeaders, readinessPath } from '../src/lib/server/qualification-readiness.ts';

const test = import.meta.main ? nodeTest : () => {};

const MiB = 1024 ** 2, partBytes = 16 * MiB, resumeBytes = 65 * partBytes + 257;
const context = { sha: 'a'.repeat(40), version: 'e75999e9-d97b-4ae6-b592-c56580bd2ac3', runId: '123', attempt: '2',
  prefix: 'drive-qualification/full-v0/123/2/' };
const intent = 'cb37853a-04d3-462e-98c4-9f55b852880d', file = 'aaf9b9d0-21e4-4a2c-b38e-ac1b338888f1';
const member = '00000000-0000-4000-8000-000000000004', revokedMember = '00000000-0000-4000-8000-000000000003';
const upload = `/api/uploads/${intent}`;
const active = () => new AbortController().signal;

const ready = (scope, headers) => new Response(null, { status: 204, headers: {
  'cache-control': 'private, no-store', [readinessHeaders.nonce]: headers[readinessHeaders.nonce],
  [readinessHeaders.sha]: scope.sha, [readinessHeaders.version]: scope.version,
} });

export function fixture({ resume = false, small = false, fault, controller, lostAckPart = 1, scope: expected = context } = {}) {
  const interruption = small ? 1 : 64;
  const size = small ? partBytes + 257 : resume ? resumeBytes : 5 * 1024 ** 3;
  const parts = [], calls = [], scratch = Buffer.allocUnsafe(partBytes);
  let complete = false, clients = 0, firstSignal, packed;
  const check = (signal) => assert.equal(signal.aborted, false);
  function openClient(scope, signal, binding) {
    assert.deepEqual(scope, expected);
    check(signal);
    const client = ++clients;
    assert.deepEqual(binding, client === 1 ? { principalId: null, intentId: null } : { principalId: member, intentId: intent });
    const reopened = client > 1;
    return {
      scope: reopened && fault?.startsWith('scope-') ? { ...expected, [fault.slice(6)]: 'wrong' } : expected,
      principalId: fault === 'revoked-principal' ? revokedMember : reopened && fault === 'foreign-principal' ? file : member,
      role: fault === 'owner' || (reopened && fault === 'reopen-owner') ? 'owner' : 'member',
      intentId: reopened && fault === 'wrong-intent' ? file : binding.intentId,
      async request(path, { method, body, headers, signal, redirect }) {
        check(signal);
        assert.equal(redirect, 'error');
        if (path === readinessPath) {
          assert.equal(method, 'HEAD');
          if (fault === 'wrong-ready' || (reopened && fault === 'reopen-sha')) {
            return ready({ ...expected, sha: 'b'.repeat(40) }, headers);
          }
          if (reopened && fault === 'reopen-version') return ready({ ...expected, version: file }, headers);
          return ready(expected, headers);
        }
        if (path === '/api/uploads') {
          assert.equal(client, 1);
          assert.equal(method, 'POST');
          assert.equal(headers['content-type'], 'application/json');
          firstSignal = signal;
          ({ expectedPartSha256s: packed } = JSON.parse(body));
          assert.match(packed, new RegExp(`^[0-9a-f]{${Math.ceil(size / partBytes) * 64}}$`));
          assert.equal(body, JSON.stringify({ size, expectedPartSha256s: packed }));
          calls.push('allocate');
          return Response.json({ id: intent }, { status: 201 });
        }
        calls.push(`${method} ${path}`);
        if (method === 'PUT') {
          const n = parts.length + 1;
          assert.equal(path, `${upload}/parts/${n}`);
          assert.equal(client, resume && n > interruption ? 2 : 1);
          assert.equal(headers['content-type'], 'application/octet-stream');
          assert.equal(body.byteLength, Math.min(partBytes, size - (n - 1) * partBytes));
          const sha256 = createHash('sha256').update(body).digest('hex');
          assert.equal(packed.slice((n - 1) * 64, n * 64), sha256);
          // Store a compact representation of the actual received bytes, not the producer's source.
          const mark = Buffer.from(body.subarray(0, 4));
          const fill = body[4];
          const uniform = scratch.subarray(0, body.byteLength).fill(fill);
          mark.copy(uniform);
          assert.equal(body.equals(uniform), true);
          parts.push({ partNumber: n, sizeBytes: body.byteLength, sha256, mark, fill });
          if (fault === 'cancel' && n === 1) controller.abort(new Error('private transport detail'));
          if (fault === 'lost-ack' && n === lostAckPart) throw new Error('private transport detail');
          return new Response(null, { status: 204 });
        }
        if (path === `${upload}/resume`) {
          assert.equal(method, 'GET');
          assert.equal(client, 2);
          assert.equal(firstSignal.aborted, true);
          assert.equal(parts.length, interruption);
          const persisted = parts.map(({ partNumber, sizeBytes, sha256 }) => ({ partNumber, sizeBytes, sha256 }));
          if (fault === 'wrong-prefix') persisted[0].sha256 = '0'.repeat(64);
          if (fault === 'short-prefix') persisted.pop();
          if (fault === 'denied') return new Response('private transport detail', { status: 403 });
          return Response.json({ declaredSize: size, parts: persisted,
            expectedPartSha256s: fault === 'unsealed' ? undefined : fault === 'wrong-suffix' ? packed.slice(0, -64) + '0'.repeat(64) : packed });
        }
        if (path === `${upload}/complete`) {
          assert.equal(method, 'POST');
          assert.equal(parts.length, Math.ceil(size / partBytes));
          assert.deepEqual(JSON.parse(body), { parentId: null, name: `qualification-${scope.runId}-${scope.attempt}-${resume ? 'resume' : 'large'}.bin` });
          complete = true;
          return Response.json({ id: file }, { status: 201 });
        }
        assert.equal(path, `/api/download/${file}`);
        assert.equal(method, 'GET');
        assert.equal(complete, true);
        let index = 0;
        return new Response(new ReadableStream({ pull(stream) {
          const part = parts[index++];
          if (!part) return stream.close();
          const chunk = Buffer.alloc(part.sizeBytes, part.fill);
          part.mark.copy(chunk);
          if (fault === 'corrupt-download' && index === parts.length) chunk[chunk.length - 1] ^= 1;
          stream.enqueue(chunk);
        } }), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) } });
      },
    };
  }
  return { openClient, calls, parts, get clients() { return clients; } };
}

test('uploads and downloads five GiB through the authenticated app client', async () => {
  const { openClient, calls } = fixture();
  assert.deepEqual(await exerciseQualificationLargeTransfer(context, active(), openClient, revokedMember), { 'large-transfer-hash': 'pass' });
  assert.equal(calls.filter(call => call.startsWith('PUT ')).length, 320);
});

test('continues the same intent from one persisted GiB without replaying any part', async () => {
  const { openClient, calls } = fixture({ resume: true });
  assert.deepEqual(await exerciseQualificationResume(context, active(), openClient, revokedMember), { 'interrupted-transfer-resume': 'pass' });
  assert.equal(calls.filter(call => call === 'allocate').length, 1);
  const read = calls.indexOf(`GET ${upload}/resume`);
  assert.equal(read, 65);
  assert.deepEqual(calls.slice(read + 1), [`PUT ${upload}/parts/65`, `PUT ${upload}/parts/66`,
    `POST ${upload}/complete`, `GET /api/download/${file}`]);
});

const redacted = { message: 'Qualification app transfer is unverified.' };
test('rejects invalid admission, bad scope and ambiguous acknowledgements without restart', async () => {
  for (const fault of ['owner', 'revoked-principal', 'wrong-ready', 'wrong-scope', 'lost-ack', 'cancel']) {
    const controller = new AbortController();
    const { openClient, calls } = fixture({ small: true, resume: true, fault, controller });
    const scope = fault === 'wrong-scope' ? { ...context, attempt: '3' } : context;
    await assert.rejects(exerciseQualificationResumeFixture(scope, controller.signal, openClient, revokedMember), redacted);
    assert.deepEqual(calls, ['lost-ack', 'cancel'].includes(fault) ? ['allocate', `PUT ${upload}/parts/1`] : []);
  }
});

test('losing the acknowledgement for part 64 is fatal even with one GiB persisted', async () => {
  const f = fixture({ resume: true, fault: 'lost-ack', lostAckPart: 64 });
  await assert.rejects(exerciseQualificationResume(context, active(), f.openClient, revokedMember), redacted);
  assert.equal(f.clients, 1);
  assert.equal(f.parts.reduce((sum, part) => sum + part.sizeBytes, 0), 1024 * MiB);
  assert.deepEqual(f.calls, ['allocate', ...Array.from({ length: 64 }, (_, i) => `PUT ${upload}/parts/${i + 1}`)]);
});

test('denied, unsealed or mismatched persisted evidence prevents all suffix writes', async () => {
  for (const fault of ['wrong-prefix', 'short-prefix', 'denied', 'unsealed', 'wrong-suffix']) {
    const { openClient, calls } = fixture({ small: true, resume: true, fault });
    await assert.rejects(exerciseQualificationResumeFixture(context, active(), openClient, revokedMember), redacted);
    assert.equal(calls.length, 3);
    assert.equal(calls.at(-1), `GET ${upload}/resume`);
  }
});

test('rejects the owner, foreign member, wrong intent or candidate scope before reading the journal', async () => {
  for (const fault of ['reopen-owner', 'foreign-principal', 'wrong-intent', 'scope-sha', 'scope-version', 'scope-runId', 'scope-attempt', 'scope-prefix']) {
    const { openClient, calls } = fixture({ small: true, resume: true, fault });
    await assert.rejects(exerciseQualificationResumeFixture(context, active(), openClient, revokedMember), redacted);
    assert.deepEqual(calls, ['allocate', `PUT ${upload}/parts/1`]);
  }
});

test('requires matching runtime SHA and version again after reconnecting', async () => {
  for (const fault of ['reopen-sha', 'reopen-version']) {
    const f = fixture({ small: true, resume: true, fault });
    await assert.rejects(exerciseQualificationResumeFixture(context, active(), f.openClient, revokedMember), redacted);
    assert.equal(f.clients, 2);
    assert.deepEqual(f.calls, ['allocate', `PUT ${upload}/parts/1`]);
  }
});

for (const fault of ['oversized', 'aborted', 'invalid-status', 'readiness-body']) {
  test(`${fault} app replies reject and unlock before stream cleanup settles`, async () => {
    const controller = new AbortController();
    const cancelling = Promise.withResolvers(), cleanup = Promise.withResolvers();
    let cancelled = false;
    const body = new ReadableStream({
      pull(stream) {
        if (fault === 'aborted') controller.abort(new Error('private transport detail'));
        else stream.enqueue(Buffer.alloc(4097));
      },
      cancel() { cancelled = true; cancelling.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 });
    const openClient = () => ({
      scope: context, principalId: member, role: 'member', intentId: null,
      request(path, { headers }) {
        if (path === readinessPath) return fault === 'readiness-body' ? new Response(body) : ready(context, headers);
        assert.notEqual(fault, 'readiness-body');
        assert.equal(path, '/api/uploads');
        return new Response(body, { status: fault === 'invalid-status' ? 403 : 201,
          headers: { 'content-type': 'application/json' } });
      },
    });
    let settled = false;
    const result = assert.rejects(exerciseQualificationResumeFixture(context, controller.signal, openClient, revokedMember), redacted)
      .finally(() => { settled = true; });
    try {
      await Promise.race([cancelling.promise, result]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cancelled, true);
      assert.equal(settled, true);
      assert.equal(body.locked, false);
    } finally {
      if (cancelled) cleanup.reject(new Error('private cleanup detail'));
      else cleanup.resolve();
      await result;
    }
  });
}

test('an exact-length corrupt resumed download cannot pass', async () => {
  const { openClient, calls } = fixture({ small: true, resume: true, fault: 'corrupt-download' });
  await assert.rejects(exerciseQualificationResumeFixture(context, active(), openClient, revokedMember), redacted);
  assert.equal(calls.at(-1), `GET /api/download/${file}`);
});
