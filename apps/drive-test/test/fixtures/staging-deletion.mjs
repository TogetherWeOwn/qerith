import { env } from 'cloudflare:workers';
import { stagingOrigin } from '../../../drive/src/lib/server/qualification-readiness.ts';
import { config, epoch, sql } from './upload-completion.mjs';
import { etag } from './upload-publication-generation.mjs';

export const bindings = {
  DB: env.DB, DRIVE_ORIGIN: stagingOrigin,
  DRIVE_S3_ENDPOINT: config.endpoint.toUpperCase() + ':443/', DRIVE_S3_BUCKET: config.bucket,
  DRIVE_S3_REGION: config.region, DRIVE_S3_STORAGE_EPOCH: epoch,
  DRIVE_S3_ACCESS_KEY_ID: config.accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
};

export const qualification = {
  storageConfigId: JSON.stringify([config.endpoint, config.bucket, epoch]), region: config.region,
  confirmsRemoval: ({ headers }) => headers.get('x-fixture-removal') === 'permanent',
};

export function removal(confirmed = true) {
  return new Response(null, { status: 204, headers: confirmed ? { 'x-fixture-removal': 'permanent' } : {} });
}

export const job = (id) => sql('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?', id).first();
export const snapshot = async () => (await env.DB.batch([
  sql('SELECT * FROM drive_entries ORDER BY id'),
  sql('SELECT * FROM drive_owner_usage ORDER BY owner_id'),
  sql('SELECT * FROM drive_deleted_entries ORDER BY entry_id'),
  sql('SELECT * FROM drive_object_deletion_jobs ORDER BY entry_id'),
  sql('SELECT * FROM drive_upload_publication_tombstones ORDER BY intent_id'),
])).map(({ results }) => results);

export function sentRequest(request) {
  const headers = request.headers.get('authorization')?.match(/SignedHeaders=([^,]+)/)?.[1].split(';');
  return [request.method, request.url, request.headers.get('if-match') === etag && headers?.includes('if-match')];
}
