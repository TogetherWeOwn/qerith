-- A bound manifest needs one exact-byte receipt per planned slot. The part
-- ledger already guarantees positive, unique slot numbers. The existing seal
-- guard checks canonical ordering, live allocation identity and uncertainty.
CREATE VIEW drive_upload_bound_manifest_mismatches AS
SELECT o.operation_id
FROM drive_upload_completion_operations o JOIN drive_upload_intents i ON i.id = o.intent_id
WHERE i.expected_part_sha256s IS NOT NULL AND (
  SELECT count(*) <> length(i.expected_part_sha256s) / 64 OR count(*) <> count(CASE WHEN
    p.part_number <= length(i.expected_part_sha256s) / 64
    AND p.size_bytes = min(16777216, i.declared_size - (p.part_number - 1) * 16777216)
    AND lower(hex(e.sha256)) = substr(i.expected_part_sha256s, (p.part_number - 1) * 64 + 1, 64)
    AND r.reported_etag = e.reported_etag THEN 1 END)
  FROM drive_upload_part_operations p
  LEFT JOIN drive_upload_part_byte_evidence e USING (operation_id)
  LEFT JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'reported'
  WHERE p.intent_id = o.intent_id
);

CREATE TRIGGER drive_upload_bound_manifest_guard_seal
BEFORE INSERT ON drive_upload_sealed_snapshots
WHEN EXISTS (SELECT 1 FROM drive_upload_bound_manifest_mismatches WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'bound upload manifest does not match acknowledged bytes'); END;

-- The legacy completion claim has no seal and cannot authorize a bound upload.
CREATE TRIGGER drive_upload_bound_manifest_guard_legacy_claim
BEFORE INSERT ON drive_upload_publication_attempts
WHEN EXISTS (SELECT 1 FROM drive_upload_intents WHERE id = NEW.intent_id AND expected_part_sha256s IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'bound upload completion requires a sealed manifest'); END;

-- Retain all existing candidate predicates and also fence any pre-upgrade
-- bound seal without exact evidence. No snapshots or receipts are rewritten.
DROP VIEW drive_upload_sealed_candidates;
CREATE VIEW drive_upload_sealed_candidates AS
SELECT o.*, s.part_numbers, s.size_bytes, b.endpoint, b.bucket, auth.token_hash AS session_hash
FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)
JOIN drive_upload_storage_bindings b ON b.intent_id = o.intent_id AND b.storage_epoch = o.storage_epoch
JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
JOIN drive_active_members m ON m.id = i.owner_id
JOIN drive_sessions auth ON auth.principal_id = i.owner_id AND auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.upload_id = o.upload_id
  AND i.version = o.intent_version AND o.intent_version < 9007199254740990
  AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_dispatches d WHERE d.operation_id = o.operation_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = o.intent_id)
  AND json_array_length(s.part_numbers) = (SELECT count(*) FROM drive_upload_part_operations p WHERE p.intent_id = o.intent_id)
  AND NOT EXISTS (
    SELECT 1 FROM drive_upload_part_operations p JOIN drive_upload_part_observations u USING (operation_id)
    WHERE p.intent_id = o.intent_id AND u.kind = 'uncertain'
  )
  AND NOT EXISTS (SELECT 1 FROM drive_upload_bound_manifest_mismatches bad WHERE bad.operation_id = o.operation_id);

-- Filter recorded receipts at admission and at the atomic publication insert:
-- drive_upload_publications_admit already requires this same live view.
DROP VIEW drive_upload_publishable_completions;
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
    WHERE p.intent_id = e.intent_id AND u.kind = 'uncertain')
  AND NOT EXISTS (SELECT 1 FROM drive_upload_bound_manifest_mismatches bad WHERE bad.operation_id = e.operation_id);

-- An unsealed legacy attempt already in flight cannot publish a bound upload.
CREATE TRIGGER drive_upload_bound_manifest_guard_legacy_publication
BEFORE INSERT ON drive_upload_publications
WHEN NEW.completion_operation_id IS NULL
  AND EXISTS (SELECT 1 FROM drive_upload_intents WHERE id = NEW.intent_id AND expected_part_sha256s IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'bound upload publication requires a sealed manifest'); END;
