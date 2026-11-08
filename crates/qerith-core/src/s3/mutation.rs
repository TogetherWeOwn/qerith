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

use std::collections::{BTreeMap, BTreeSet};

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

use super::{
    hex, storage_class, xml as escape_xml, ChecksumAlgorithm, Conditions, ErrorCode, Headers,
    ObjectMetadata, Policy, Response, Result, StoredChecksum, UploadValidator, VerifiedRequest,
};
use crate::catalogue::{
    self as cat, Action, Authority, Checksum, ChecksumType, CiphertextIdentity, CiphertextMetadata,
    CompleteCopy, GenerationId, JobPort, MemoryCatalogue, MetadataOutbox, Mutation,
    MutationTargets, OperationId, Outcome, Reference, ReferenceView, TenantId, WriteTarget,
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
    /// Archive work gets this full window from successful commit, not preparation.
    pub archive_window: u64,
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
            || self.archive_window == 0
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

    fn evaluate(&self, view: Option<&WriteTarget>) -> Result<()> {
        if self.if_none_match && self.if_match.is_some() {
            return Err(ErrorCode::InvalidRequest);
        }
        if let Some(tag) = &self.if_match {
            ObjectMetadata::new("predicate".into(), 0, tag.clone(), 0, vec![], None)?;
            if view.is_none_or(|v| v.validator != *tag) {
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleanupPass {
    pub examined: usize,
    pub removed: usize,
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
    destination: Reference,
    modified_at: String,
}

impl CommitResult {
    /// Render the committed destination, never a caller-selected replacement key.
    /// The policy host is trusted ingress configuration, not a request Host header.
    pub fn complete_response(&self, target: &super::Target, policy: &Policy) -> Result<Response> {
        let key = target.key.as_deref().ok_or(ErrorCode::InvalidArgument)?;
        if self.destination.name != format!("{}/{key}", target.bucket) {
            return Err(ErrorCode::InvalidArgument);
        }
        let location = format!("https://{}{}", policy.host, target.canonical_path());
        Ok(self.result_response(
            "CompleteMultipartUploadResult",
            &format!(
                "<Location>{}</Location><Bucket>{}</Bucket><Key>{}</Key>",
                xml(&location),
                xml(&target.bucket),
                xml(key)
            ),
        ))
    }

    pub fn copy_response(&self) -> Response {
        self.result_response(
            "CopyObjectResult",
            &format!("<LastModified>{}</LastModified>", xml(&self.modified_at)),
        )
    }

    fn result_response(&self, root: &str, fields: &str) -> Response {
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
        xml_response(format!(
            "<{root}>{fields}<ETag>{}</ETag>{checksum}</{root}>",
            xml(&self.etag)
        ))
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

fn xml(value: &str) -> String {
    // XML 1.0 normalizes literal CR; a character reference preserves the key.
    escape_xml(value).replace('\r', "&#13;")
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
    // Format context is generation metadata, not a property of a transient cache.
    contexts: BTreeMap<(TenantId, GenerationId), String>,
    sessions: BTreeMap<(TenantId, UploadId), Session>,
    expiry: BTreeSet<(u64, TenantId, UploadId)>,
    policy: MutationPolicy,
    sequence: u64,
}

impl MemoryMutations {
    pub fn new(policy: MutationPolicy) -> Result<Self> {
        policy.validate()?;
        Ok(Self {
            catalogue: MemoryCatalogue::default(),
            retained: BTreeMap::new(),
            contexts: BTreeMap::new(),
            sessions: BTreeMap::new(),
            expiry: BTreeSet::new(),
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

    /// Trusted worker-only storage operation. Dispatch is obtained here, not
    /// accepted from public DeletionDispatch fields. Exclusive access keeps its
    /// current-authority/proof checks, physical fixture deletion and ack atomic.
    pub fn delete_retained(
        &mut self,
        tenant: TenantId,
        event: cat::EventId,
        now: u64,
        authority: &dyn Authority,
    ) -> cat::Result<()> {
        let mut staged = self.catalogue.clone();
        let dispatch = cat::JobPort::dispatch_deletion(&mut staged, tenant, event, now, authority)?;
        if now >= dispatch.valid_until {
            return Err(cat::Error::Expired);
        }
        match &dispatch.target {
            cat::DeletionTarget::StorageVersion(location) => {
                let expected = format!("fixture/{}/{}/retained", tenant.0, dispatch.generation.0);
                if location.as_str() != expected.as_str()
                    || !self.retained.contains_key(&(tenant, dispatch.generation))
                {
                    return Err(cat::Error::Unsafe);
                }
            }
            cat::DeletionTarget::MetadataOnly => {
                if self.retained.contains_key(&(tenant, dispatch.generation)) {
                    return Err(cat::Error::Unsafe);
                }
            }
        }
        // Validate ack on the unpublished snapshot first; nothing fallible remains
        // after the in-memory storage operation. Real storage needs reconciliation.
        cat::JobPort::acknowledge_deletion(&mut staged, tenant, event)?;
        self.retained.remove(&(tenant, dispatch.generation));
        self.catalogue = staged;
        Ok(())
    }

    /// Trusted archive-worker ingress, never a user GET or an availability lease.
    /// The worker must still obey catalogue claims, budgets and live authority.
    /// Borrow the exact committed retained version; no substitute byte source.
    pub fn retained_for_archive(
        &self,
        tenant: TenantId,
        generation: GenerationId,
    ) -> cat::Result<&[u8]> {
        let view = cat::JobPort::generation(&self.catalogue, tenant, generation)?;
        let retained = self
            .retained
            .get(&(tenant, generation))
            .ok_or(cat::Error::Unavailable)?;
        let expected = format!("fixture/{}/{}/retained", tenant.0, generation.0);
        if view.cache_location.as_deref() != Some(expected.as_str())
            || retained.bytes.len() as u64 != view.metadata.identity.length
            || <[u8; 32]>::from(Sha256::digest(&retained.bytes)) != view.metadata.identity.sha256
        {
            return Err(cat::Error::Unsafe);
        }
        Ok(&retained.bytes)
    }

    /// Trusted fixture accounting, not an end-user object-read port.
    pub fn retained_bytes(&self, tenant: TenantId) -> usize {
        self.retained
            .iter()
            .filter(|((t, _), _)| *t == tenant)
            .map(|(_, retained)| retained.bytes.len())
            .sum()
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
        // Every destination must round-trip through XML results without changing
        // its identity, including writes prepared from percent-decoded paths.
        if reference.name.is_empty() || !reference.name.chars().all(control::xml_char) {
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
        let archive_deadline = now
            .checked_add(self.policy.archive_window)
            .ok_or(ErrorCode::InvalidArgument)?;
        let modified_at = i64::try_from(now)
            .ok()
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
            .filter(|date| date.format("%Y").to_string().len() == 4)
            .ok_or(ErrorCode::InvalidArgument)?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let tenant = prepared.reference.tenant;
        let generation = GenerationId(
            self.catalogue
                .allocate_identity(tenant)
                .map_err(map_error)?,
        );
        let begin = OperationId(
            self.catalogue
                .allocate_identity(tenant)
                .map_err(map_error)?,
        );
        let commit = OperationId(
            self.catalogue
                .allocate_identity(tenant)
                .map_err(map_error)?,
        );
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
                    archive_deadline,
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
        self.contexts.insert(
            (prepared.reference.tenant, generation),
            prepared.metadata.encryption_context.clone(),
        );
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
            destination: prepared.reference.clone(),
            modified_at,
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
        if reference.name.is_empty() {
            return Err(ErrorCode::InvalidRequest);
        }
        let (revision, current) = self
            .catalogue
            .write_target(reference.tenant, &reference.name, now, authority)
            .map_err(map_error)?;
        conditions.evaluate(current.as_ref())?;
        let operation = OperationId(
            self.catalogue
                .allocate_identity(reference.tenant)
                .map_err(map_error)?,
        );
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
        bucket: &super::Target,
        request: DeleteRequest,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Response> {
        bucket.validate_features()?;
        if bucket.key.is_some()
            || request.keys.is_empty()
            || request
                .keys
                .iter()
                .any(|key| key.is_empty() || !key.chars().all(control::xml_char))
            || request.keys.len() > self.policy.batch_keys
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let mut body = String::from("<DeleteResult>");
        for key in request.keys {
            let reference = Reference {
                tenant,
                name: format!("{}/{key}", bucket.bucket),
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
        self.expiry.insert((prepared.expires, tenant, id));
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
        self.expiry
            .remove(&(s.prepared.expires, reference.tenant, id));
        self.expiry.insert((until, reference.tenant, id));
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
        let expires = s.prepared.expires;
        self.expiry.remove(&(expires, reference.tenant, id));
        self.sessions.remove(&(reference.tenant, id));
        Ok(empty_response())
    }

    /// Inspect at most limit expiry-index entries, with O(log N) removals.
    /// Never scan active tenants or delete retained generations/archival bytes.
    pub fn cleanup(&mut self, now: u64, limit: usize) -> Result<CleanupPass> {
        if limit == 0 || limit > self.policy.sessions {
            return Err(ErrorCode::InvalidArgument);
        }
        let mut examined = 0;
        let expired: Vec<_> = self
            .expiry
            .iter()
            .take(limit)
            .take_while(|(expires, _, _)| {
                examined += 1;
                *expires <= now
            })
            .copied()
            .collect();
        for (expires, tenant, id) in &expired {
            self.sessions.remove(&(*tenant, *id));
            self.expiry.remove(&(*expires, *tenant, *id));
        }
        Ok(CleanupPass {
            examined,
            removed: expired.len(),
        })
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
        &mut self,
        source: &CopySource,
        context: &str,
        now: u64,
        authority: &dyn Authority,
        cache: Option<&mut dyn super::archive::QualifiedCache>,
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
        let key = (source.reference.tenant, source.generation);
        if self.contexts.get(&key).map(String::as_str) != Some(context) {
            return Err(ErrorCode::InvalidRequest);
        }
        let generation = self
            .catalogue
            .generation(source.reference.tenant, source.generation)
            .map_err(map_error)?;
        let location = generation.cache_location.ok_or(ErrorCode::InternalError)?;
        let bytes = if let Some(retained) = self.retained.get(&key) {
            if retained.context != context
                || location != format!("fixture/{}/{}/retained", key.0 .0, key.1 .0)
            {
                return Err(ErrorCode::InternalError);
            }
            retained.bytes.clone()
        } else {
            let cache = cache.ok_or(ErrorCode::InternalError)?;
            // Exact-generation serving authority also fences server-side copy.
            // Exclusive model access keeps the clock/catalogue stable during I/O;
            // a production asynchronous adapter needs its own completion clock.
            let operation =
                OperationId(self.catalogue.allocate_identity(key.0).map_err(map_error)?);
            let until = now.checked_add(30).ok_or(ErrorCode::InvalidArgument)?.min(
                view.availability_until
                    .ok_or(ErrorCode::InvalidObjectState)?,
            );
            let outcome = self
                .catalogue
                .transact(
                    key.0,
                    operation,
                    Mutation::AcquireServingPin {
                        name: source.reference.name.clone(),
                        until,
                    },
                    now,
                    authority,
                )
                .map_err(map_error)?;
            let Outcome::Pin(pin) = outcome else {
                return Err(ErrorCode::InternalError);
            };
            let result = (|| {
                if self
                    .catalogue
                    .validate_pin(key.0, pin, now, authority)
                    .map_err(map_error)?
                    != key.1
                {
                    return Err(ErrorCode::PreconditionFailed);
                }
                let bytes =
                    cache.read(key.0, key.1, &view.metadata.identity, &location, pin, None)?;
                permit(authority, &source.reference, Action::Read)?;
                if self
                    .catalogue
                    .validate_pin(key.0, pin, now, authority)
                    .map_err(map_error)?
                    != key.1
                {
                    return Err(ErrorCode::PreconditionFailed);
                }
                Ok(bytes)
            })();
            self.catalogue
                .release_serving_pin(key.0, pin)
                .map_err(map_error)?;
            result?
        };
        if bytes.len() as u64 != view.metadata.identity.length
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != view.metadata.identity.sha256
        {
            return Err(ErrorCode::InternalError);
        }
        Ok((
            ValidatedBody {
                bytes,
                sha256: view.metadata.identity.sha256,
                checksum: None,
            },
            view,
        ))
    }

    pub fn copy_object(
        &mut self,
        destination: PreparedWrite,
        source: CopySource,
        directive: MetadataDirective,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<CommitResult> {
        self.copy_object_with_cache(destination, source, directive, now, authority, None)
    }

    /// A trusted verified-cache port, never source bytes supplied by a caller.
    /// The catalogue lease, pin, identity and format context are checked here.
    #[allow(clippy::too_many_arguments)]
    pub fn copy_object_with_cache(
        &mut self,
        mut destination: PreparedWrite,
        source: CopySource,
        directive: MetadataDirective,
        now: u64,
        authority: &dyn Authority,
        cache: Option<&mut dyn super::archive::QualifiedCache>,
    ) -> Result<CommitResult> {
        self.final_target(&destination, now, authority)?;
        let (body, view) = self.source(
            &source,
            &destination.metadata.encryption_context,
            now,
            authority,
            cache,
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
        self.upload_part_copy_with_cache(reference, id, number, source, range, now, authority, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upload_part_copy_with_cache(
        &mut self,
        reference: &Reference,
        id: UploadId,
        number: u16,
        source: CopySource,
        range: Option<(usize, usize)>,
        now: u64,
        authority: &dyn Authority,
        cache: Option<&mut dyn super::archive::QualifiedCache>,
    ) -> Result<PartEvidence> {
        let session = self.session(reference, id, now, authority)?;
        if session.result.is_some() {
            return Err(ErrorCode::NoSuchUpload);
        }
        let checksum = session.checksum;
        let context = session.prepared.metadata.encryption_context.clone();
        let (mut body, _) = self.source(&source, &context, now, authority, cache)?;
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
