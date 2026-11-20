// These predicates qualify a generation for an already authorized entry (e).
export const publishedGenerationJoins = `
  JOIN drive_published_generations g ON g.entry_id = e.id AND g.owner_id = e.owner_id
    AND g.object_key = e.object_key AND g.size_bytes = e.size_bytes
  JOIN drive_upload_publications p ON p.entry_id = g.entry_id
    AND p.object_etag = g.etag AND p.size_bytes = g.size_bytes`;

export const publishedGenerationFilter = `e.kind = 'file' AND g.endpoint = ? AND g.bucket = ? AND g.storage_epoch = ?
  AND NOT EXISTS (SELECT 1 FROM drive_deleted_entries d WHERE d.entry_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = g.intent_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims c WHERE c.intent_id = g.intent_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = p.completion_operation_id)`;
