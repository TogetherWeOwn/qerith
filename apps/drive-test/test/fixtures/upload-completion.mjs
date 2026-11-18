import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { Sessions } from '../../../drive/src/lib/server/identity/sessions.ts';
import { createUploadCompletionReceipts } from '../../../drive/src/lib/server/metadata/upload-completion-receipts.ts';

export const sql = (query, ...args) => env.DB.prepare(query).bind(...args);
export const sessions = new Sessions(env.DB);
export const config = { endpoint: 'https://storage.example', bucket: 'drive-test', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
export const epoch = 'epoch-1';
export const parts = [{ partNumber: 2, etag: '"part-&-ÿ"', size: 7 }];
export const response = (key) => new Response(`<CompleteMultipartUploadResult><Bucket>drive-test</Bucket><Key>${key}</Key><ETag>"final-opaque"</ETag><ChecksumSHA256>example-checksum</ChecksumSHA256><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>`);
export const migrations = env.DRIVE_MIGRATIONS;
export const preReceiptMigrations = migrations.filter(({ name }) => name < '0022_upload_publication_receipts.sql');
export const preGenerationMigrations = migrations.filter(({ name }) => name < '0030_upload_published_generations.sql');
export const evidence = (kind, op) => sql(`SELECT * FROM drive_upload_completion_${kind} WHERE operation_id = ?`, op).first();
export const intentRow = (id) => sql('SELECT * FROM drive_upload_intents WHERE id = CAST(? AS TEXT)', id).first();

export function producer(fetch, verifyParts = async () => parts, db = env.DB, qualified = true) {
  const options = { fetch, timeoutMs: 5000 };
  const isQualified = async (storageConfigId) => {
    expect(storageConfigId).toBe(JSON.stringify([config.endpoint, config.bucket, epoch]));
    return qualified;
  };
  const service = createUploadCompletionReceipts(db, epoch, config, options, { isQualified, verifyParts });
  options.fetch = () => { throw new Error('replacement transport'); };
  return service;
}

// Seed ledger rows directly so this also covers inherited, non-UTF-8 SQLite TEXT.
export async function seed(id, { legacy = false, endpoint = config.endpoint, key = `key-${id}`, intent = `${String.fromCodePoint(0xFEFF)}intent-${id}`, declaredSize } = {}) {
  const owner = `owner-${id}`, upload = 'upload/+id', part = `part-${id}`;
  const bindStorage = () => sql('INSERT INTO drive_upload_storage_bindings VALUES (CAST(? AS TEXT), ?, ?, ?)', intent, endpoint, config.bucket, epoch).run();
  await sql("INSERT INTO drive_principals VALUES (?, 'member', 'active')", owner).run();
  // The pre-receipt migration test seeds before declared_size exists.
  await sql(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state${declaredSize === undefined ? '' : ', declared_size'})
    VALUES (CAST(? AS TEXT), ?, ?, 'created'${declaredSize === undefined ? '' : ', ?'})`,
    intent, owner, key, ...(declaredSize === undefined ? [] : [declaredSize])).run();
  if (!legacy) await bindStorage();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = CAST(? AS TEXT)", upload, intent).run();
  await sql('INSERT INTO drive_upload_completion_operations VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, 2)', id, intent, owner, key, epoch, upload).run();
  await sql('INSERT INTO drive_upload_part_operations VALUES (?, CAST(? AS TEXT), ?, ?, ?, ?, 2, 2, 7)', part, intent, owner, key, epoch, upload).run();
  await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'reported', ?)", part, Uint8Array.from(parts[0].etag, (char) => char.charCodeAt(0)).buffer).run();
  await sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[2]', 7)", id).run();
  return { token: (await sessions.issue(owner)).token, key, intent, part, bindStorage };
}

export function loseAcknowledgement(table, loseBeforeCommit) {
  let lostWrite = false, lostRead = false;
  return {
    withSession(mode) {
      const session = env.DB.withSession(mode);
      return { prepare(query) {
        if (loseBeforeCommit && lostWrite && !lostRead && query.startsWith('SELECT evidence_revision')) {
          lostRead = true;
          return { bind: () => ({ async first() { throw new Error('primary read unavailable'); } }) };
        }
        return session.prepare(query);
      } };
    },
    prepare(query) {
      if (!query.startsWith(`INSERT INTO drive_upload_completion_${table}`)) return env.DB.prepare(query);
      return { bind: (...args) => ({ async first() {
        if (lostWrite) return sql(query, ...args).first();
        if (!loseBeforeCommit && !await sql(query, ...args).first()) return null;
        lostWrite = true;
        throw new Error('lost acknowledgement');
      } }) };
    }
  };
}

// The migration replay fixtures must drop children before their ledger parents.
export const dropCompletionReceiptEvidence = `DROP VIEW IF EXISTS drive_published_generations;
  DROP TRIGGER IF EXISTS drive_upload_publications_admit;
  DROP TRIGGER IF EXISTS drive_upload_trusted_dispatch_journal_fence;
  DROP VIEW IF EXISTS drive_upload_publishable_completions;
  DROP VIEW IF EXISTS drive_upload_completed_receipt_evidence;
  DROP TRIGGER IF EXISTS drive_entries_no_deleted_identity;
  DROP TRIGGER IF EXISTS drive_upload_intents_no_deleted_key;
  DROP TABLE IF EXISTS drive_deleted_entries;
  DROP TRIGGER IF EXISTS drive_upload_publications_cleanup_fence;
  DROP TRIGGER IF EXISTS drive_upload_publications_ack_fence;
  DROP TABLE IF EXISTS drive_upload_publications;
  DROP TRIGGER IF EXISTS drive_upload_publication_attempts_cleanup_fence;
  DROP TRIGGER IF EXISTS drive_upload_publication_attempts_dispatch_fence;
  DROP TABLE IF EXISTS drive_upload_publication_attempts;
  DROP TRIGGER IF EXISTS drive_upload_intents_cleanup_fence;
  DROP TRIGGER IF EXISTS drive_upload_dispatch_cleanup_fence;
  DROP TABLE IF EXISTS drive_upload_cleanup_claims;
  DROP VIEW IF EXISTS drive_upload_sealed_candidates;
  DROP TABLE IF EXISTS drive_upload_completion_quarantine;
  DROP TABLE IF EXISTS drive_upload_completion_receipts;
  DROP TABLE IF EXISTS drive_upload_completion_dispatches;
  DROP TABLE IF EXISTS drive_upload_publication_tombstones;
  DROP TABLE IF EXISTS drive_upload_storage_bindings;`;
