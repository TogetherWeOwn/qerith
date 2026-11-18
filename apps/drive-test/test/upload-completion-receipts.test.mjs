import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { createUploadCompletionReceipts } from '../../drive/src/lib/server/metadata/upload-completion-receipts.ts';
import { config, epoch, evidence, intentRow, loseAcknowledgement, migrations, parts, producer, response, seed, sessions, sql } from './fixtures/upload-completion.mjs';

it('rejects an eligible legacy seal without backfilling storage authority', async () => {
  await applyD1Migrations(env.DB, migrations.slice(0, -1));
  expect(await sql("SELECT name FROM sqlite_master WHERE name = 'drive_upload_storage_bindings'").first()).toBeNull();
  const { token, bindStorage } = await seed('legacy', { legacy: true });
  await applyD1Migrations(env.DB, migrations);
  await expect(bindStorage()).rejects.toThrow('storage binding must precede allocation');
  await expect(producer(vi.fn()).complete(token, 'legacy')).resolves.toBe('not-admitted');
  expect(await evidence('dispatches', 'legacy')).toBeNull();
});

it.each(['claim', 'receipt', 'receipt-write-read'])('recovers from lost %s D1 results without redispatch', async (lost) => {
  await applyD1Migrations(env.DB, migrations);
  const id = `lost-${lost}`, { token, key, intent } = await seed(id);
  const late = lost === 'receipt-write-read';
  let inFlightIntent;
  const fetch = vi.fn(async (request) => {
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${config.endpoint}/${config.bucket}/${key}?uploadId=upload%2F%2Bid`);
    expect(request.headers.get('if-none-match')).toBe('*');
    expect(request.headers.get('authorization')).toMatch(/signedheaders=[^,]*if-none-match/i);
    expect(await request.text()).toContain('<PartNumber>2</PartNumber><ETag>"part-&amp;-ÿ"</ETag>');
    if (late) {
      inFlightIntent = await intentRow(intent);
      await first.quarantineUnresolved(id);
    }
    return response(key);
  });
  const db = loseAcknowledgement(lost === 'claim' ? 'dispatches' : 'receipts', late);
  const withSession = vi.spyOn(db, 'withSession');
  const verify = vi.fn(async () => parts), first = producer(fetch, verify, db);
  const results = await Promise.all([first.complete(token, id), first.complete(token, id)]);
  expect(results.sort()).toEqual(['not-admitted', lost === 'claim' ? 'uncertain' : 'recorded']);
  expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operationId: id, intentId: intent, objectKey: key, uploadId: 'upload/+id' }));
  expect(await evidence('dispatches', id)).toMatchObject({ endpoint: config.endpoint, bucket: config.bucket, claim_version: 3 });
  const durable = await evidence('receipts', id);
  if (lost === 'claim') expect(durable).toBeNull();
  else {
    expect(withSession).toHaveBeenCalledTimes(3);
    expect(durable).toMatchObject({ etag: '"final-opaque"', response_checksums: '{"ChecksumSHA256":"example-checksum","ChecksumType":"COMPOSITE"}' });
  }
  expect(await evidence('quarantine', id)).toEqual(late ? { operation_id: id } : null);
  if (late) {
    expect(inFlightIntent).toMatchObject({ state: 'completing', version: 3 });
    expect(await intentRow(intent)).toEqual(inFlightIntent);
  }
  await expect(producer(fetch).complete(token, id)).resolves.toBe('not-admitted');
  expect(await evidence('receipts', id)).toEqual(durable);
  expect(fetch).toHaveBeenCalledTimes(lost === 'claim' ? 0 : 1);
});

it.each([{ endpoint: 'https://other.example' }, { key: 'key/../object' }, { intent: new Uint8Array([255]).buffer }, { qualified: false }])(
  'denies a different namespace, malformed identity or unqualified provider before part verification: %j', async (options) => {
    await applyD1Migrations(env.DB, migrations);
    const id = `reject-${Object.keys(options)[0]}`, { token } = await seed(id, options);
    const fetch = vi.fn(), verify = vi.fn();
    await expect(producer(fetch, verify, env.DB, options.qualified).complete(token, id)).resolves.toBe('not-admitted');
    expect(await evidence('dispatches', id)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }
);

it('denies unqualified, foreign, mismatched, uncertain and revoked completions', async () => {
  await applyD1Migrations(env.DB, migrations);
  const a = await seed('negative'), b = await seed('revoked'), fetch = vi.fn();
  const complete = (verify) => producer(fetch, verify).complete(a.token, 'negative');
  const unqualified = createUploadCompletionReceipts(env.DB, epoch, config, { fetch, timeoutMs: 5000 });
  await expect(unqualified.complete(a.token, 'negative')).resolves.toBe('not-admitted');
  await expect(producer(fetch).complete(b.token, 'negative')).resolves.toBe('not-admitted');
  await expect(complete(async () => [{ ...parts[0], etag: '"different"' }])).resolves.toBe('not-admitted');
  await expect(complete(async () => {
    await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'uncertain', NULL)", a.part).run();
    return parts;
  })).resolves.toBe('not-admitted');
  const revoke = vi.fn(async () => { await sessions.revoke(b.token); return parts; });
  await expect(producer(fetch, revoke).complete(b.token, 'revoked')).resolves.toBe('not-admitted');
  expect(revoke).toHaveBeenCalledOnce();
  expect(await evidence('dispatches', 'revoked')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['malformed', 'mismatched', 'lost'])('quarantines a %s provider response without dispatching again', async (id) => {
  await applyD1Migrations(env.DB, migrations);
  const { token } = await seed(id);
  const fetch = vi.fn(async () => {
    if (id === 'lost') throw new Error('lost provider acknowledgement');
    return id === 'mismatched' ? response('another-key') : new Response('<CompleteMultipartUploadResult />');
  });
  await expect(producer(fetch).complete(token, id)).resolves.toBe('uncertain');
  await expect(producer(fetch).complete(token, id)).resolves.toBe('not-admitted');
  expect(await evidence('quarantine', id)).toEqual({ operation_id: id });
  expect(await evidence('receipts', id)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
