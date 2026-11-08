//! In-process reference product service. No listener, database or scheduler.
//!
//! A checkpoint is an explicit model value, not evidence of durable persistence.
//! Access and storage are trusted live ports; neither is restored from a checkpoint.

mod bridge;
pub use bridge::UploadWorker;

use crate::{catalogue as c, composition as flow, native as n, operations as o};
use c::{JobPort, MetadataOutbox};
use std::collections::{BTreeMap, BTreeSet};

/// Authenticated live policy. Missing/foreign/revoked/banned references all deny.
/// Implementations must not derive these grants from request fields or snapshots.
pub trait Access {
    fn tenant(&self, scope: &o::Scope) -> Option<c::TenantId>;
    fn permits(&self, scope: &o::Scope, reference: &str, action: c::Action) -> bool;
    fn container(&self, scope: &o::Scope, parent: &str) -> bool;
    fn admit(&self, scope: &o::Scope) -> bool;
    fn key_envelope(&self, scope: &o::Scope, key: &n::Opaque, envelope: &n::Opaque) -> bool;
}

struct Authority<'a, A> {
    access: &'a A,
    scope: &'a o::Scope,
    tenant: c::TenantId,
}
impl<A: Access> c::Authority for Authority<'_, A> {
    fn is_current(&self) -> bool {
        self.access.tenant(self.scope) == Some(self.tenant) && self.access.admit(self.scope)
    }
    fn permits(&self, reference: &c::Reference, action: c::Action) -> bool {
        reference.tenant == self.tenant
            && self.is_current()
            && self.access.permits(self.scope, &reference.name, action)
    }
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub bytes: u64,
    pub job_seconds: u64,
    pub transfer_seconds: u64,
    pub attempts: u64,
    pub records: usize,
}
impl Limits {
    fn valid(&self) -> bool {
        self.bytes > 0
            && self.job_seconds > 0
            && self.transfer_seconds > 0
            && self.attempts > 0
            && self.records > 0
    }
}

#[derive(Clone)]
struct Descriptor {
    intent: n::UploadIntent,
    parent: o::Opaque,
}
#[derive(Clone)]
struct Upload {
    descriptor: Descriptor,
    scope: o::Scope,
    transfer: o::Transfer,
    job: o::Opaque,
    intent: c::OperationId,
    commit: c::OperationId,
    expected_revision: u64,
    received: u64,
    verified: bool,
    abort: Option<n::CancelOutcome>,
    attempts: u64,
    cleanup: bool,
    submitted: bool,
}
#[derive(Clone)]
struct Transfer {
    scope: o::Scope,
    value: o::Transfer,
    pin: c::PinId,
}
#[derive(Clone)]
struct Job {
    scope: o::Scope,
    value: o::Job,
    deadline: u64,
    restore: Option<(c::JobId, c::OperationId)>,
}
#[derive(Clone)]
struct Cursor {
    scope: o::Scope,
    parent: o::Opaque,
    limit: u64,
    expires: u64,
    entries: Vec<o::Entry>,
}

/// Explicit, non-durable reference checkpoint, including reconciliation and outbox.
/// Clone/import simulates process loss; no DB or persistence qualification is claimed.
#[derive(Clone, Default)]
pub struct ReferenceModel {
    catalogue: c::MemoryCatalogue,
    sequence: u64,
    last_now: u64,
    descriptors: BTreeMap<(o::Scope, o::Opaque), Descriptor>,
    uploads: BTreeMap<o::Opaque, Upload>,
    transfers: BTreeMap<o::Opaque, Transfer>,
    jobs: BTreeMap<o::Opaque, Job>,
    objects: BTreeMap<(c::TenantId, c::GenerationId, String), n::Object>,
    members: BTreeSet<(c::TenantId, o::Opaque, o::Opaque)>,
    cursors: BTreeMap<o::Opaque, Cursor>,
    replay: BTreeMap<o::Reconciliation, (o::Request, o::Output)>,
    native: bridge::NativeModel,
}

pub struct Service<A> {
    model: ReferenceModel,
    access: A,
    limits: Limits,
    profile: n::Policy,
    now: u64,
}

fn fail(code: o::ErrorCode) -> o::Failure {
    o::Failure::new(code)
}
fn denied() -> o::Failure {
    fail(o::ErrorCode::Denied)
}
fn map(error: c::Error) -> o::Failure {
    use o::ErrorCode as E;
    match error {
        c::Error::Unavailable => denied(),
        c::Error::Conflict | c::Error::Fenced => fail(E::PreconditionFailed),
        c::Error::Invalid => fail(E::InvalidInput),
        c::Error::Expired => fail(E::NotAvailable),
        c::Error::IncompleteCopy => fail(E::IntegrityFailed),
        c::Error::Unsafe => fail(E::NotAvailable),
        c::Error::Uncertain => o::Failure {
            code: E::Unavailable,
            effects: o::Effects::Unknown,
        },
    }
}
fn token(prefix: &str, value: u64) -> o::Opaque {
    o::Opaque::new(format!("{prefix}_{value}")).expect("bounded model identity")
}
fn generation(id: &o::Opaque) -> Result<c::GenerationId, o::Failure> {
    id.as_str()
        .strip_prefix("g_")
        .and_then(|s| s.parse().ok())
        .map(c::GenerationId)
        .ok_or_else(denied)
}
fn native_id(id: &o::Opaque) -> n::Opaque {
    id.as_str()
        .to_owned()
        .try_into()
        .expect("operation identity fits native syntax")
}
fn operation_id(id: &n::Opaque) -> Result<o::Opaque, o::Failure> {
    o::Opaque::new(id.as_str())
}

