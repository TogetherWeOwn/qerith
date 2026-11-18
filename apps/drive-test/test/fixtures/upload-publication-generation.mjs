import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { createTrustedUploadPublication } from '../../../drive/src/lib/server/metadata/upload-trusted-publication.ts';
import { config, epoch, evidence, migrations, producer, response, seed, sessions, sql } from './upload-completion.mjs';

export const etag = '"final-opaque"';
export const qualified = async (id) => id === JSON.stringify([config.endpoint, config.bucket, epoch]);
export const headOk = () => new Response(null, { headers: { etag, 'content-length': '7' } });
export const publisher = (fetch, qualify = qualified, s3 = config, storageEpoch = epoch) =>
  createTrustedUploadPublication(env.DB, storageEpoch, s3, { fetch, timeoutMs: 5000 }, qualify);

export async function setup(operation, options = {}, schema = migrations) {
  await applyD1Migrations(env.DB, schema);
  const { token, key, intent, part } = await seed(operation, { declaredSize: 7, ...options });
  const owner = `owner-${operation}`;
  const complete = producer(async () => response(key));
  return { token, key, intent, owner, part, complete: () => complete.complete(token, operation),
    publish: (service, version = 3, auth = token) => service.publish(auth, owner, intent, version, operation, null, 'file') };
}

export async function changeOne(query, ...args) {
  const { results } = await sql(`${query} RETURNING 1 AS changed`, ...args).all();
  expect(results).toEqual([{ changed: 1 }]);
}

export async function revokeSession({ token }) {
  await sessions.revoke(token);
  expect(await sessions.lookup(token)).toBeNull();
}

export async function expectPublicationRaceRejected(fixture, race) {
  const head = vi.fn(() => race(fixture).then(headOk));
  const result = await fixture.publish(publisher(head));
  // A rejected or unfinished mock is a HEAD failure, not evidence of a write fence.
  expect(head.mock.settledResults).toEqual([{ type: 'fulfilled', value: expect.any(Response) }]);
  expect(head).toHaveBeenCalledTimes(1);
  expect(result).toBeNull();
}

export async function seedBoundPublication(label, { key, service = publisher(headOk), schema } = {}) {
  const { complete, publish, token, key: objectKey, intent } = await setup(label, { key }, schema);
  expect(await complete()).toBe('recorded');
  const { evidence_revision: evidenceRevision } = await evidence('receipts', label);
  const { id } = await publish(service);
  return { id, token, key: objectKey, intent, evidenceRevision };
}
