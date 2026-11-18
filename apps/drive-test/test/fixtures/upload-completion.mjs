import { env } from 'cloudflare:workers';
import { Sessions } from '../../../drive/src/lib/server/identity/sessions.ts';

export const sql = (query, ...args) => env.DB.prepare(query).bind(...args);
export const sessions = new Sessions(env.DB);
export const config = { endpoint: 'https://storage.example', bucket: 'drive-test', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
export const epoch = 'epoch-1';
export const parts = [{ partNumber: 2, etag: '"part-&-ÿ"', size: 7 }];
export const response = (key) => new Response(`<CompleteMultipartUploadResult><Bucket>drive-test</Bucket><Key>${key}</Key><ETag>"final-opaque"</ETag><ChecksumSHA256>example-checksum</ChecksumSHA256><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>`);

// Seed ledger rows directly so this also covers inherited, non-UTF-8 SQLite TEXT.
export async function seed(id, { legacy = false, endpoint = config.endpoint, key = `key-${id}`, intent = `${String.fromCodePoint(0xFEFF)}intent-${id}` } = {}) {
  const owner = `owner-${id}`, upload = 'upload/+id', part = `part-${id}`;
  const bindStorage = () => sql('INSERT INTO drive_upload_storage_bindings VALUES (CAST(? AS TEXT), ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("INSERT INTO drive_principals VALUES (?, 'member', 'active')", owner).run();
  await sql("INSERT INTO drive_upload_intents VALUES (CAST(? AS TEXT), ?, ?, NULL, 0, 'created', 0)", intent, owner, key).run();
  if (!legacy) await bindStorage();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = CAST(? AS TEXT)", upload, intent).run();
  await sql('INSERT INTO drive_upload_completion_operations VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, 2)', id, intent, owner, key, epoch, upload).run();
  await sql('INSERT INTO drive_upload_part_operations VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, 2, 2, 7)', part, intent, owner, key, epoch, upload).run();
  await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'reported', ?)", part, Uint8Array.from(parts[0].etag, (char) => char.charCodeAt(0)).buffer).run();
  await sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[2]', 7)", id).run();
  return { token: (await sessions.issue(owner)).token, key, intent, part, bindStorage };
}

// The migration replay fixtures must drop children before their ledger parents.
export const dropCompletionReceiptEvidence = `DROP VIEW IF EXISTS drive_upload_sealed_candidates;
  DROP TABLE IF EXISTS drive_upload_completion_quarantine;
  DROP TABLE IF EXISTS drive_upload_completion_receipts;
  DROP TABLE IF EXISTS drive_upload_completion_dispatches;
  DROP TABLE IF EXISTS drive_upload_publication_tombstones;
  DROP TABLE IF EXISTS drive_upload_storage_bindings;`;
