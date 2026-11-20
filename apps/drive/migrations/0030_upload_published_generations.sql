-- Legacy publications keep NULL pins. Neither a key nor an ETag identifies
-- the provider or gives an old publication authority over that namespace.
ALTER TABLE drive_upload_publications ADD COLUMN completion_operation_id TEXT
  REFERENCES drive_upload_completion_receipts(operation_id);
ALTER TABLE drive_upload_publications ADD COLUMN evidence_revision TEXT CHECK (
  (completion_operation_id IS NULL) = (evidence_revision IS NULL)
);

CREATE VIEW drive_upload_completed_receipt_evidence AS
SELECT o.operation_id, o.intent_id, o.owner_id, o.object_key, o.upload_id, o.storage_epoch,
  b.endpoint, b.bucket, d.claim_version, s.size_bytes, r.etag, r.evidence_revision
FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)
JOIN drive_upload_completion_dispatches d USING (operation_id)
JOIN drive_upload_completion_receipts r USING (operation_id)
JOIN drive_upload_storage_bindings b ON b.intent_id = o.intent_id AND b.storage_epoch = o.storage_epoch
  AND b.endpoint = d.endpoint AND b.bucket = d.bucket
WHERE d.claim_version = o.intent_version + 1;

CREATE VIEW drive_upload_publishable_completions AS
SELECT e.*, auth.token_hash AS session_hash
FROM drive_upload_completed_receipt_evidence e
JOIN drive_upload_intents i ON i.id = e.intent_id AND i.owner_id = e.owner_id AND i.object_key = e.object_key
JOIN drive_active_members m ON m.id = i.owner_id
JOIN drive_sessions auth ON auth.principal_id = i.owner_id AND auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE i.state = 'completing' AND i.completion_acknowledged = 0 AND i.version = e.claim_version
  AND i.upload_id = e.upload_id AND i.declared_size = e.size_bytes
  AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = e.operation_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts a WHERE a.intent_id = e.intent_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims c WHERE c.intent_id = e.intent_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = e.intent_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_part_operations p JOIN drive_upload_part_observations u USING (operation_id)
    WHERE p.intent_id = e.intent_id AND u.kind = 'uncertain');

-- Keep the legacy attempt fence. A trusted publication instead has to match
-- the exact durable completion and reuse the atomic entry/journal trigger.
DROP TRIGGER drive_upload_publications_admit;
CREATE TRIGGER drive_upload_publications_admit BEFORE INSERT ON drive_upload_publications
WHEN (NEW.completion_operation_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM drive_upload_intents i JOIN drive_active_members m ON m.id = i.owner_id
  JOIN drive_upload_publication_attempts a ON a.intent_id = i.id
    AND a.object_key = i.object_key AND a.upload_id = i.upload_id
    AND a.version + 1 = i.version AND a.declared_size = i.declared_size
  WHERE i.id = NEW.intent_id AND i.owner_id = NEW.owner_id AND i.object_key = NEW.object_key
    AND i.state = 'completing' AND i.completion_acknowledged = 0 AND i.version = NEW.intent_version
    AND i.declared_size = NEW.size_bytes
)) OR (NEW.completion_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM drive_upload_publishable_completions e WHERE e.operation_id = NEW.completion_operation_id
    AND e.evidence_revision = NEW.evidence_revision AND e.etag = NEW.object_etag AND e.size_bytes = NEW.size_bytes
    AND e.claim_version = NEW.intent_version AND e.intent_id = NEW.intent_id
    AND e.owner_id = NEW.owner_id AND e.object_key = NEW.object_key
)) OR EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = NEW.intent_id)
   OR EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = NEW.intent_id)
BEGIN SELECT RAISE(ABORT, 'upload publication not admitted'); END;

-- A trusted dispatch uses its own quarantine ledger. Only the atomic
-- publication may settle its journal state; legacy recovery cannot do so.
CREATE TRIGGER drive_upload_trusted_dispatch_journal_fence
BEFORE UPDATE OF state, completion_acknowledged ON drive_upload_intents
WHEN OLD.state IN ('completing', 'uncertain')
  AND (NEW.state IS NOT OLD.state OR NEW.completion_acknowledged IS NOT OLD.completion_acknowledged)
  AND EXISTS (SELECT 1 FROM drive_upload_completion_operations o
    JOIN drive_upload_completion_dispatches d USING (operation_id) WHERE o.intent_id = OLD.id)
  AND NOT (OLD.state = 'completing' AND NEW.state = 'acknowledged' AND NEW.completion_acknowledged = 1
    AND NEW.version = OLD.version + 1 AND EXISTS (SELECT 1 FROM drive_upload_publications p
      WHERE p.intent_id = OLD.id AND p.intent_version = OLD.version AND p.completion_operation_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'trusted dispatch requires atomic publication'); END;

-- Receipt history, not a visibility or authorization query. The consumer
-- decides separately whether an entry can be served or its object removed.
CREATE VIEW drive_published_generations AS
SELECT p.entry_id, p.intent_id, p.owner_id, p.object_key, e.endpoint, e.bucket, e.storage_epoch,
  e.etag, e.size_bytes, e.evidence_revision
FROM drive_upload_publications p JOIN drive_upload_completed_receipt_evidence e
  ON e.operation_id = p.completion_operation_id AND e.evidence_revision = p.evidence_revision;
