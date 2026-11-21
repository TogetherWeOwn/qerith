import assert from 'node:assert/strict';
import test from 'node:test';
import { entryShare } from './share-client';

function transport(...responses: Response[]) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (path, init) => {
    assert.equal(typeof path, 'string');
    calls.push({ path: String(path), init });
    const response = responses.shift();
    assert.ok(response, 'unexpected request');
    return response;
  };
  return { calls, fetcher };
}

function fullPageEndingAt(recipientId: string) {
  return [
    ...Array.from({ length: 99 }, (_, i) => ({ recipientId: `recipient-${String(i).padStart(2, '0')}` })),
    { recipientId },
  ];
}

test('reads one owned-entry page with a canonical opaque cursor and nullable names', async () => {
  const cursor = "é +&'";
  const name = 'Sam < & Co.';
  const recipients = fullPageEndingAt(cursor).map(({ recipientId }) => ({
    recipientId, displayName: recipientId === cursor ? name : null,
  }));
  const { calls, fetcher } = transport(
    Response.json({ recipients, nextCursor: cursor }),
    Response.json({ recipients: [{ recipientId: 'other', displayName: null }], nextCursor: null }),
    Response.json({ recipients: [{ recipientId: cursor }], nextCursor: null }),
  );
  const share = entryShare('a?#/b', fetcher);
  const signal = new AbortController().signal;
  const first = await share.listEligible({ signal });
  assert.deepEqual(first, { recipients, nextCursor: cursor });
  assert.equal(calls[0].path, '/api/entries/a%3F%23%2Fb/eligible-recipients');
  assert.equal(calls[0].init?.signal, signal);
  assert.deepEqual(await share.listEligible({ cursor: first.nextCursor! }), {
    recipients: [{ recipientId: 'other', displayName: null }], nextCursor: null,
  });
  assert.equal(calls[1].path, '/api/entries/a%3F%23%2Fb/eligible-recipients?cursor=%C3%A9%20%2B%26%27');
  assert.deepEqual(await share.listDirectGrants(), { recipients: [{ recipientId: cursor }], nextCursor: null });
  assert.equal(calls[2].path, '/api/entries/a%3F%23%2Fb/read-grants');
});

