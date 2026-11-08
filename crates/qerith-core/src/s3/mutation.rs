//! Synthetic mutation adapter over the shared catalogue. Not an HTTP endpoint,
//! durable store, encryption verifier, scheduler or production resource policy.
//!
//! The catalogue remains the sole logical-reference/generation/outbox authority.
//! This fixture owns immutable retained bytes and multipart staging. Its exclusive
//! `&mut self` is the serializable boundary for completion/abort/copy. Production
//! adapters must transact session evidence, retained-copy receipts and catalogue
//! publication together; cloning this model is not crash durability.

mod control;
pub use control::{completion_result, parse_complete, parse_delete, DeleteRequest};

use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

use super::{
    hex, storage_class, xml, ChecksumAlgorithm, Conditions, ErrorCode, Headers, ObjectMetadata,
    Policy, Response, Result, StoredChecksum, UploadValidator, VerifiedRequest,
};
use crate::catalogue::{
    self as cat, Action, Authority, Checksum, ChecksumType, CiphertextIdentity, CiphertextMetadata,
    CompleteCopy, GenerationId, JobPort, MemoryCatalogue, MetadataOutbox, Mutation,
    MutationTargets, OperationId, Outcome, Reference, ReferenceView, TenantId,
};

/// Deliberately no Default. Numbers are explicit synthetic fixture inputs, not
/// advertised service limits. One lifetime bounds sessions/retry evidence; polls
/// and replacement parts never extend it. No automatic background cleanup runs.
#[derive(Clone, Debug)]
pub struct MutationPolicy {
    pub object_bytes: usize,
    pub part_bytes: usize,
    pub min_part_bytes: usize,
    pub parts: u16,
    pub sessions: usize,
    pub staged_bytes: usize,
    pub batch_keys: usize,
    pub lifetime: u64,
    pub result_retention: u64,
    pub max_attempts: u32,
}

impl MutationPolicy {
    fn validate(&self) -> Result<()> {
        if self.object_bytes == 0
            || self.part_bytes == 0
            || self.min_part_bytes == 0
            || self.min_part_bytes > self.part_bytes
            || self.part_bytes > self.object_bytes
            || self.parts == 0
            || self.parts > 10_000
            || self.sessions == 0
            || self.staged_bytes < self.part_bytes
            || self.batch_keys == 0
            || self.batch_keys > 1000
            || self.lifetime == 0
            || self.result_retention == 0
            || self.max_attempts == 0
        {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(())
    }
}

/// Body receipt can only be created by the merged decoded-C validator. Bytes
/// remain bound to that receipt, including empty and binary bodies.
#[derive(Clone, Debug)]
pub struct ValidatedBody {
    bytes: Vec<u8>,
    sha256: [u8; 32],
    checksum: Option<(ChecksumAlgorithm, Vec<u8>)>,
}

impl ValidatedBody {
    pub fn new(
        bytes: Vec<u8>,
        headers: &Headers,
        verified: &VerifiedRequest,
        policy: &Policy,
    ) -> Result<Self> {
        let mut validator = UploadValidator::new(headers, verified, policy)?;
        validator.push_decoded(&bytes)?;
        let receipt = validator.finish()?;
        let checksum = receipt
            .checksum()
            .map(|(a, value)| super::upload::digest_value(value, a.size()).map(|value| (*a, value)))
            .transpose()?;
        Ok(Self {
            sha256: *receipt.sha256(),
            bytes,
            checksum,
        })
    }
}

/// Trusted recovery/context references, never encryption keys or client claims
/// of proved encryption. Context compatibility must come from the accepted format
/// adapter. A different context requires client re-encryption via a new upload.
#[derive(Clone, Debug)]
pub struct UploadMetadata {
    pub headers: BTreeMap<String, String>,
    pub recovery_ref: String,
    pub encryption_context: String,
}

impl UploadMetadata {
    pub fn from_headers(
        headers: &Headers,
        recovery_ref: String,
        encryption_context: String,
    ) -> Result<Self> {
        headers.validate_features()?;
        let value = Self {
            headers: headers
                .iter()
                .filter(|(k, _)| super::wire::persistent_metadata(k))
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect(),
            recovery_ref,
            encryption_context,
        };
        value.validate()?;
        Ok(value)
    }