impl<A: Access> Service<A> {
    pub fn new(
        access: A,
        limits: Limits,
        profile: n::Policy,
        now: u64,
    ) -> Result<Self, o::Failure> {
        Self::reconnect(ReferenceModel::default(), access, limits, profile, now)
    }
    pub fn reconnect(
        mut model: ReferenceModel,
        access: A,
        limits: Limits,
        profile: n::Policy,
        now: u64,
    ) -> Result<Self, o::Failure> {
        if !limits.valid() || now < model.last_now {
            return Err(fail(o::ErrorCode::Unavailable));
        }
        model.last_now = now;
        Ok(Self {
            model,
            access,
            limits,
            profile,
            now,
        })
    }
    pub fn checkpoint(&self) -> ReferenceModel {
        self.model.clone()
    }
    pub fn access(&self) -> &A {
        &self.access
    }
    pub fn now(&self) -> u64 {
        self.now
    }
    pub fn set_now(&mut self, now: u64) -> Result<(), o::Failure> {
        if now < self.now {
            return Err(fail(o::ErrorCode::Unavailable));
        }
        self.now = now;
        self.model.last_now = now;
        Ok(())
    }
    /// Infrastructure-only catalogue access: workers use the existing outbox,
    /// fences, moderation and exact-generation deletion proofs, not a second queue.
    pub fn catalogue(&self) -> &c::MemoryCatalogue {
        &self.model.catalogue
    }
    pub fn catalogue_mut(&mut self) -> &mut c::MemoryCatalogue {
        &mut self.model.catalogue
    }
    pub fn allocations(&self) -> (usize, usize, usize) {
        (
            self.model.uploads.len(),
            self.model.jobs.len(),
            self.model.transfers.len(),
        )
    }
    fn next(&mut self) -> Result<u64, o::Failure> {
        self.model.sequence = self
            .model
            .sequence
            .checked_add(1)
            .ok_or(fail(o::ErrorCode::QuotaExceeded))?;
        Ok(self.model.sequence)
    }
    fn expiry(&self, seconds: u64) -> Result<u64, o::Failure> {
        self.now
            .checked_add(seconds)
            .ok_or(fail(o::ErrorCode::QuotaExceeded))
    }
    fn tenant(&self, scope: &o::Scope) -> Result<c::TenantId, o::Failure> {
        self.access.tenant(scope).ok_or_else(denied)
    }
    fn authority<'a>(&'a self, scope: &'a o::Scope) -> Result<Authority<'a, A>, o::Failure> {
        Ok(Authority {
            access: &self.access,
            scope,
            tenant: self.tenant(scope)?,
        })
    }
    fn permit(
        &self,
        scope: &o::Scope,
        name: &o::Opaque,
        action: c::Action,
    ) -> Result<(), o::Failure> {
        self.tenant(scope)?;
        if !self.access.admit(scope) || !self.access.permits(scope, name.as_str(), action) {
            return Err(denied());
        }
        Ok(())
    }
    fn lookup(&self, scope: &o::Scope, name: &o::Opaque) -> Result<c::ReferenceView, o::Failure> {
        let auth = self.authority(scope)?;
        self.model
            .catalogue
            .lookup(auth.tenant, name.as_str(), self.now, &auth)
            .map_err(map)
    }
    fn exact(
        &self,
        scope: &o::Scope,
        target: &o::LogicalReference,
    ) -> Result<c::ReferenceView, o::Failure> {
        self.permit(scope, &target.reference, c::Action::Read)?;
        let value = self.lookup(scope, &target.reference)?;
        if value.generation != generation(&target.generation)? {
            return Err(fail(o::ErrorCode::PreconditionFailed));
        }
        Ok(value)
    }
    fn target(request: &o::Request) -> o::LogicalReference {
        o::LogicalReference {
            reference: request.opaque("reference").unwrap().clone(),
            generation: request.opaque("generation").unwrap().clone(),
        }
    }
    fn job(&self, scope: &o::Scope, id: &o::Opaque) -> Result<Job, o::Failure> {
        let mut job = self
            .model
            .jobs
            .get(id)
            .filter(|j| j.scope == *scope)
            .cloned()
            .ok_or_else(denied)?;
        self.permit(scope, &job.value.target.reference, c::Action::Read)?;
        if let Some((id, _)) = job
            .restore
            .filter(|_| job.value.state != o::JobState::Cancelled)
        {
            self.exact(scope, &job.value.target)?;
            let stored = self
                .model
                .catalogue
                .job(self.tenant(scope)?, id)
                .map_err(map)?;
            job.value.state = match stored.state {
                c::JobState::Queued | c::JobState::RetryWait { .. } => o::JobState::Queued,
                c::JobState::Running => o::JobState::Running,
                c::JobState::Complete => o::JobState::Succeeded,
                c::JobState::Cancelled => o::JobState::Cancelled,
                c::JobState::FailedUnrecoverable | c::JobState::Expired => o::JobState::Failed,
            };
            if job.value.state == o::JobState::Succeeded {
                job.value
                    .progress
                    .advance(job.value.progress.total().unwrap_or(0))?;
                job.value.effects = o::Effects::Committed;
            }
            if job.value.state == o::JobState::Failed {
                job.value.error = Some(fail(o::ErrorCode::Unavailable));
            }
        }
        if self.now >= job.deadline && !job.value.state.terminal() {
            job.value.state = o::JobState::Failed;
            job.value.error = Some(fail(o::ErrorCode::Unavailable));
        }
        Ok(job)
    }
    fn replay(
        &self,
        scope: &o::Scope,
        request: &o::Request,
    ) -> Result<Option<o::Output>, o::Failure> {
        if let Some(key) = request.reconciliation(scope) {
            if let Some((prior, output)) = self.model.replay.get(&key) {
                if prior != request {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                return Ok(Some(output.clone()));
            }
        }
        Ok(None)
    }
    /// Trusted descriptor ingress, after native validation/key-envelope resolution.
    /// REST/MCP initiate references this scoped descriptor using the same identity.
    /// This does not authenticate a client, approve a crypto suite or verify C.
    pub fn bind_upload(
        &mut self,
        scope: &o::Scope,
        identity: o::Opaque,
        parent: o::Opaque,
        intent: n::UploadIntent,
    ) -> Result<(), o::Failure> {
        let object = operation_id(&intent.object)?;
        self.permit(scope, &object, c::Action::Write)?;
        if !self.access.container(scope, parent.as_str()) {
            return Err(denied());
        }
        if intent.ciphertext.length > self.limits.bytes {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        if !self
            .profile
            .profiles
            .iter()
            .any(|p| p.profile == intent.ciphertext.profile && p.checksum_hex_chars == 64)
        {
            return Err(fail(o::ErrorCode::Unsupported));
        }
        if !self.access.key_envelope(
            scope,
            &intent.ciphertext.key_ref,
            &intent.ciphertext.envelope_ref,
        ) {
            return Err(denied());
        }
        metadata(&intent, self.now)?;
        let key = (scope.clone(), identity);
        if let Some(prior) = self.model.descriptors.get(&key) {
            return if prior.intent == intent && prior.parent == parent {
                Ok(())
            } else {
                Err(fail(o::ErrorCode::Conflict))
            };
        }
        if self.model.descriptors.len() >= self.limits.records {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        self.model
            .descriptors
            .insert(key, Descriptor { intent, parent });
        Ok(())
    }
    /// Trusted staged-transfer checkpoint; offsets are exact and monotonic. This
    /// records verified I/O progress, never client assertions of byte integrity.
    pub fn staged(
        &mut self,
        scope: &o::Scope,
        handle: &o::Opaque,
        offset: u64,
        received: u64,
    ) -> Result<(), o::Failure> {
        let upload = self.model.uploads.get(handle).cloned().ok_or_else(denied)?;
        self.permit(scope, &upload.transfer.target.reference, c::Action::Write)?;
        if upload.scope != *scope {
            return Err(denied());
        }
        if self.now >= upload.transfer.expires_at
            || upload.submitted
            || upload.received != offset
            || received < offset
            || received > upload.transfer.max_bytes
        {
            return Err(fail(o::ErrorCode::Conflict));
        }
        let job = self.job(scope, &upload.job)?;
        if job.value.state.terminal() {
            return Err(fail(o::ErrorCode::Conflict));
        }
        self.model.uploads.get_mut(handle).unwrap().received = received;
        let value = &mut self.model.jobs.get_mut(&upload.job).unwrap().value;
        value.progress.advance(received)?;
        value.state = o::JobState::Running;
        Ok(())
    }
    /// Trusted full-byte verifier receipt, not a caller-supplied checksum claim.
    pub fn verify_staged(
        &mut self,
        scope: &o::Scope,
        handle: &o::Opaque,
        copy: &c::CompleteCopy,
    ) -> Result<(), o::Failure> {
        self.resume(scope, handle)?;
        let upload = self.model.uploads.get(handle).unwrap();
        let expected = metadata(&upload.descriptor.intent, self.now)?;
        if upload.received != upload.transfer.max_bytes
            || copy.identity != expected.identity
            || copy.checksums != expected.checksums
            || copy.location.is_empty()
            || copy.receipt.is_empty()
        {
            return Err(fail(o::ErrorCode::IntegrityFailed));
        }
        self.model.uploads.get_mut(handle).unwrap().verified = true;
        Ok(())
    }
    pub fn resume(
        &self,
        scope: &o::Scope,
        handle: &o::Opaque,
    ) -> Result<(o::Transfer, u64), o::Failure> {
        let upload = self
            .model
            .uploads
            .get(handle)
            .filter(|u| u.scope == *scope)
            .ok_or_else(denied)?;
        self.permit(scope, &upload.transfer.target.reference, c::Action::Write)?;
        if self.now >= upload.transfer.expires_at
            || self.job(scope, &upload.job)?.value.state.terminal()
        {
            return Err(fail(o::ErrorCode::Conflict));
        }
        Ok((upload.transfer.clone(), upload.received))
    }
    /// Explicit worker invocation, independent of connected/polling subscribers.
    /// Storage.stage_upload must reconcile the staged inventory for this intent;
    /// it verifies all bytes and returns a complete immutable receipt. No new queue.
    pub async fn finish_upload<S: flow::Storage>(
        &mut self,
        scope: &o::Scope,
        handle: &o::Opaque,
        storage: &mut S,
        budget: &flow::Budget,
        clock: &impl flow::Clock,
        policy: &impl flow::Policy,
    ) -> Result<o::Job, o::Failure> {
        let upload = self
            .model
            .uploads
            .get(handle)
            .filter(|u| u.scope == *scope)
            .cloned()
            .ok_or_else(denied)?;
        self.permit(scope, &upload.transfer.target.reference, c::Action::Write)?;
        let job = self.job(scope, &upload.job)?;
        if job.value.state == o::JobState::Succeeded {
            return Ok(job.value);
        }
        if !upload.submitted || job.value.state.terminal() {
            return Err(fail(o::ErrorCode::Conflict));
        }
        let metadata = metadata(&upload.descriptor.intent, self.now)?;
        let tenant = self.tenant(scope)?;
        let work = flow::Upload {
            tenant,
            intent: upload.intent,
            commit: upload.commit,
            name: upload.transfer.target.reference.as_str().into(),
            expected_revision: upload.expected_revision,
            generation: generation(&upload.transfer.target.generation)?,
            metadata,
            archive_deadline: job.deadline,
        };
        let authority = Authority {
            access: &self.access,
            scope,
            tenant,
        };
        if upload.attempts >= self.limits.attempts {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        self.model.uploads.get_mut(handle).unwrap().attempts += 1;
        self.model.uploads.get_mut(handle).unwrap().cleanup = true;
        if let Err(error) = flow::ingest(
            &mut self.model.catalogue,
            storage,
            &work,
            budget,
            clock,
            policy,
            &authority,
        )
        .await
        {
            let failure = match error {
                flow::Failure::Catalogue(error) => map(error),
                flow::Failure::Io(flow::IoError::Integrity) => fail(o::ErrorCode::IntegrityFailed),
                flow::Failure::Io(flow::IoError::Uncertain) => o::Failure {
                    code: o::ErrorCode::Unavailable,
                    effects: o::Effects::Unknown,
                },
                _ => fail(o::ErrorCode::Unavailable),
            };
            self.model.jobs.get_mut(&upload.job).unwrap().value.effects = o::Effects::Unknown;
            return Err(failure);
        }
        self.model.uploads.get_mut(handle).unwrap().cleanup = false;
        let value = &mut self.model.jobs.get_mut(&upload.job).unwrap().value;
        value.state = o::JobState::Succeeded;
        value.effects = o::Effects::Committed;
        let object = n::Object {
            target: n::Target {
                object: native_id(&upload.transfer.target.reference),
                g: native_id(&upload.transfer.target.generation),
            },
            ciphertext: upload.descriptor.intent.ciphertext,
            metadata: upload.descriptor.intent.metadata,
        };
        self.model
            .objects
            .insert((tenant, work.generation, work.name), object);
        self.model.members.insert((
            tenant,
            upload.descriptor.parent,
            upload.transfer.target.reference,
        ));
        Ok(value.clone())
    }
    /// Rechecks current reference, generation, policy, expiry and catalogue pin at
    /// redemption. Physical presence alone never authorizes a cold download.
    pub fn redeem(
        &self,
        scope: &o::Scope,
        handle: &o::Opaque,
    ) -> Result<(c::GenerationId, c::PinId), o::Failure> {
        let transfer = self
            .model
            .transfers
            .get(handle)
            .filter(|t| t.scope == *scope)
            .ok_or_else(denied)?;
        self.exact(scope, &transfer.value.target)?;
        if self.now >= transfer.value.expires_at {
            return Err(fail(o::ErrorCode::NotAvailable));
        }
        let auth = self.authority(scope)?;
        let g = self
            .model
            .catalogue
            .validate_pin(auth.tenant, transfer.pin, self.now, &auth)
            .map_err(map)?;
        if g != generation(&transfer.value.target.generation)? {
            return Err(denied());
        }
        Ok((g, transfer.pin))
    }
    fn fence(&self, scope: &o::Scope, request: &o::Request) -> Result<u64, o::Failure> {
        let name = request.opaque("reference").unwrap();
        if request.if_absent() {
            if self.lookup(scope, name).is_ok() {
                return Err(fail(o::ErrorCode::PreconditionFailed));
            }
            // The reference model intentionally disallows recreating a tombstone
            // without its revision; no guessed revision or ABA generation reuse.
            Ok(0)
        } else {
            Ok(self.exact(scope, &Self::target(request))?.revision)
        }
    }
    fn new_job(
        &self,
        scope: &o::Scope,
        target: o::LogicalReference,
        id: u64,
        bytes: Option<u64>,
    ) -> Result<Job, o::Failure> {
        Ok(Job {
            scope: scope.clone(),
            deadline: self.expiry(self.limits.job_seconds)?,
            restore: None,
            value: o::Job {
                handle: token("job", id),
                target,
                state: o::JobState::Queued,
                progress: o::Progress::new(o::ProgressUnit::Bytes, bytes),
                effects: o::Effects::None,
                error: None,
            },
        })
    }
}

fn metadata(intent: &n::UploadIntent, now: u64) -> Result<c::CiphertextMetadata, o::Failure> {
    let hex = intent.ciphertext.checksum_hex.as_str();
    if hex.len() != 64 {
        return Err(fail(o::ErrorCode::Unsupported));
    }
    let mut sha256 = [0; 32];
    for (i, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).map_err(|_| fail(o::ErrorCode::InvalidInput))?;
        sha256[i] = u8::from_str_radix(pair, 16).map_err(|_| fail(o::ErrorCode::InvalidInput))?;
    }
    let mut headers = intent.metadata.user.clone();
    headers.insert("Content-Type".into(), intent.metadata.content_type.clone());
    if let Some(value) = &intent.metadata.content_encoding {
        headers.insert("Content-Encoding".into(), value.clone());
    }
    Ok(c::CiphertextMetadata {
        identity: c::CiphertextIdentity {
            length: intent.ciphertext.length,
            sha256,
        },
        validator: intent.ciphertext.c.as_str().into(),
        modified_at: now,
        headers,
        checksums: vec![],
        recovery_ref: intent.ciphertext.envelope_ref.as_str().into(),
    })
}

impl<A: Access> o::OperationPort for Service<A> {
    fn authorize(&mut self, scope: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        self.tenant(scope)?;
        if !self.access.admit(scope) {
            return Err(denied());
        }
        for name in ["reference", "source"] {
            if let Some(reference) = request.opaque(name) {
                let action = if name == "source" {
                    c::Action::Read
                } else if matches!(
                    request.operation(),
                    o::Operation::InitiateUpload
                        | o::Operation::CommitUpload
                        | o::Operation::AbortUpload
                        | o::Operation::Copy
                        | o::Operation::Delete
                ) {
                    c::Action::Write
                } else {
                    c::Action::Read
                };
                self.permit(scope, reference, action)?;
            }
        }
        if let Some(parent) = request.opaque("parent") {
            if !self.access.container(scope, parent.as_str()) {
                return Err(denied());
            }
        }
        if let Some(id) = request.opaque("job") {
            self.job(scope, id)?;
        }
        if let Some(id) = request.opaque("transfer") {
            let upload = self
                .model
                .uploads
                .get(id)
                .filter(|u| u.scope == *scope)
                .ok_or_else(denied)?;
            if !request.matches_target(&upload.transfer.target) {
                return Err(denied());
            }
        }
        Ok(())
    }
    fn preconditions(&mut self, scope: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        let replay = self.replay(scope, request)?.is_some();
        if replay
            && matches!(
                request.operation(),
                o::Operation::InitiateUpload
                    | o::Operation::CommitUpload
                    | o::Operation::AbortUpload
                    | o::Operation::Copy
                    | o::Operation::Delete
            )
        {
            return Ok(());
        }
        match request.operation() {
            o::Operation::InitiateUpload | o::Operation::Copy => {
                self.fence(scope, request)?;
            }
            o::Operation::Stat
            | o::Operation::Restore
            | o::Operation::Delete
            | o::Operation::AuthorizeDownload => {
                self.exact(scope, &Self::target(request))?;
            }
            _ => {}
        }
        if request.operation() == o::Operation::Copy {
            self.exact(
                scope,
                &o::LogicalReference {
                    reference: request.opaque("source").unwrap().clone(),
                    generation: request.opaque("source_generation").unwrap().clone(),
                },
            )?;
        }
        Ok(())
    }
    fn admit(&mut self, _: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        if request
            .number("max_bytes")
            .is_some_and(|b| b > self.limits.bytes)
            || request
                .number("availability_seconds")
                .is_some_and(|s| s > self.limits.job_seconds)
        {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        let count = self.model.uploads.len()
            + self.model.jobs.len()
            + self.model.transfers.len()
            + self.model.cursors.len()
            + self.model.replay.len();
        if request.operation().definition().effects != o::EffectClass::ReadOnly
            && count + 4 > self.limits.records
        {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        Ok(())
    }
    fn resolve_cursor(
        &mut self,
        scope: &o::Scope,
        request: &o::Request,
        cursor: &o::Opaque,
    ) -> Result<o::Opaque, o::Failure> {
        let value = self
            .model
            .cursors
            .get(cursor)
            .ok_or(fail(o::ErrorCode::InvalidCursor))?;
        if value.scope != *scope
            || Some(&value.parent) != request.opaque("parent")
            || Some(value.limit) != request.number("limit")
            || value.expires <= self.now
        {
            return Err(fail(o::ErrorCode::InvalidCursor));
        }
        Ok(cursor.clone())
    }
    fn execute(
        &mut self,
        scope: &o::Scope,
        request: &o::Request,
        position: Option<&o::Opaque>,
    ) -> Result<o::Output, o::Failure> {
        self.authorize(scope, request)?;
        self.preconditions(scope, request)?;
        self.admit(scope, request)?;
        if let Some(output) = self.replay(scope, request)? {
            return Ok(output);
        }
        // Model transaction rollback includes handle allocation, reconciliation and
        // catalogue effects. No physical storage I/O occurs inside this boundary.
        let before = self.model.clone();
        let result = self.apply(scope, request, position);
        match result {
            Ok(output) => {
                if let Some(key) = request.reconciliation(scope) {
                    self.model
                        .replay
                        .insert(key, (request.clone(), output.clone()));
                }
                self.model.last_now = self.now;
                Ok(output)
            }
            Err(error) => {
                self.model = before;
                Err(error)
            }
        }
    }
}

impl<A: Access> Service<A> {
    fn apply(
        &mut self,
        scope: &o::Scope,
        request: &o::Request,
        position: Option<&o::Opaque>,
    ) -> Result<o::Output, o::Failure> {
        use o::{Operation as Op, Output as Out};
        let tenant = self.tenant(scope)?;
        match request.operation() {
            Op::InitiateUpload => {
                let descriptor = self
                    .model
                    .descriptors
                    .get(&(scope.clone(), request.opaque("identity").unwrap().clone()))
                    .cloned()
                    .ok_or(fail(o::ErrorCode::InvalidInput))?;
                if descriptor.intent.object.as_str()
                    != request.opaque("reference").unwrap().as_str()
                    || Some(descriptor.intent.ciphertext.length) != request.number("max_bytes")
                {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                let matches = match &descriptor.intent.precondition {
                    n::Precondition::Absent => request.if_absent(),
                    n::Precondition::Matches(g) => request
                        .opaque("generation")
                        .is_some_and(|id| id.as_str() == g.as_str()),
                };
                if !matches {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                metadata(&descriptor.intent, self.now)?;
                let expected_revision = self.fence(scope, request)?;
                let id = self.next()?;
                let target = o::LogicalReference {
                    reference: request.opaque("reference").unwrap().clone(),
                    generation: token("g", id),
                };
                let job = self.new_job(scope, target.clone(), id, request.number("max_bytes"))?;
                let transfer = o::Transfer {
                    handle: token("up", id),
                    target,
                    direction: o::TransferDirection::Upload,
                    expires_at: self
                        .expiry(self.limits.transfer_seconds.min(self.limits.job_seconds))?,
                    max_bytes: request.number("max_bytes").unwrap(),
                };
                let upload = Upload {
                    descriptor,
                    scope: scope.clone(),
                    transfer: transfer.clone(),
                    job: job.value.handle.clone(),
                    intent: c::OperationId(self.next()?),
                    commit: c::OperationId(self.next()?),
                    expected_revision,
                    received: 0,
                    verified: false,
                    abort: None,
                    attempts: 0,
                    cleanup: false,
                    submitted: false,
                };
                self.model.uploads.insert(transfer.handle.clone(), upload);
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
                Ok(Out::Upload {
                    transfer,
                    job: job.value,
                })
            }
            Op::CommitUpload | Op::AbortUpload => {
                let handle = request.opaque("transfer").unwrap();
                let upload = self.model.uploads.get(handle).cloned().ok_or_else(denied)?;
                let mut job = self.job(scope, &upload.job)?;
                if request.operation() == Op::AbortUpload {
                    return self.cancel(scope, job);
                }
                if job.value.state == o::JobState::Succeeded {
                    return Ok(Out::Job(job.value));
                }
                if job.value.state.terminal()
                    || self.now >= upload.transfer.expires_at
                    || upload.received != upload.transfer.max_bytes
                    || !upload.verified
                {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                let current = match &upload.descriptor.intent.precondition {
                    n::Precondition::Absent => self
                        .lookup(scope, &upload.transfer.target.reference)
                        .is_err(),
                    n::Precondition::Matches(g) => self
                        .lookup(scope, &upload.transfer.target.reference)
                        .is_ok_and(|r| native_id(&token("g", r.generation.0)) == *g),
                };
                if !current {
                    return Err(fail(o::ErrorCode::PreconditionFailed));
                }
                self.model.uploads.get_mut(handle).unwrap().submitted = true;
                job.value.state = o::JobState::Running;
                job.value.effects = o::Effects::Accepted;
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
                Ok(Out::Job(job.value))
            }
            Op::Stat => {
                let target = Self::target(request);
                let view = self.exact(scope, &target)?;
                Ok(Out::Stat(o::Entry {
                    target,
                    bytes: view.metadata.identity.length,
                    available: view.availability_until.is_some_and(|t| t > self.now),
                }))
            }
            Op::Browse => {
                let parent = request.opaque("parent").unwrap();
                let limit = request.number("limit").unwrap();
                let entries = if let Some(cursor) = position {
                    self.model
                        .cursors
                        .get(cursor)
                        .ok_or(fail(o::ErrorCode::InvalidCursor))?
                        .entries
                        .clone()
                } else {
                    self.model
                        .members
                        .iter()
                        .filter(|(t, p, _)| *t == tenant && p == parent)
                        .filter_map(|(_, _, name)| {
                            let view = self.lookup(scope, name).ok()?;
                            Some(o::Entry {
                                target: o::LogicalReference {
                                    reference: name.clone(),
                                    generation: token("g", view.generation.0),
                                },
                                bytes: view.metadata.identity.length,
                                available: view.availability_until.is_some_and(|t| t > self.now),
                            })
                        })
                        .collect::<Vec<_>>()
                };
                // Recheck every snapshot member, including revocation and generation
                // changes, before returning bytes/metadata from an old cursor.
                let entries = entries
                    .into_iter()
                    .filter(|e| self.exact(scope, &e.target).is_ok())
                    .collect::<Vec<_>>();
                let cursor = if entries.len() > limit as usize {
                    if self.model.cursors.len() >= self.limits.records {
                        return Err(fail(o::ErrorCode::QuotaExceeded));
                    }
                    let id = token("cursor", self.next()?);
                    self.model.cursors.insert(
                        id.clone(),
                        Cursor {
                            scope: scope.clone(),
                            parent: parent.clone(),
                            limit,
                            expires: self.expiry(self.limits.transfer_seconds)?,
                            entries: entries[limit as usize..].to_vec(),
                        },
                    );
                    Some(id)
                } else {
                    None
                };
                Ok(Out::Page {
                    entries: entries.into_iter().take(limit as usize).collect(),
                    cursor,
                })
            }
            Op::AuthorizeDownload => {
                let target = Self::target(request);
                let view = self.exact(scope, &target)?;
                let expires_at = self.expiry(self.limits.transfer_seconds)?.min(
                    view.availability_until
                        .ok_or(fail(o::ErrorCode::NotAvailable))?,
                );
                if expires_at <= self.now {
                    return Err(fail(o::ErrorCode::NotAvailable));
                }
                let id = self.next()?;
                let auth = Authority {
                    access: &self.access,
                    scope,
                    tenant,
                };
                let c::Outcome::Pin(pin) = self
                    .model
                    .catalogue
                    .transact(
                        tenant,
                        c::OperationId(id),
                        c::Mutation::AcquireServingPin {
                            name: target.reference.as_str().into(),
                            until: expires_at,
                        },
                        self.now,
                        &auth,
                    )
                    .map_err(map)?
                else {
                    return Err(fail(o::ErrorCode::Internal));
                };
                let value = o::Transfer {
                    handle: token("down", id),
                    target,
                    direction: o::TransferDirection::Download,
                    expires_at,
                    max_bytes: view.metadata.identity.length,
                };
                self.model.transfers.insert(
                    value.handle.clone(),
                    Transfer {
                        scope: scope.clone(),
                        value: value.clone(),
                        pin,
                    },
                );
                Ok(Out::Download(value))
            }
            Op::Restore => {
                let target = Self::target(request);
                self.permit(scope, &target.reference, c::Action::Restore)?;
                let view = self.exact(scope, &target)?;
                let id = self.next()?;
                let mut job = self.new_job(
                    scope,
                    target.clone(),
                    id,
                    Some(view.metadata.identity.length),
                )?;
                let auth = Authority {
                    access: &self.access,
                    scope,
                    tenant,
                };
                let c::Outcome::Restore(restore) = self
                    .model
                    .catalogue
                    .transact(
                        tenant,
                        c::OperationId(id),
                        c::Mutation::RequestRestore {
                            name: target.reference.as_str().into(),
                            expected_revision: view.revision,
                            profile: "whole-ciphertext-v1".into(),
                            deadline: job.deadline,
                            availability_for: request.number("availability_seconds").unwrap(),
                        },
                        self.now,
                        &auth,
                    )
                    .map_err(map)?
                else {
                    return Err(fail(o::ErrorCode::Internal));
                };
                job.restore = Some((restore, c::OperationId(id)));
                job.value.effects = o::Effects::Accepted;
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
                Ok(Out::Job(job.value))
            }
            Op::Status | Op::Result | Op::Cancel => {
                let job = self.job(scope, request.opaque("job").unwrap())?;
                if request.operation() == Op::Cancel {
                    return self.cancel(scope, job);
                }
                if request.operation() == Op::Status {
                    return Ok(Out::Job(job.value));
                }
                match job.value.state {
                    o::JobState::Succeeded => Ok(Out::Result {
                        reference: job.value.target.clone(),
                        job: job.value,
                    }),
                    o::JobState::Failed => {
                        Err(job.value.error.unwrap_or(fail(o::ErrorCode::Unavailable)))
                    }
                    o::JobState::Cancelled => Err(fail(o::ErrorCode::Cancelled)),
                    _ => Err(fail(o::ErrorCode::NotReady)),
                }
            }
            Op::Copy | Op::Delete => {
                let id = self.next()?;
                let name = request.opaque("reference").unwrap();
                let revision = self.fence(scope, request)?;
                if request.operation() == Op::Copy
                    && request.opaque("generation") == request.opaque("source_generation")
                {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                let auth = Authority {
                    access: &self.access,
                    scope,
                    tenant,
                };
                let mutation = if request.operation() == Op::Copy {
                    c::Mutation::Link {
                        source: request.opaque("source").unwrap().as_str().into(),
                        destination: name.as_str().into(),
                        expected_revision: revision,
                    }
                } else {
                    c::Mutation::Tombstone {
                        name: name.as_str().into(),
                        expected_revision: revision,
                    }
                };
                let result = self
                    .model
                    .catalogue
                    .transact(tenant, c::OperationId(id), mutation, self.now, &auth)
                    .map_err(map)?;
                let g = match result {
                    c::Outcome::Reference { generation, .. } => generation,
                    _ => generation(
                        request
                            .opaque("generation")
                            .ok_or(fail(o::ErrorCode::Internal))?,
                    )?,
                };
                let mut job = self.new_job(
                    scope,
                    o::LogicalReference {
                        reference: name.clone(),
                        generation: token("g", g.0),
                    },
                    id,
                    None,
                )?;
                job.value.state = o::JobState::Succeeded;
                job.value.effects = o::Effects::Committed;
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
                if request.operation() == Op::Copy {
                    let source = request.opaque("source").unwrap();
                    let mut object = self
                        .model
                        .objects
                        .get(&(tenant, g, source.as_str().into()))
                        .cloned()
                        .ok_or_else(denied)?;
                    object.target.object = native_id(name);
                    self.model
                        .objects
                        .insert((tenant, g, name.as_str().into()), object);
                    let parents = self
                        .model
                        .members
                        .iter()
                        .filter(|(t, _, n)| *t == tenant && n == source)
                        .map(|(_, p, _)| p.clone())
                        .collect::<Vec<_>>();
                    for parent in parents {
                        self.model.members.insert((tenant, parent, name.clone()));
                    }
                }
                Ok(Out::Job(job.value))
            }
            Op::Capabilities | Op::Versions => Err(fail(o::ErrorCode::Unsupported)),
        }
    }
    fn cancel(&mut self, scope: &o::Scope, mut job: Job) -> Result<o::Output, o::Failure> {
        let outcome = if job.value.effects == o::Effects::Committed {
            o::CancelOutcome::AlreadyCommitted
        } else if job.value.state.terminal() {
            o::CancelOutcome::AlreadyTerminal
        } else {
            self.permit(scope, &job.value.target.reference, c::Action::Write)?;
            if self
                .model
                .uploads
                .values()
                .any(|u| u.job == job.value.handle && u.cleanup)
            {
                job.value.state = o::JobState::CancelRequested;
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
                return Ok(o::Output::Cancel {
                    job: job.value,
                    outcome: o::CancelOutcome::Requested,
                });
            }
            if let Some((restore, subscription)) = job.restore {
                let tenant = self.tenant(scope)?;
                let id = self.next()?;
                let auth = Authority {
                    access: &self.access,
                    scope,
                    tenant,
                };
                self.model
                    .catalogue
                    .transact(
                        tenant,
                        c::OperationId(id),
                        c::Mutation::CancelSubscription {
                            name: job.value.target.reference.as_str().into(),
                            job: restore,
                            subscription,
                        },
                        self.now,
                        &auth,
                    )
                    .map_err(map)?;
                // Cancels only this subscription. Other principals' subscriptions
                // and the shared worker are not rolled back or disconnected.
            }
            job.value.state = o::JobState::Cancelled;
            job.value.effects = o::Effects::None;
            self.model
                .jobs
                .insert(job.value.handle.clone(), job.clone());
            o::CancelOutcome::StoppedBeforeCommit
        };
        Ok(o::Output::Cancel {
            job: job.value,
            outcome,
        })
    }
}
