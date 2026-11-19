import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export async function exerciseOwnerRoutes({ worker, DB, origin, owner, session, preview }) {
  const invite = '/api/owner/invitations';
  const memberId = 'owner-route-member';
  const member = await session(memberId, 'member');
  const revoke = `/api/owner/members/${memberId}/revoke`;
  const cancel = (id) => `${invite}/${id}/cancel`;
  async function check(status, path, method, headers, body) {
    const response = await worker.fetch(`${origin}${path}`, { method, headers, body, redirect: 'manual' });
    assert.deepEqual([response.status, response.headers.get('cache-control')], [status, 'private, no-store'], `${method} ${path}`);
    return response;
  }
  const auth = { cookie: owner, origin };
  const json = { 'content-type': 'application/json' };
  const routes = [[invite, 'GET'], [invite, 'POST', '{}'], [cancel(randomUUID()), 'POST'], [revoke, 'POST']];
  if (preview) {
    for (const [path, method, body] of routes) {
      await check(404, path, method, { origin, ...json }, body);
      await check(404, path, method, { ...auth, ...json }, body);
    }
    return;
  }
  for (const [path, method, body] of routes) {
    await check(401, path, method, { origin, ...json }, body);
    await check(403, path, method, { cookie: member, origin, ...json }, body);
    await check(403, path, method, { ...auth, ...json, origin: 'https://other.example.test' }, body);
    if (method === 'POST') await check(403, path, method, { cookie: owner, ...json }, body);
  }
  for (const body of ['[]', '{"ownerId":"other"}', '{"note":" "}', ' '.repeat(3073)]) {
    await check(400, invite, 'POST', { ...auth, ...json }, body);
  }
  const list = async () => (await (await check(200, invite, 'GET', { cookie: owner })).json()).invitations;
  assert.deepEqual(await list(), []);
  const issued = await (await check(201, invite, 'POST', { ...auth, ...json }, '{"displayName":"Guest"}')).json();
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  const [entry] = await list();
  assert.deepEqual(entry, { id: issued.id, displayName: 'Guest', note: null, createdAt: entry.createdAt, expiresAt: issued.expiresAt });
  const row = () => DB.prepare('SELECT token_hash, cancelled_at FROM drive_invitations WHERE id = ?').bind(issued.id).first();
  assert.equal((await row()).token_hash, createHash('sha256').update(issued.token).digest('hex'));
  await DB.prepare('UPDATE drive_invitations SET expires_at = 1 WHERE id = ?').bind(issued.id).run();
  assert.equal((await list())[0].expiresAt, 1, 'expired invitations remain visible to the owner');
  await check(403, cancel(issued.id), 'POST', { ...auth, cookie: member });
  await check(204, cancel(issued.id), 'POST', auth);
  assert.ok((await row()).cancelled_at > 0);
  await check(404, cancel(issued.id), 'POST', auth);
  assert.deepEqual(await list(), []);
  await DB.prepare(`WITH RECURSIVE slots(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM slots WHERE n < 101)
    INSERT INTO drive_invitations (id, token_hash, expires_at, cancelled_at)
    SELECT printf('00-history-%03d', n), printf('%064x', n), 1, CASE WHEN n < 101 THEN 1 END FROM slots`).run();
  const first = await (await check(200, invite, 'GET', auth)).json();
  assert.deepEqual(first, { invitations: [], nextCursor: '00-history-100' });
  const second = await (await check(200, `${invite}?after=${first.nextCursor}`, 'GET', auth)).json();
  assert.deepEqual(second.invitations.map(({ id }) => id), ['00-history-101']);
  assert.equal(second.nextCursor, null);
  await check(204, cancel('00-history-101'), 'POST', auth);
  await check(204, revoke, 'POST', auth);
  await check(404, revoke, 'POST', auth);
  await check(401, '/', 'GET', { cookie: member });
  await check(401, invite, 'GET', { cookie: member });
  console.log('Generated Worker: owner invite issuance, pending list, cancellation, revocation and request denials passed');
}
