import { validateName } from './private';
import { UploadIntents, type UploadIntent } from './upload-intents';

interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

// This is a trusted server-side verifier, not a request-supplied assertion.
// It must verify the exact completed generation against independently retained
// upload evidence, including the final byte count. A HEAD alone is insufficient.
export type VerifyCompletedObject = (intent: UploadIntent) => Promise<{
  objectKey: string;
  sizeBytes: number;
  etag: string;
} | null>;

export class UploadPublication {
  constructor(private readonly db: Database, private readonly verify: VerifyCompletedObject) {}

  // Resolve a lost publication response without re-publishing or exposing the key.
  async getReceipt(principalId: string, intentId: string): Promise<{ id: string } | null> {
    return this.db.prepare(`SELECT entry_id AS id FROM drive_upload_publications
      WHERE intent_id = ? AND owner_id = ?
        AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)`)
      .bind(intentId, principalId, principalId).first<{ id: string }>();
  }

  async publish(principalId: string, intentId: string, version: number,
    parentId: string | null, name: string): Promise<{ id: string } | null> {
    if (!Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid upload version');
    validateName(name);
    const intent = await new UploadIntents(this.db).get(principalId, intentId);
    if (!intent || intent.version !== version || intent.state !== 'acknowledged' || intent.completion_acknowledged !== 1) return null;
    const objectKey = intent.object_key;
    const evidence = await this.verify({ ...intent });
    if (!evidence || evidence.objectKey !== objectKey || !Number.isSafeInteger(evidence.sizeBytes)
      || evidence.sizeBytes < 0 || typeof evidence.etag !== 'string' || evidence.etag.length === 0) return null;
    // The conditional insert rechecks authorization and fencing after verification.
    // A conflict aborts the entire statement, including the receipt and accounting.
    return this.db.prepare(`INSERT INTO drive_upload_publications
      (intent_id, intent_version, entry_id, owner_id, object_key, parent_id, name, size_bytes, object_etag)
      SELECT id, version, ?, owner_id, object_key, ?, ?, ?, ? FROM drive_upload_intents
      WHERE id = ? AND owner_id = ? AND version = ? AND object_key = ?
        AND state = 'acknowledged' AND completion_acknowledged = 1
        AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_publications WHERE intent_id = ?)
      RETURNING entry_id AS id`).bind(crypto.randomUUID(), parentId, name, evidence.sizeBytes, evidence.etag,
      intentId, principalId, version, intent.object_key, principalId, intentId).first<{ id: string }>();
  }
}
