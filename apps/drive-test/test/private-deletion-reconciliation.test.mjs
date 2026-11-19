import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { createPrivateDeletionReconciler } from '../../drive/src/lib/server/private-deletion-reconciliation.ts';
import { config, epoch, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

const job = (id) => sql('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?', id).first();
const makeDue = (id) => sql('UPDATE drive_object_deletion_jobs SET available_at = unixepoch() - 10 WHERE entry_id = ?', id).run();
const confirmsRemoval = ({ headers }) => headers.get('x-fixture-result') === 'removed';
const now = () => new Date('2026-01-02T03:04:05Z');

async function enqueue(label, options) {
  const { id, token } = await seedBoundPublication(label, options);
  expect(await new PrivateDeletion(env.DB).delete(token, id)).toBe(true);
  const { deletion_id: deletionId } = await sql('SELECT deletion_id FROM drive_deleted_entries WHERE entry_id = ?', id).first();
  return { id, deletionId };
}

it('does not admit reconciliation without a synthetic transport and removal proof', () => {
  const db = { withSession: vi.fn() };
  const fetch = vi.fn();
  for (const fixture of [undefined, { fetch }, { confirmsRemoval }]) {
    expect(createPrivateDeletionReconciler(db, config, epoch, fixture)).toBeNull();
  }
  expect(db.withSession).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('signs the exact scoped conditional DELETE and settles only after explicit removal proof', async () => {
  const unrelated = await enqueue('other-owner');
  const { id, deletionId } = await enqueue('selected-owner', { key: 'folder/conditional +%.bin' });
  await makeDue(unrelated.id);
  const untouched = await job(unrelated.id);
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'x-fixture-result': 'removed' } }));
  const reconcile = createPrivateDeletionReconciler(env.DB, config, epoch, { fetch, confirmsRemoval, now });
  const initial = await job(id);
  for (const missing of [undefined, '', crypto.randomUUID()]) expect(await reconcile(missing)).toBe(0);
  expect(await job(id)).toEqual(initial);
  expect(await job(unrelated.id)).toEqual(untouched);
  expect(fetch).not.toHaveBeenCalled();

  expect(await reconcile(deletionId)).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await job(id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
  expect(await job(unrelated.id)).toEqual(untouched);
  await makeDue(id);
  expect(await reconcile(deletionId)).toBe(1);
  expect(await reconcile(deletionId)).toBe(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [request] of fetch.mock.calls) {
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://storage.example/drive-test/folder/conditional%20%2B%25.bin');
    expect(request.headers.get('if-match')).toBe(etag);
    expect(request.headers.get('authorization')).toBe('AWS4-HMAC-SHA256 Credential=fixture/20260102/auto/s3/aws4_request, ' +
      'SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date, Signature=c0f79b9abdb65819d890728466532cba213cf7940a6f7896722810d0d2a97f20');
  }
  expect((await job(id)).completed_at).not.toBeNull();
  expect(await job(unrelated.id)).toEqual(untouched);
});

it.each([
  ['endpoint', { ...config, endpoint: 'https://elsewhere.example' }, epoch],
  ['bucket', { ...config, bucket: 'other-bucket' }, epoch],
  ['epoch', config, 'other-epoch'],
])('never dispatches to a mismatched %s', async (field, settings, storageEpoch) => {
  const { id, deletionId } = await enqueue(`mismatch-${field}`);
  const fetch = vi.fn();
  const reconcile = createPrivateDeletionReconciler(env.DB, settings, storageEpoch, { fetch, confirmsRemoval, now });
  expect(await reconcile(deletionId)).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(await job(id)).toMatchObject({ completed_at: null, completion_token: null });
});