    fn validate(&self) -> Result<()> {
        if self.recovery_ref.is_empty() || self.encryption_context.is_empty() {
            return Err(ErrorCode::InvalidArgument);
        }
        ObjectMetadata::new(
            "validation".into(),
            0,
            "\"validation\"".into(),
            0,
            self.headers.clone().into_iter().collect(),
            None,
        )?;
        Ok(())
    }
}

/// Mutation predicates are deliberately limited to strong If-Match or
/// If-None-Match: *. Unknown/multiple/weak predicates are rejected, not ignored.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DestinationConditions {
    pub if_match: Option<String>,
    pub if_none_match: bool,
}

impl DestinationConditions {
    pub fn from_headers(headers: &Headers) -> Result<Self> {
        if headers.get("if-modified-since").is_some()
            || headers.get("if-unmodified-since").is_some()
            || headers.get("if-none-match").is_some_and(|v| v != "*")
        {
            return Err(ErrorCode::InvalidRequest);
        }
        Ok(Self {
            if_match: headers.get("if-match").map(str::to_owned),
            if_none_match: headers.get("if-none-match").is_some(),
        })
    }

    fn evaluate(&self, view: Option<&ReferenceView>) -> Result<()> {
        if self.if_none_match && self.if_match.is_some() {
            return Err(ErrorCode::InvalidRequest);
        }
        if let Some(tag) = &self.if_match {
            ObjectMetadata::new("predicate".into(), 0, tag.clone(), 0, vec![], None)?;
            if view.is_none_or(|v| v.metadata.validator != *tag) {
                return Err(ErrorCode::PreconditionFailed);
            }
        }
        if self.if_none_match && view.is_some() {
            return Err(ErrorCode::PreconditionFailed);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct UploadId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MultipartChecksum {
    None,
    Full(ChecksumAlgorithm),
    CompositeSha256,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartEvidence {
    pub number: u16,
    pub etag: String,
    pub checksum: Option<Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct PartView {
    pub evidence: PartEvidence,
    pub length: usize,
}

#[derive(Clone, Debug)]
pub struct UploadView {
    pub id: UploadId,
    pub reference: Reference,
    pub expires: u64,
}

#[derive(Clone, Debug)]
pub struct Page<T> {
    pub entries: Vec<T>,
    pub next: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct PreparedWrite {
    reference: Reference,
    revision: u64,
    conditions: DestinationConditions,
    metadata: UploadMetadata,
    expires: u64,
}

#[derive(Clone)]
struct Part {
    body: ValidatedBody,
    evidence: PartEvidence,
}

#[derive(Clone)]
struct Session {
    prepared: PreparedWrite,
    checksum: MultipartChecksum,
    parts: BTreeMap<u16, Part>,
    attempts: u32,
    result: Option<(Vec<PartEvidence>, CommitResult, u64)>,
}

#[derive(Clone)]
struct Retained {
    bytes: Vec<u8>,
    context: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitResult {
    pub generation: GenerationId,
    pub etag: String,
    pub checksum: Option<Checksum>,
}

impl CommitResult {
    /// Only constructed after catalogue + complete retained bytes + archive job.
    pub fn response(&self, root: &str) -> Result<Response> {
        if !matches!(root, "CompleteMultipartUploadResult" | "CopyObjectResult") {
            return Err(ErrorCode::InvalidArgument);
        }
        let checksum = self.checksum.as_ref().map_or(String::new(), |c| {
            let value = checksum_value(c);
            format!(
                "<Checksum{}>{}</Checksum{}><ChecksumType>{}</ChecksumType>",
                c.algorithm,
                xml(&value),
                c.algorithm,
                if c.kind == ChecksumType::Composite {
                    "COMPOSITE"
                } else {
                    "FULL_OBJECT"
                }
            )
        });
        Ok(xml_response(format!(
            "<{root}><ETag>{}</ETag>{checksum}</{root}>",
            xml(&self.etag)
        )))
    }

    pub fn put_response(&self) -> Response {
        let mut headers = vec![("etag".into(), self.etag.clone())];
        if let Some(c) = &self.checksum {
            headers.push((
                format!("x-amz-checksum-{}", c.algorithm.to_ascii_lowercase()),
                checksum_value(c),
            ));
            headers.push((
                "x-amz-checksum-type".into(),
                if c.kind == ChecksumType::Composite {
                    "COMPOSITE"
                } else {
                    "FULL_OBJECT"
                }
                .into(),
            ));
        }
        Response {
            status: 200,
            headers,
            body: vec![],
        }
    }
}

fn checksum_value(c: &Checksum) -> String {
    let value = STANDARD.encode(&c.value);
    if c.kind == ChecksumType::Composite {
        format!("{value}-{}", c.parts.len())
    } else {
        value
    }
}

fn xml_response(body: String) -> Response {
    Response {
        status: 200,
        headers: vec![("content-type".into(), "application/xml".into())],
        body: body.into_bytes(),
    }
}

fn empty_response() -> Response {
    Response {
        status: 204,
        headers: vec![],
        body: vec![],
    }
}

fn map_error(error: cat::Error) -> ErrorCode {
    match error {
        cat::Error::Unavailable => ErrorCode::AccessDenied,
        cat::Error::Conflict | cat::Error::Fenced => ErrorCode::ConditionalRequestConflict,
        cat::Error::Expired => ErrorCode::NoSuchUpload,
        cat::Error::Invalid => ErrorCode::InvalidRequest,
        _ => ErrorCode::InternalError,
    }
}

fn permit(authority: &dyn Authority, reference: &Reference, action: Action) -> Result<()> {
    if !authority.is_current() || !authority.permits(reference, action) {
        return Err(ErrorCode::AccessDenied);
    }
    Ok(())
}

/// A single-process executable specification. Clone snapshots keep catalogue,
/// bytes, context and session/result evidence together for reconciliation tests;
/// they are NOT a persistence/restart format or a claim of durable commits.
#[derive(Clone)]
pub struct MemoryMutations {
    catalogue: MemoryCatalogue,
    retained: BTreeMap<(TenantId, GenerationId), Retained>,
    sessions: BTreeMap<(TenantId, UploadId), Session>,
    policy: MutationPolicy,
    sequence: u64,
}

impl MemoryMutations {
    pub fn new(policy: MutationPolicy) -> Result<Self> {
        policy.validate()?;
        Ok(Self {
            catalogue: MemoryCatalogue::default(),
            retained: BTreeMap::new(),
            sessions: BTreeMap::new(),
            policy,
            sequence: 0,
        })
    }
    pub fn catalogue(&self) -> &MemoryCatalogue {
        &self.catalogue
    }
    /// Trusted worker fixtures only. Not exposed as an end-user mutation port.
    pub fn catalogue_worker(&mut self) -> &mut MemoryCatalogue {
        &mut self.catalogue
    }

    fn allocate(&mut self) -> Result<u64> {
        self.sequence = self.sequence.checked_add(1).ok_or(ErrorCode::SlowDown)?;
        Ok(self.sequence)
    }

    pub fn prepare(
        &self,
        reference: Reference,
        metadata: UploadMetadata,
        conditions: DestinationConditions,
        class: Option<&str>,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<PreparedWrite> {
        permit(authority, &reference, Action::Write)?;
        metadata.validate()?;
        storage_class(class)?;
        if reference.name.is_empty() {
            return Err(ErrorCode::InvalidArgument);
        }
        let (revision, current) = self
            .catalogue
            .write_target(reference.tenant, &reference.name, now, authority)
            .map_err(map_error)?;
        conditions.evaluate(current.as_ref())?;
        let expires = now
            .checked_add(self.policy.lifetime)
            .ok_or(ErrorCode::InvalidArgument)?;
        Ok(PreparedWrite {
            reference,
            revision,
            conditions,
            metadata,
            expires,
        })
    }

    fn final_target(
        &self,
        prepared: &PreparedWrite,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()> {
        permit(authority, &prepared.reference, Action::Write)?;
        if now >= prepared.expires {
            return Err(ErrorCode::NoSuchUpload);
        }
        let (revision, current) = self
            .catalogue
            .write_target(
                prepared.reference.tenant,
                &prepared.reference.name,
                now,
                authority,
            )
            .map_err(map_error)?;
        prepared.conditions.evaluate(current.as_ref())?;
        if revision != prepared.revision {
            return Err(ErrorCode::ConditionalRequestConflict);
        }
        Ok(())
    }

    pub fn put(
        &mut self,
        prepared: PreparedWrite,
        body: ValidatedBody,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<CommitResult> {
        let checksums = body
            .checksum
            .as_ref()
            .map(|(a, value)| full_checksum(*a, value.clone(), vec![]))
            .into_iter()
            .collect();
        self.commit(&prepared, body, checksums, now, authority)
    }

    fn commit(
        &mut self,
        prepared: &PreparedWrite,
        body: ValidatedBody,
        checksums: Vec<Checksum>,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<CommitResult> {
        self.final_target(prepared, now, authority)?;
        if body.bytes.len() > self.policy.object_bytes {
            return Err(ErrorCode::EntityTooLarge);
        }
        let generation = GenerationId(self.allocate()?);
        let begin = OperationId(self.allocate()?);
        let commit = OperationId(self.allocate()?);
        let etag = format!("\"g-{}-{}\"", prepared.reference.tenant.0, generation.0);
        let identity = CiphertextIdentity {
            length: body.bytes.len() as u64,
            sha256: body.sha256,
        };
        let metadata = CiphertextMetadata {
            identity: identity.clone(),
            validator: etag.clone(),
            modified_at: now,
            headers: prepared.metadata.headers.clone(),
            checksums: checksums.clone(),
            recovery_ref: prepared.metadata.recovery_ref.clone(),
        };
        let copy = CompleteCopy {
            identity,
            checksums: checksums.clone(),
            location: format!(
                "fixture/{}/{}/retained",
                prepared.reference.tenant.0, generation.0
            ),
            receipt: format!("verified-{}", hex(&body.sha256)),
        };
        // The fixture rolls back both metadata operations on any failure. A real
        // adapter must implement this as a storage/catalogue transaction, not clone.
        let mut staged = self.catalogue.clone();
        staged
            .transact(
                prepared.reference.tenant,
                begin,
                Mutation::BeginUpload {
                    name: prepared.reference.name.clone(),
                    expected_revision: prepared.revision,
                    generation,
                    metadata,
                    archive_deadline: prepared.expires,
                },
                now,
                authority,
            )
            .map_err(map_error)?;
        let result = staged
            .transact(
                prepared.reference.tenant,
                commit,
                Mutation::CommitUpload {
                    intent: begin,
                    copy,
                },
                now,
                authority,
            )
            .map_err(map_error)?;
        if !matches!(result, Outcome::Committed { .. }) {
            return Err(ErrorCode::InternalError);
        }
        self.retained.insert(
            (prepared.reference.tenant, generation),
            Retained {
                bytes: body.bytes,
                context: prepared.metadata.encryption_context.clone(),
            },
        );
        self.catalogue = staged;
        Ok(CommitResult {
            generation,
            etag,
            checksum: checksums.into_iter().next(),
        })
    }

    pub fn delete(
        &mut self,
        reference: &Reference,
        conditions: &DestinationConditions,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Response> {
        permit(authority, reference, Action::Write)?;
        let (revision, current) = self
            .catalogue
            .write_target(reference.tenant, &reference.name, now, authority)
            .map_err(map_error)?;
        conditions.evaluate(current.as_ref())?;
        let operation = OperationId(self.allocate()?);
        self.catalogue
            .transact(
                reference.tenant,
                operation,
                Mutation::Tombstone {
                    name: reference.name.clone(),
                    expected_revision: revision,
                },
                now,
                authority,
            )
            .map_err(map_error)?;
        // Never delete physical bytes here: other references/pins/jobs may need
        // them. The shared catalogue's deletion worker owns reference-safe cleanup.
        Ok(empty_response())
    }

    pub fn delete_objects(
        &mut self,
        tenant: TenantId,
        request: DeleteRequest,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Response> {
        if request.keys.is_empty() || request.keys.len() > self.policy.batch_keys {
            return Err(ErrorCode::InvalidRequest);
        }
        let mut body = String::from("<DeleteResult>");
        for key in request.keys {
            let reference = Reference {
                tenant,
                name: key.clone(),
            };
            match self.delete(
                &reference,
                &DestinationConditions::default(),
                now,
                authority,
            ) {
                Ok(_) if !request.quiet => {
                    body.push_str(&format!("<Deleted><Key>{}</Key></Deleted>", xml(&key)))
                }
                Ok(_) => (),
                Err(error) => body.push_str(&format!(
                    "<Error><Key>{}</Key><Code>{error:?}</Code></Error>",
                    xml(&key)
                )),
            }
        }
        body.push_str("</DeleteResult>");
        Ok(xml_response(body))
    }

    pub fn initiate(
        &mut self,
        prepared: PreparedWrite,
        checksum: MultipartChecksum,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<UploadId> {
        self.final_target(&prepared, now, authority)?;
        let tenant = prepared.reference.tenant;
        if self.sessions.keys().filter(|(t, _)| *t == tenant).count() >= self.policy.sessions {
            return Err(ErrorCode::SlowDown);
        }
        let id = UploadId(self.allocate()?);
        self.sessions.insert(
            (tenant, id),
            Session {
                prepared,
                checksum,
                parts: BTreeMap::new(),
                attempts: 0,
                result: None,
            },
        );
        Ok(id)
    }

    fn session(
        &self,
        reference: &Reference,
        id: UploadId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<&Session> {
        permit(authority, reference, Action::Write)?;
        let s = self
            .sessions
            .get(&(reference.tenant, id))
            .filter(|s| s.prepared.reference == *reference)
            .ok_or(ErrorCode::NoSuchUpload)?;
        if s.result.is_none() && now >= s.prepared.expires {
            return Err(ErrorCode::NoSuchUpload);
        }
        Ok(s)
    }

    pub fn upload_part(
        &mut self,
        reference: &Reference,
        id: UploadId,
        number: u16,
        body: ValidatedBody,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<PartEvidence> {
        let session = self.session(reference, id, now, authority)?;
        if session.result.is_some() {
            return Err(ErrorCode::NoSuchUpload);
        }
        if number == 0 || number > self.policy.parts {
            return Err(ErrorCode::InvalidArgument);
        }
        if body.bytes.len() > self.policy.part_bytes {
            return Err(ErrorCode::EntityTooLarge);
        }
        let expected = match session.checksum {
            MultipartChecksum::None => None,
            MultipartChecksum::Full(a) => Some(a),
            MultipartChecksum::CompositeSha256 => Some(ChecksumAlgorithm::Sha256),
        };
        if body.checksum.as_ref().map(|(a, _)| *a) != expected {
            return Err(ErrorCode::InvalidRequest);
        }
        let replaced = session.parts.get(&number).map_or(0, |p| p.body.bytes.len());
        let staged = self
            .sessions
            .iter()
            .filter(|((t, _), _)| *t == reference.tenant)
            .flat_map(|(_, s)| s.parts.values())
            .try_fold(0usize, |n, p| n.checked_add(p.body.bytes.len()))
            .ok_or(ErrorCode::SlowDown)?;
        if staged
            .checked_sub(replaced)
            .and_then(|n| n.checked_add(body.bytes.len()))
            .is_none_or(|n| n > self.policy.staged_bytes)
        {
            return Err(ErrorCode::SlowDown);
        }
        let token = self.allocate()?;
        let evidence = PartEvidence {
            number,
            etag: format!("\"p-{}-{}-{token}\"", id.0, number),
            checksum: body.checksum.as_ref().map(|(_, v)| v.clone()),
        };
        self.sessions
            .get_mut(&(reference.tenant, id))
            .ok_or(ErrorCode::NoSuchUpload)?
            .parts
            .insert(
                number,
                Part {
                    body,
                    evidence: evidence.clone(),
                },
            );
        Ok(evidence)
    }

    pub fn list_parts(
        &self,
        reference: &Reference,
        id: UploadId,
        after: u16,
        limit: usize,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Page<PartView>> {
        if limit == 0 || limit > usize::from(self.policy.parts) {
            return Err(ErrorCode::InvalidArgument);
        }
        let s = self.session(reference, id, now, authority)?;
        if s.result.is_some() {
            return Err(ErrorCode::NoSuchUpload);
        }
        let mut values = s.parts.values().filter(|p| p.evidence.number > after);
        let entries: Vec<_> = values
            .by_ref()
            .take(limit)
            .map(|p| PartView {
                evidence: p.evidence.clone(),
                length: p.body.bytes.len(),
            })
            .collect();
        let next = if values.next().is_some() {
            entries.last().map(|p| u64::from(p.evidence.number))
        } else {
            None
        };
        Ok(Page { entries, next })
    }

    /// No existence oracle: only independently write-authorized sessions are
    /// listed. The trusted adapter scopes names to the authenticated bucket.
    pub fn list_uploads(
        &self,
        tenant: TenantId,
        prefix: &str,
        after: u64,
        limit: usize,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Page<UploadView>> {
        if !authority.is_current() {
            return Err(ErrorCode::AccessDenied);
        }
        if limit == 0 || limit > self.policy.sessions {
            return Err(ErrorCode::InvalidArgument);
        }
        let mut values = self.sessions.iter().filter(|((t, id), s)| {
            *t == tenant
                && id.0 > after
                && s.result.is_none()
                && now < s.prepared.expires
                && s.prepared.reference.name.starts_with(prefix)
                && authority.permits(&s.prepared.reference, Action::Write)
        });
        let entries: Vec<_> = values
            .by_ref()
            .take(limit)
            .map(|((_, id), s)| UploadView {
                id: *id,
                reference: s.prepared.reference.clone(),
                expires: s.prepared.expires,
            })
            .collect();
        let next = if values.next().is_some() {
            entries.last().map(|u| u.id.0)
        } else {
            None
        };
        Ok(Page { entries, next })
    }

    pub fn complete(
        &mut self,
        reference: &Reference,
        id: UploadId,
        evidence: Vec<PartEvidence>,
        full_checksum: Option<Vec<u8>>,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<CommitResult> {
        let s = self.session(reference, id, now, authority)?.clone();
        if let Some((accepted, result, until)) = &s.result {
            if now >= *until {
                return Err(ErrorCode::NoSuchUpload);
            }
            if accepted != &evidence
                || full_checksum.as_ref()
                    != result
                        .checksum
                        .as_ref()
                        .filter(|c| c.kind == ChecksumType::FullObject)
                        .map(|c| &c.value)
            {
                return Err(ErrorCode::InvalidPart);
            }
            // Replay of this exact accepted request only, even after overwrite.
            return Ok(result.clone());
        }
        if s.attempts >= self.policy.max_attempts {
            return Err(ErrorCode::SlowDown);
        }
        self.sessions
            .get_mut(&(reference.tenant, id))
            .ok_or(ErrorCode::NoSuchUpload)?
            .attempts += 1;
        if evidence.is_empty() || evidence.len() > usize::from(self.policy.parts) {
            return Err(ErrorCode::InvalidPart);
        }
        if evidence.windows(2).any(|w| w[0].number >= w[1].number) {
            return Err(ErrorCode::InvalidPartOrder);
        }
        let mut bytes = Vec::new();
        let mut parts = Vec::new();
        for (index, e) in evidence.iter().enumerate() {
            let p = s
                .parts
                .get(&e.number)
                .filter(|p| p.evidence == *e)
                .ok_or(ErrorCode::InvalidPart)?;
            if index + 1 < evidence.len() && p.body.bytes.len() < self.policy.min_part_bytes {
                return Err(ErrorCode::EntityTooSmall);
            }
            if bytes
                .len()
                .checked_add(p.body.bytes.len())
                .is_none_or(|n| n > self.policy.object_bytes)
            {
                return Err(ErrorCode::EntityTooLarge);
            }
            bytes.extend_from_slice(&p.body.bytes);
            if let Some(value) = &e.checksum {
                parts.push(value.clone());
            }
        }
        let sha256: [u8; 32] = Sha256::digest(&bytes).into();
        let checksums = match s.checksum {
            MultipartChecksum::None => {
                if full_checksum.is_some() {
                    return Err(ErrorCode::InvalidRequest);
                }
                vec![]
            }
            MultipartChecksum::Full(a) => {
                let actual = match a {
                    ChecksumAlgorithm::Sha256 => sha256.to_vec(),
                    ChecksumAlgorithm::Crc32 => crc32fast::hash(&bytes).to_be_bytes().to_vec(),
                };
                if full_checksum.as_ref() != Some(&actual) {
                    return Err(ErrorCode::BadDigest);
                }
                vec![self::full_checksum(a, actual, parts)]
            }
            MultipartChecksum::CompositeSha256 => {
                if full_checksum.is_some() {
                    return Err(ErrorCode::InvalidRequest);
                }
                let stored = StoredChecksum::composite_sha256(
                    parts.iter().map(|p| STANDARD.encode(p)).collect(),
                )?;
                let value = stored
                    .value()
                    .split_once('-')
                    .ok_or(ErrorCode::InternalError)?
                    .0;
                vec![Checksum {
                    algorithm: "SHA256".into(),
                    kind: ChecksumType::Composite,
                    value: super::upload::digest_value(value, 32)?,
                    parts,
                }]
            }
        };
        let until = now
            .checked_add(self.policy.result_retention)
            .ok_or(ErrorCode::InvalidArgument)?;
        let result = self.commit(
            &s.prepared,
            ValidatedBody {
                bytes,
                sha256,
                checksum: None,
            },
            checksums,
            now,
            authority,
        )?;
        let s = self
            .sessions
            .get_mut(&(reference.tenant, id))
            .ok_or(ErrorCode::InternalError)?;
        s.parts.clear();
        s.result = Some((evidence, result.clone(), until));
        Ok(result)
    }

    pub fn abort(
        &mut self,
        reference: &Reference,
        id: UploadId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Response> {
        let s = self.session(reference, id, now, authority)?;
        if s.result.is_some() {
            return Err(ErrorCode::NoSuchUpload);
        }
        self.sessions.remove(&(reference.tenant, id));
        Ok(empty_response())
    }

    /// Explicit bounded pass over expired staging/result evidence only. It never
    /// deletes retained generations or promises erasure from an archival system.
    pub fn cleanup(&mut self, now: u64, limit: usize) -> Result<usize> {
        if limit == 0 || limit > self.policy.sessions {
            return Err(ErrorCode::InvalidArgument);
        }
        let expired: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, s)| {
                now >= s
                    .result
                    .as_ref()
                    .map_or(s.prepared.expires, |(_, _, until)| *until)
            })
            .take(limit)
            .map(|(id, _)| *id)
            .collect();
        for id in &expired {
            self.sessions.remove(id);
        }
        Ok(expired.len())
    }
}

fn full_checksum(algorithm: ChecksumAlgorithm, value: Vec<u8>, parts: Vec<Vec<u8>>) -> Checksum {
    Checksum {
        algorithm: match algorithm {
            ChecksumAlgorithm::Sha256 => "SHA256",
            ChecksumAlgorithm::Crc32 => "CRC32",
        }
        .into(),
        kind: ChecksumType::FullObject,
        value,
        parts,
    }
}

#[derive(Clone, Debug)]
pub enum MetadataDirective {
    Copy,
    Replace,
}

#[derive(Clone, Debug)]
pub struct CopySource {
    pub reference: Reference,
    pub generation: GenerationId,
    pub conditions: Conditions,
}

impl CopySource {
    /// Uses the same once-only path decoder as signed requests. This profile has
    /// no public versioning: any query/version selector fails before effects.
    pub fn from_headers(
        tenant: TenantId,
        generation: GenerationId,
        headers: &Headers,
        policy: &Policy,
    ) -> Result<Self> {
        headers.validate_features()?;
        let value = headers
            .get("x-amz-copy-source")
            .ok_or(ErrorCode::InvalidRequest)?;
        let target = super::Target::parse(value, policy)?;
        if !target.query().is_empty() {
            return Err(ErrorCode::InvalidRequest);
        }
        let key = target
            .key
            .filter(|key| !key.is_empty())
            .ok_or(ErrorCode::InvalidRequest)?;
        Ok(Self {
            reference: Reference {
                tenant,
                name: format!("{}/{key}", target.bucket),
            },
            generation,
            conditions: Conditions {
                if_match: headers.get("x-amz-copy-source-if-match").map(str::to_owned),
                if_none_match: headers
                    .get("x-amz-copy-source-if-none-match")
                    .map(str::to_owned),
                if_modified_since: headers
                    .get("x-amz-copy-source-if-modified-since")
                    .map(str::to_owned),
                if_unmodified_since: headers
                    .get("x-amz-copy-source-if-unmodified-since")
                    .map(str::to_owned),
            },
        })
    }
}

impl MetadataDirective {
    pub fn parse(value: Option<&str>) -> Result<Self> {
        match value {
            None | Some("COPY") => Ok(Self::Copy),
            Some("REPLACE") => Ok(Self::Replace),
            _ => Err(ErrorCode::InvalidRequest),
        }
    }
}

struct CopyAuthority<'a> {
    inner: &'a dyn Authority,
    source: &'a Reference,
}
impl Authority for CopyAuthority<'_> {
    fn is_current(&self) -> bool {
        self.inner.is_current() && self.inner.permits(self.source, Action::Read)
    }
    fn permits(&self, reference: &Reference, action: Action) -> bool {
        self.inner.permits(reference, action)
    }
}

impl MemoryMutations {
    fn source(
        &self,
        source: &CopySource,
        context: &str,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<(ValidatedBody, ReferenceView)> {
        permit(authority, &source.reference, Action::Read)?;
        let view = self
            .catalogue
            .lookup(
                source.reference.tenant,
                &source.reference.name,
                now,
                authority,
            )
            .map_err(map_error)?;
        if view.generation != source.generation {
            return Err(ErrorCode::PreconditionFailed);
        }
        let metadata = ObjectMetadata::new(
            format!("{}", view.generation.0),
            view.metadata.identity.length,
            view.metadata.validator.clone(),
            i64::try_from(view.metadata.modified_at).map_err(|_| ErrorCode::InternalError)?,
            vec![],
            None,
        )?;
        // Reuse the shared predicate precedence; false means a mutation 412,
        // never the read-side 304 result. Predicates precede cold-state checks.
        if !source.conditions.evaluate(&metadata)? {
            return Err(ErrorCode::PreconditionFailed);
        }
        if view.availability_until.is_none() {
            return Err(ErrorCode::InvalidObjectState);
        }
        let retained = self
            .retained
            .get(&(source.reference.tenant, source.generation))
            .ok_or(ErrorCode::InternalError)?;
        if retained.context != context {
            return Err(ErrorCode::InvalidRequest);
        }
        let generation = self
            .catalogue
            .generation(source.reference.tenant, source.generation)
            .map_err(map_error)?;
        if generation.cache_location.is_none()
            || retained.bytes.len() as u64 != view.metadata.identity.length
            || <[u8; 32]>::from(Sha256::digest(&retained.bytes)) != view.metadata.identity.sha256
        {
            return Err(ErrorCode::InternalError);
        }
        Ok((
            ValidatedBody {
                bytes: retained.bytes.clone(),
                sha256: view.metadata.identity.sha256,
                checksum: None,
            },
            view,
        ))
    }

    pub fn copy_object(
        &mut self,
        mut destination: PreparedWrite,
        source: CopySource,
        directive: MetadataDirective,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<CommitResult> {
        self.final_target(&destination, now, authority)?;
        let (body, view) = self.source(
            &source,
            &destination.metadata.encryption_context,
            now,
            authority,
        )?;
        if matches!(directive, MetadataDirective::Copy) {
            destination.metadata.headers = view.metadata.headers;
        }
        // A new generation, recovery reference and archival obligation, not Link.
        let guarded = CopyAuthority {
            inner: authority,
            source: &source.reference,
        };
        self.commit(&destination, body, view.metadata.checksums, now, &guarded)
    }

    #[allow(clippy::too_many_arguments)] // Explicit source/destination, part and clock boundaries.
    pub fn upload_part_copy(
        &mut self,
        reference: &Reference,
        id: UploadId,
        number: u16,
        source: CopySource,
        range: Option<(usize, usize)>,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<PartEvidence> {
        let session = self.session(reference, id, now, authority)?;
        if session.result.is_some() {
            return Err(ErrorCode::NoSuchUpload);
        }
        let checksum = session.checksum;
        let (mut body, _) = self.source(
            &source,
            &session.prepared.metadata.encryption_context,
            now,
            authority,
        )?;
        if let Some((start, end)) = range {
            if start > end || end >= body.bytes.len() {
                return Err(ErrorCode::InvalidRange);
            }
            body.bytes = body.bytes[start..=end].to_vec();
            body.sha256 = Sha256::digest(&body.bytes).into();
        }
        body.checksum = match checksum {
            MultipartChecksum::None => None,
            MultipartChecksum::CompositeSha256
            | MultipartChecksum::Full(ChecksumAlgorithm::Sha256) => {
                Some((ChecksumAlgorithm::Sha256, body.sha256.to_vec()))
            }
            MultipartChecksum::Full(ChecksumAlgorithm::Crc32) => Some((
                ChecksumAlgorithm::Crc32,
                crc32fast::hash(&body.bytes).to_be_bytes().to_vec(),
            )),
        };
        let guarded = CopyAuthority {
            inner: authority,
            source: &source.reference,
        };
        self.upload_part(reference, id, number, body, now, &guarded)
    }
}
