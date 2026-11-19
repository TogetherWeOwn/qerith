import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { createPrivateDeletionDrain } from '../../drive/src/lib/server/private-deletion-reconciliation.ts';
import { config, epoch, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

const job = (id) => sql('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?', id).first();
const confirmsRemoval = ({ headers }) => headers.get('x-fixture-result') === 'removed';
const removed = () => new Response(null, { status: 204, headers: { 'x-fixture-result': 'removed' } });

async function enqueue(label, key = `${label}.bin`) {
  const { id, token } = await seedBoundPublication(label, { key });
  expect(await new PrivateDeletion(env.DB).delete(token, id)).toBe(true);
  return id;
}

it('requires both fixture capabilities before touching the ledger', () => {
  const db = { withSession: vi.fn() };
  const fetch = vi.fn();
  for (const fixture of [undefined, { fetch }, { confirmsRemoval }]) {
    expect(createPrivateDeletionDrain(db, config, epoch, fixture)).toBeNull();
  }
  expect(db.withSession).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('catches up without a request and retries ambiguous work only once due', async () => {
  const retry = await enqueue('retry');
  const other = await enqueue('another-owner');
  await sql('UPDATE drive_object_deletion_jobs SET available_at = unixepoch() - 10 WHERE entry_id = ?', retry).run();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockImplementation(async () => removed());
  const drain = createPrivateDeletionDrain(env.DB, config, epoch, { fetch, confirmsRemoval });

  expect(await drain()).toBe(1);
  expect(await job(retry)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
  expect((await job(other)).completed_at).not.toBeNull();
  expect(await drain()).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(2);

  await sql('UPDATE drive_object_deletion_jobs SET available_at = unixepoch() - 1 WHERE entry_id = ?', retry).run();
  expect(await drain()).toBe(1);
  expect(await drain()).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [request] of [fetch.mock.calls[0], fetch.mock.calls[2]]) {
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://storage.example/drive-test/retry.bin');
    expect(request.headers.get('if-match')).toBe(etag);
  }
  expect((await job(retry)).completion_token).not.toBeNull();
});

it('leaves overflow for the next invocation', async () => {
  for (let i = 0; i < 9; i++) await enqueue(`overflow-${i}`);
  const fetch = vi.fn(async () => removed());
  const drain = createPrivateDeletionDrain(env.DB, config, epoch, { fetch, confirmsRemoval });
  expect(await drain()).toBe(8);
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(await drain()).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(9);
});
