import { completionXml, type CompletedPart } from '../s3/multipart-completion';
import { validateName } from './private';
import { UploadIntents, type UploadIntent } from './upload-intents';

interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

// The completion function is a trusted server-side create-only provider adapter.
export type CompleteUpload = (key: string, uploadId: string, parts: readonly CompletedPart[]) => Promise<{ etag: string; size: number }>;

export class UploadPublication {
  constructor(private readonly db: Database, private readonly complete: CompleteUpload) {}

  async completeAndPublish(principalId: string, intentId: string, version: number,
    parentId: string | null, name: string, parts: readonly CompletedPart[]): Promise<{ id: string } | null> {
    validateName(name);
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER - 2) {
      throw new TypeError('Invalid upload version');
    }
    const snapshot = Array.from(parts, part => ({ ...part }));
    completionXml(snapshot);
    const size = snapshot.reduce((total, part) => total + part.size, 0);
    if (!Number.isSafeInteger(size)) throw new TypeError('Invalid upload size');
    const claim = await this.db.prepare(`UPDATE drive_upload_intents SET state = 'completing', version = version + 1
      WHERE id = ? AND owner_id = ? AND state = 'allocated' AND version = ?
        AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = ?)
        AND declared_size IS NOT NULL
      RETURNING id, owner_id, object_key, upload_id, state, completion_acknowledged, version, declared_size`)
      .bind(intentId, principalId, version, principalId, intentId).first<UploadIntent & { declared_size: number }>();
    if (!claim || !claim.upload_id) return null;
    let result: { etag: string; size: number };
    try {
      result = await this.complete(claim.object_key, claim.upload_id, snapshot);
      if (!result || typeof result.etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(result.etag)) {
        throw new Error('Invalid completion ETag');
      }
      if (!Number.isSafeInteger(result.size) || result.size !== size || result.size !== claim.declared_size) {
        throw new Error('Invalid completion size');
      }
    } catch (error) {
      await new UploadIntents(this.db).recordUncertain(principalId, intentId, claim.version, 'completion');
      throw error;
    }
    const id = crypto.randomUUID();
    return this.db.prepare(`INSERT INTO drive_upload_publications
      (intent_id, intent_version, entry_id, owner_id, object_key, parent_id, name, size_bytes, object_etag)
      SELECT i.id, i.version, ?, i.owner_id, i.object_key, ?, ?, ?, ? FROM drive_upload_intents i
      WHERE i.id = ? AND i.owner_id = ? AND i.state = 'completing' AND i.version = ?
        AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = i.owner_id)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = i.id)
      RETURNING entry_id AS id`)
      .bind(id, parentId, name, result.size, result.etag, intentId, principalId, claim.version).first<{ id: string }>();
  }

  // Resolve a lost publication response without re-publishing or exposing the key.
  async getReceipt(principalId: string, intentId: string): Promise<{ id: string } | null> {
    return this.db.prepare(`SELECT entry_id AS id FROM drive_upload_publications
      WHERE intent_id = ? AND owner_id = ?
        AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)`)
      .bind(intentId, principalId, principalId).first<{ id: string }>();
  }

}
