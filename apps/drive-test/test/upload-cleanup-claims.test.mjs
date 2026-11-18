import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { evidence, intentRow, loseAcknowledgement, migrations, parts, producer, response, seed, sql } from './fixtures/upload-completion.mjs';

const claim = (intent) => sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', intent).run();
const tombstone = (intent) => sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent).run();
const storedClaim = (intent) => sql('SELECT intent_id FROM drive_upload_cleanup_claims WHERE intent_id = ?', intent).first();
const intents = new UploadIntents(env.DB);

beforeEach(() => applyD1Migrations(env.DB, migrations));

it('rechecks cleanup at dispatch after preflight and prevents direct dispatch', async () => {
  const id = 'cleanup-first', { token, intent } = await seed(id);
  const fetch = vi.fn(), verify = vi.fn(async () => {
    await claim(intent);
    return parts;
  });
  const service = producer(fetch, verify);
  await expect(service.complete(token, id)).resolves.toBe('not-admitted');
  await expect(service.complete(token, id)).resolves.toBe('not-admitted');
  expect(verify).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  await expect(sql(`INSERT INTO drive_upload_completion_dispatches
    SELECT operation_id, endpoint, bucket, intent_version + 1, ?, session_hash
    FROM drive_upload_sealed_candidates WHERE operation_id = ?`, 'a'.repeat(64), id).run())
    .rejects.toThrow('upload cleanup already claimed');
  expect(await evidence('dispatches', id)).toBeNull();
  expect(await intentRow(intent)).toMatchObject({ state: 'allocated', version: 2 });
  expect(await storedClaim(intent)).not.toBeNull();
  await expect(sql('INSERT OR REPLACE INTO drive_upload_cleanup_claims VALUES (?)', intent).run())
    .rejects.toThrow('upload cleanup not admitted');
  await expect(sql('UPDATE drive_upload_cleanup_claims SET intent_id = intent_id WHERE intent_id = ?', intent).run())
    .rejects.toThrow('upload cleanup claims are immutable');
  await expect(sql('DELETE FROM drive_upload_cleanup_claims WHERE intent_id = ?', intent).run())
    .rejects.toThrow('upload cleanup claims are permanent');
});

it.each(['receipt', 'quarantine'])('rejects cleanup during dispatch and after %s without changing tombstones', async (outcome) => {
  const id = `dispatch-first-${outcome}`, { token, intent, key } = await seed(id);
  const fetch = vi.fn(async () => {
    expect(await intentRow(intent)).toMatchObject({ state: 'completing', version: 3 });
    await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
    await tombstone(intent); // Historical tombstones are not cleanup claims or receipt revocation.
    if (outcome === 'quarantine') throw new Error('lost provider response');
    return response(key);
  });
  const service = producer(fetch);
  await expect(service.complete(token, id)).resolves.toBe(outcome === 'receipt' ? 'recorded' : 'uncertain');
  expect(await evidence(outcome === 'receipt' ? 'receipts' : 'quarantine', id)).not.toBeNull();
  expect(await intents.recordUncertain(`owner-${id}`, intent, 3, 'completion')).toBe(true);
  await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
  // Even a journal acknowledgement cannot remove the durable dispatch fence.
  expect(await intents.recordSuccess(`owner-${id}`, intent, 3, { kind: 'completion' })).toBe(true);
  await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
  expect(await storedClaim(intent)).toBeNull();
  await expect(service.complete(token, id)).resolves.toBe('not-admitted');
  expect(fetch).toHaveBeenCalledOnce();
});

it('retains a dispatch whose D1 acknowledgement was lost', async () => {
  const id = 'unconfirmed-dispatch', { token, intent } = await seed(id), fetch = vi.fn();
  const service = producer(fetch, async () => parts, loseAcknowledgement('dispatches', false));
  await expect(service.complete(token, id)).resolves.toBe('uncertain');
  expect(await evidence('dispatches', id)).not.toBeNull();
  expect(await evidence('receipts', id)).toBeNull();
  await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
  await expect(service.complete(token, id)).resolves.toBe('not-admitted');
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps an existing tombstone effective before dispatch without treating it as a cleanup claim', async () => {
  const id = 'tombstone-first', { token, intent } = await seed(id), fetch = vi.fn();
  await tombstone(intent);
  await expect(producer(fetch).complete(token, id)).resolves.toBe('not-admitted');
  expect(fetch).not.toHaveBeenCalled();
  expect(await evidence('dispatches', id)).toBeNull();
  expect(await storedClaim(intent)).toBeNull();
  await claim(intent);
  expect(await storedClaim(intent)).not.toBeNull();
});

it('excludes legacy allocation and completion claims in both orders', async () => {
  const id = 'legacy-first', { intent } = await seed(id), owner = `owner-${id}`;
  const { intent: fenced } = await seed('cleanup-before-legacy');
  await claim(fenced);
  await expect(intents.claim('owner-cleanup-before-legacy', fenced, 2, 'completion')).resolves.toBeNull();
  await expect(sql("UPDATE drive_upload_intents SET state = 'completing' WHERE id = ?", fenced).run())
    .rejects.toThrow('upload cleanup already claimed');
  expect(await intents.claim(owner, intent, 2, 'completion')).toMatchObject({ version: 3 });
  await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
  expect(await intents.recordUncertain(owner, intent, 3, 'completion')).toBe(true);
  await expect(claim(intent)).rejects.toThrow('upload cleanup not admitted');
  expect(await evidence('dispatches', id)).toBeNull();

  const pending = await intents.create(owner), fencedAllocation = await intents.create(owner);
  await claim(fencedAllocation.id);
  await expect(intents.claim(owner, fencedAllocation.id, 0, 'allocation')).resolves.toBeNull();
  expect(await intents.claim(owner, pending.id, 0, 'allocation')).toMatchObject({ version: 1 });
  await expect(claim(pending.id)).rejects.toThrow('upload cleanup not admitted');
  expect(await intents.recordUncertain(owner, pending.id, 1, 'allocation')).toBe(true);
  await expect(claim(pending.id)).rejects.toThrow('upload cleanup not admitted');
});
