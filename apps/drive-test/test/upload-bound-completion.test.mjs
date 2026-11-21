import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { captureUploadPartAcknowledgement, UploadPartByteEvidence } from '../../drive/src/lib/server/metadata/upload-part-byte-evidence.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';
import { readSession } from '../../drive/src/lib/server/request-auth.ts';
import { uploadRoutes } from '../../drive/src/lib/server/upload-routes.ts';
import { config, epoch, evidence, migrations, producer, response, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, qualified } from './fixtures/upload-publication-generation.mjs';

const { endpoint, bucket } = config;
const origin = 'https://drive.example.test', migration = '0038_upload_bound_completion.sql';
const full = 16 * 1024 ** 2;
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex();

async function fixture(planned, { unbound = false, schema = migrations, digestBytes = planned } = {}) {
  await applyD1Migrations(env.DB, schema);
  const ownerId = crypto.randomUUID(), uploadId = 'provider-upload', intents = new UploadIntents(env.DB);
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')", ownerId).run();
  const { token } = await sessions.issue(ownerId);
  const size = planned.reduce((sum, part) => sum + part.length, 0);
  const args = [ownerId, await tokenHash(token), size, endpoint, bucket, epoch];
  const parts = await Promise.all(planned.map(async (bytes, i) => ({
    partNumber: i + 1, sizeBytes: bytes.length, sha256: await sha256(digestBytes[i])
  })));
  const { id: intentId, object_key: objectKey, version } = unbound ? await intents.claimNewAllocation(...args)
    : await intents.claimNewExpectedAllocation(...args, 'active', parts);
  expect(await intents.recordSuccess(ownerId, intentId, version, { kind: 'allocation', uploadId })).toBe(true);
  const scope = { intentId, objectKey, ownerId, uploadId, storageEpoch: epoch, intentVersion: version + 1 };
  const listing = [], ledger = new UploadPartOperationEvidence(env.DB);
  const verifyParts = vi.fn(async () => listing);
  const fetch = vi.fn(async (request) => {
    if (request.method === 'HEAD') return new Response(null, { headers: { etag, 'content-length': String(size) } });
    expect(request.method).toBe('POST');
    expect(request.headers.get('if-none-match')).toBe('*');
    return response(objectKey);
  });
  const routes = uploadRoutes({ DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: { isQualified: qualified, verifyParts, completionTimeoutMs: () => 15_000 } }, { fetch, timeoutMs: 5000 });
  return {
    scope, token, verifyParts, fetch,
    async part(partNumber, bytes, proof = 'exact') {
      const part = { ...scope, endpoint, bucket, operationId: crypto.randomUUID(), partNumber, sizeBytes: bytes.length };
      const receipt = { partNumber, size: bytes.length, etag: `"part-${partNumber}"` };
      await ledger.recordAdmission(part);
      if (proof === 'claim') return;
      // Seed actual acknowledged bytes through the trusted producer, not the HTTP part handler.
      if (proof === 'legacy') await ledger.recordObservation(part, new TextEncoder().encode(receipt.etag));
      else await new UploadPartByteEvidence(env.DB).recordAcknowledged(await captureUploadPartAcknowledgement(part, bytes, async () => receipt));
      if (proof === 'uncertain') await ledger.recordObservation(part, null);
      listing.push(receipt);
    },
    async complete() {
      const body = JSON.stringify({ parentId: null, name: 'file' });
      const request = new Request(`${origin}/api/uploads/${intentId}/complete`, { method: 'POST', body,
        headers: { origin, cookie: `__Host-drive-session=${token}`, 'content-type': 'application/json', 'content-length': String(body.length) } });
      return routes.complete(request, await readSession(request, env.DB), intentId);
    }
  };
}

const right = Uint8Array.of(1), wrong = Uint8Array.of(2), empty = new Uint8Array();

// D1 state is shared inside this file: test the upgrade before applying the full schema.
it('fences a pre-upgrade bound seal with a valid total but wrong digest', async () => {
  const f = await fixture([right], { schema: migrations.filter(({ name }) => name < migration) });
  await f.part(1, wrong);
  const { intentId, ownerId, objectKey, storageEpoch, uploadId, intentVersion } = f.scope;
  const operationId = crypto.randomUUID(), candidate = () => sql('SELECT 1 FROM drive_upload_sealed_candidates WHERE operation_id = ?', operationId).first();
  await sql('INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, ?, ?)',
    operationId, intentId, ownerId, objectKey, storageEpoch, uploadId, intentVersion).run();
  await sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[1]', 1)", operationId).run();
  expect(await candidate()).not.toBeNull();
  await applyD1Migrations(env.DB, migrations);
  expect(await candidate()).toBeNull();
  expect(await producer(f.fetch, f.verifyParts).complete(f.token, { operationId, intentId, ownerId })).toBe('not-admitted');
  expect(await evidence('dispatches', operationId)).toBeNull();
  expect(f.verifyParts).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['exact ordered parts', 'bound zero bytes', 'unbound sparse legacy receipt'])('publishes %s', async (label) => {
  const unbound = label.startsWith('unbound');
  const planned = label === 'exact ordered parts' ? [new Uint8Array(full), right] : [unbound ? right : empty];
  const f = await fixture(planned, { unbound });
  for (const [index, bytes] of planned.entries()) await f.part(unbound ? 2 : index + 1, bytes, unbound ? 'legacy' : 'exact');
  expect((await f.complete()).status).toBe(201);
  expect(f.fetch.mock.calls.map(([request]) => request.method)).toEqual(['POST', 'HEAD']);
});

async function expectRejected(f) {
  expect((await f.complete()).status).toBe(409);
  expect(await sql('SELECT 1 FROM drive_upload_completion_operations WHERE intent_id = ?', f.scope.intentId).first()).toBeNull();
  expect(f.verifyParts).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
}

it.each([
  ['wrong digest at the right length', [right], [[1, wrong]]],
  ['wrong slot', [right], [[2, right]]],
  ['claim only', [right], [[1, right, 'claim']]],
  ['legacy receipt', [right], [[1, right, 'legacy']]],
  ['uncertain receipt even with exact proof', [right], [[1, right, 'uncertain']]],
  ['zero-byte proposal only', [empty], []],
  ['wrong expected digest for an empty receipt', [empty], [[1, empty]], [wrong]],
])('rejects %s before provider completion', async (_label, planned, acknowledged, digestBytes) => {
  const f = await fixture(planned, { digestBytes });
  for (const args of acknowledged) await f.part(...args);
  await expectRejected(f);
});

it.each(['extra', 'missing', 'wrong lengths'])('rejects a multipart ledger with %s slots', async (kind) => {
  const prefix = new Uint8Array(full), short = prefix.subarray(1), tail = Uint8Array.of(1, 2);
  const planned = kind === 'extra' ? [prefix] : [prefix, right];
  // The wrong-length case keeps both the declared total and the digests correct.
  const f = await fixture(planned, { digestBytes: kind === 'wrong lengths' ? [short, tail] : planned });
  await f.part(1, kind === 'wrong lengths' ? short : prefix);
  if (kind !== 'missing') await f.part(2, kind === 'extra' ? empty : tail);
  await expectRejected(f);
});

it('rejects an aggregate-only legacy completion claim for a bound intent', async () => {
  const { scope: { intentId, objectKey, uploadId, intentVersion } } = await fixture([right]);
  await expect(sql('INSERT INTO drive_upload_publication_attempts VALUES (?, ?, ?, ?, 1)',
    intentId, objectKey, uploadId, intentVersion).run()).rejects.toThrow('bound upload completion requires a sealed manifest');
});
