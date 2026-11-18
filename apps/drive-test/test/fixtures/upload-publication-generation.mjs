import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { createTrustedUploadPublication } from '../../../drive/src/lib/server/metadata/upload-trusted-publication.ts';
import { config, epoch, evidence, migrations, producer, response, seed } from './upload-completion.mjs';

export const etag = '"final-opaque"';
export const qualified = async (id) => id === JSON.stringify([config.endpoint, config.bucket, epoch]);
export const headOk = () => new Response(null, { headers: { etag, 'content-length': '7' } });
export const publisher = (fetch, qualify = qualified, s3 = config, storageEpoch = epoch) =>
  createTrustedUploadPublication(env.DB, storageEpoch, s3, { fetch, timeoutMs: 5000 }, qualify);

export async function setup(operation, options = {}) {
  await applyD1Migrations(env.DB, migrations);
  const { token, key, intent, part } = await seed(operation, { declaredSize: 7, ...options });
  const owner = `owner-${operation}`;
  const complete = producer(async () => response(key));
  return { token, key, intent, owner, part, complete: () => complete.complete(token, operation),
    publish: (service, version = 3, auth = token) => service.publish(auth, owner, intent, version, operation, null, 'file') };
}

export async function seedBoundPublication(label, { key, service = publisher(headOk) } = {}) {
  const { complete, publish, token, key: objectKey, intent } = await setup(label, { key });
  expect(await complete()).toBe('recorded');
  const { id } = await publish(service);
  const { evidence_revision: evidenceRevision } = await evidence('receipts', label);
  return { id, token, key: objectKey, intent, evidenceRevision };
}
