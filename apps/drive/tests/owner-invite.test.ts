import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { issueOwnerInvite } from '../src/lib/owner-invite';

const metadata = { displayName: 'Pell', note: null };
const token = 'A'.repeat(43);
const expiresAt = Date.now() + 60_000;
const issued = { id: '00000000-0000-4000-8000-000000000000', token, expiresAt };

test('issues a single same-origin POST and retains only the link fields', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/owner/invitations');
    assert.deepEqual(options, {
      method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(metadata)
    });
    return Response.json(issued, { status: 201 });
  });
  assert.deepEqual(await issueOwnerInvite(metadata), { token, expiresAt });
  assert.equal(fetch.mock.callCount(), 1);
});

test('only a definitive validation refusal is retryable', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 400 }));
  assert.deepEqual(await issueOwnerInvite(metadata), { kind: 'not-issued' });
  assert.equal(fetch.mock.callCount(), 1);
  for (const reply of [
    () => { throw new TypeError('network failure'); },
    () => new Response(null, { status: 503 }),
    () => Response.json(issued, { status: 200 }),
    () => new Response(null, { status: 201, headers: { 'content-type': 'application/json' } }),
    () => Response.json({ ...issued, id: null }, { status: 201 }),
    () => Response.json({ ...issued, token: 'invalid' }, { status: 201 }),
    () => Response.json({ ...issued, expiresAt: String(expiresAt) }, { status: 201 }),
  ]) {
    fetch.mock.mockImplementation(reply);
    fetch.mock.resetCalls();
    await assert.rejects(issueOwnerInvite(metadata));
    assert.equal(fetch.mock.callCount(), 1);
  }
});