test('creates and revokes by opaque ID with one bodyless request per action', async () => {
  const { calls, fetcher } = transport(new Response(null, { status: 204 }), new Response(null, { status: 204 }));
  const share = entryShare('file', fetcher);
  await share.grant("user/'");
  await share.revoke("user/'");
  assert.deepEqual(calls.map(({ path, init }) => [path, init]), ['PUT', 'DELETE'].map((method) => [
    '/api/entries/file/read-grants/user%2F%27',
    { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', method },
  ]));
  await assert.rejects(share.grant('..'), TypeError);
  assert.throws(() => entryShare('.', fetcher), TypeError);
  assert.equal(calls.length, 2);
});

test('aborts grant and revoke transport and skips a write with an already aborted signal', async () => {
  for (const [method, verb] of [['grant', 'PUT'], ['revoke', 'DELETE']] as const) {
    const controller = new AbortController();
    const { signal } = controller;
    let calls = 0;
    const share = entryShare('entry', async (path, init) => {
      calls++;
      assert.equal(path, '/api/entries/entry/read-grants/member');
      assert.deepEqual(init, { mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', method: verb, signal });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const inFlight = share[method]('member', signal);
    controller.abort();
    await assert.rejects(inFlight, { name: 'AbortError' });
    await assert.rejects(share[method]('later', signal), { name: 'AbortError' });
    assert.equal(calls, 1);
  }
});

test('rejects an empty page with a fresh continuation but accepts a terminal empty page', async () => {
  const { fetcher } = transport(
    Response.json({ recipients: [], nextCursor: 'fresh' }),
    Response.json({ recipients: [], nextCursor: null }),
  );
  const share = entryShare('file', fetcher);
  await assert.rejects(share.listEligible({ cursor: 'previous' }), /Invalid Share page/);
  assert.deepEqual(await share.listEligible({ cursor: 'previous' }), { recipients: [], nextCursor: null });
});

test('rejects a full page whose continuation does not match the final recipient', async () => {
  const recipients = fullPageEndingAt('recipient-99');
  const { fetcher } = transport(
    Response.json({ recipients, nextCursor: recipients[0].recipientId }),
    Response.json({ recipients, nextCursor: null }),
  );
  const share = entryShare('file', fetcher);
  await assert.rejects(share.listDirectGrants(), /Invalid Share page/);
  assert.deepEqual(await share.listDirectGrants(), { recipients, nextCursor: null });
});

test('rejects denied or malformed pages and does not retry unconfirmed mutations', async () => {
  const { calls, fetcher } = transport(
    new Response(null, { status: 404 }),
    Response.json({ recipients: fullPageEndingAt('same'), nextCursor: 'same' }),
    Response.json({ recipients: [{ recipientId: 'person' }], nextCursor: null }),
    new Response(null, { status: 503 }),
  );
  const share = entryShare('file', fetcher);
  await assert.rejects(share.listEligible(), /unavailable/);
  await assert.rejects(share.listDirectGrants({ cursor: 'same' }), /Invalid Share page/);
  await assert.rejects(share.listEligible(), /Invalid Share name/);
  await assert.rejects(share.revoke('person'), /not confirmed/);
  assert.equal(calls.length, 4);
});

function recipient(recipientId: string, direct = false, inheritedFrom: string | null = null, displayName: string | null = null) {
  return { recipientId, displayName, direct, inheritedFrom };
}

test('projects a single effective page using both kinds of access and preserves the roster read', async () => {
  const direct = recipient('a/direct', true, null, 'Sam < & Co.');
  const inherited = recipient('b', false, 'Shared & named');
  const both = recipient('c', true, 'Shared folder');
  const candidate = recipient('d-é', false, null, direct.displayName);
  const rows = [direct, inherited, both, candidate];
  const page = { recipients: rows.map(row => ({ ...row, unused: 'ignored' })), nextCursor: null };
  const { calls, fetcher } = transport(Response.json(page), Response.json(page));
  const share = entryShare('nested file', fetcher);
  const signal = new AbortController().signal;
  assert.deepEqual(await share.listAccessPage({ signal }), {
    access: [direct, inherited, both], candidates: [{ recipientId: candidate.recipientId, displayName: candidate.displayName }],
    nextCursor: null, complete: true,
  });
  assert.deepEqual(calls, [{ path: '/api/entries/nested%20file/eligible-recipients', init: {
    mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  } }]);
  assert.deepEqual(await share.listEligible(), {
    recipients: rows.map(({ recipientId, displayName }) => ({ recipientId, displayName })), nextCursor: null,
  });
});

test('preserves opaque dot IDs on reads while blocking them in mutation paths', async () => {
  const direct = recipient('.', true, null, 'Existing grant');
  const candidate = { recipientId: '..', displayName: 'Eligible member' };
  const { calls, fetcher } = transport(Response.json({
    recipients: [direct, recipient(candidate.recipientId, false, null, candidate.displayName)], nextCursor: null,
  }));
  const share = entryShare('entry', fetcher);
  assert.deepEqual(await share.listAccessPage(), {
    access: [direct], candidates: [candidate], nextCursor: null, complete: true,
  });
  await assert.rejects(share.revoke(direct.recipientId), TypeError);
  await assert.rejects(share.grant(candidate.recipientId), TypeError);
  assert.equal(calls.length, 1);
});

test('preserves stored display labels longer than the current enrollment limit', async () => {
  const access = recipient('member', true, null, 'é'.repeat(65));
  const { fetcher } = transport(Response.json({ recipients: [access], nextCursor: null }));
  assert.deepEqual(await entryShare('entry', fetcher).listAccessPage(), {
    access: [access], candidates: [], nextCursor: null, complete: true,
  });
});

test('keeps the roster cursor even when a filtered page is empty', async () => {
  const cursor = "é /&'";
  const candidates = fullPageEndingAt(cursor).map(({ recipientId }) => recipient(recipientId));
  const access = candidates.map(({ recipientId }) => recipient(recipientId, true));
  const empty = { recipients: [], nextCursor: null };
  const { calls, fetcher } = transport(
    Response.json({ recipients: candidates, nextCursor: cursor }),
    Response.json({ recipients: access, nextCursor: cursor }),
    Response.json(empty), Response.json(empty),
  );
  const share = entryShare('entry', fetcher);
  assert.deepEqual(await share.listAccessPage(), {
    access: [], candidates: candidates.map(({ recipientId, displayName }) => ({ recipientId, displayName })),
    nextCursor: cursor, complete: false,
  });
  assert.deepEqual(await share.listAccessPage(), { access, candidates: [], nextCursor: cursor, complete: false });
  assert.deepEqual(await share.listAccessPage({ cursor }), { access: [], candidates: [], nextCursor: null, complete: false });
  assert.equal(calls[2].path, '/api/entries/entry/eligible-recipients?cursor=%C3%A9%20%2F%26%27');
  assert.deepEqual(await share.listAccessPage(), { access: [], candidates: [], nextCursor: null, complete: true });
});

test('rejects invalid effective rows, opaque IDs and pagination envelopes', async () => {
  const valid = recipient('valid');
  const invalidRows = [
    { ...valid, direct: 1 }, { ...valid, direct: undefined }, { ...valid, inheritedFrom: undefined },
    { ...valid, inheritedFrom: true }, { ...valid, inheritedFrom: 'sub/folder' }, { ...valid, inheritedFrom: 'é'.repeat(128) },
    { ...valid, displayName: undefined }, { ...valid, displayName: 1 },
    ...['', 'x\u0001', '\ud800', 'é'.repeat(257)].map(recipientId => ({ ...valid, recipientId })),
  ];
  const invalid = [
    ...invalidRows.map(row => ({ recipients: [row], nextCursor: null })),
    { recipients: [valid, valid], nextCursor: null },
    { recipients: [valid], nextCursor: valid.recipientId },
    { recipients: [recipient('previous'), valid], nextCursor: null },
    { recipients: Array.from({ length: 101 }, (_, i) => recipient(`member-${i}`)), nextCursor: null },
  ];
  const atLimit = recipient('😀'.repeat(128), false, null, '😀'.repeat(64));
  const { calls, fetcher } = transport(...invalid.map(page => Response.json(page)), Response.json({ recipients: [atLimit], nextCursor: null }));
  const share = entryShare('entry', fetcher);
  for (const page of invalid) {
    await assert.rejects(share.listAccessPage({ cursor: 'previous' }), /Invalid (Share|entry)/, JSON.stringify(page).slice(0, 150));
  }
  assert.deepEqual((await share.listAccessPage()).candidates, [{ recipientId: atLimit.recipientId, displayName: atLimit.displayName }]);
  await assert.rejects(share.listAccessPage({ cursor: 'é'.repeat(257) }), TypeError);
  assert.equal(calls.length, invalid.length + 1);
});

test('rejects malformed or oversized response bodies and cancels the oversized stream', async () => {
  const headers = { 'content-type': 'application/json' };
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(321 * 1024)); },
    cancel() { cancelled = true; },
  });
  const { calls, fetcher } = transport(
    new Response('{"recipients":[],"nextCursor":null}'),
    new Response('{"recipients":[{"recipientId":"valid","displayName":null,"direct":true,"\\u0064irect":false,"inheritedFrom":null}],"nextCursor":null}', { headers }),
    new Response(Uint8Array.of(0xff), { headers }),
    new Response(oversized, { headers }),
  );
  const share = entryShare('entry', fetcher);
  for (let i = 0; i < 4; i++) await assert.rejects(share.listAccessPage(), /Invalid Share response/);
  assert.equal(calls.length, 4);
  assert.equal(cancelled, true);
});
