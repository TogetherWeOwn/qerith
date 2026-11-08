//! In-process reference product service. No listener, database or scheduler.
//!
//! A checkpoint is an explicit model value, not evidence of durable persistence.
//! Access and storage are trusted live ports; neither is restored from a checkpoint.

mod bridge;
pub use bridge::UploadWorker;

use crate::{catalogue as c, composition as flow, native as n, operations as o};
use c::{JobPort, MetadataOutbox, MutationTargets};
use std::collections::{BTreeMap, BTreeSet};

/// Authenticated live policy. Missing/foreign/revoked/banned references all deny.
/// Implementations must not derive these grants from request fields or snapshots.
pub trait Access {
    fn tenant(&self, scope: &o::Scope) -> Option<c::TenantId>;
    fn permits(&self, scope: &o::Scope, reference: &str, action: c::Action) -> bool;
    fn container(&self, scope: &o::Scope, parent: &str) -> bool;
    fn admit(&self, scope: &o::Scope) -> bool;
    fn key_envelope(&self, scope: &o::Scope, key: &n::Opaque, envelope: &n::Opaque) -> bool;
    /// Trusted profile/context qualification for reusing C under a fresh logical G.
    /// A key grant alone does not prove compatibility with a destination context.
    fn copy_compatible(
        &self,
        _scope: &o::Scope,
        _source: &n::Object,
        _destination: &o::Opaque,
    ) -> bool {
        false
    }
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

struct UploadAuthority<'a, A> {
    authority: Authority<'a, A>,
    descriptor: &'a Descriptor,
}
impl<A: Access> c::Authority for UploadAuthority<'_, A> {
    fn is_current(&self) -> bool {
        self.authority.is_current()
            && self
                .authority
                .access
                .container(self.authority.scope, self.descriptor.parent.as_str())
            && self.authority.access.key_envelope(
                self.authority.scope,
                &self.descriptor.intent.ciphertext.key_ref,
                &self.descriptor.intent.ciphertext.envelope_ref,
            )
    }
    fn permits(&self, reference: &c::Reference, action: c::Action) -> bool {
        self.is_current() && self.authority.permits(reference, action)
    }
}

// Mark the retained cleanup obligation at the I/O boundary, not at admission.
struct UploadStorage<'a, S> {
    storage: &'a mut S,
    cleanup: &'a mut bool,
}
impl<S: flow::Storage> flow::Storage for UploadStorage<'_, S> {
    async fn stage_upload(
        &mut self,
        upload: &flow::Upload,
        budget: &flow::Budget,
        until: u64,
    ) -> Result<c::CompleteCopy, flow::IoError> {
        *self.cleanup = true;
        self.storage.stage_upload(upload, budget, until).await
    }
    async fn post(&mut self, work: &flow::Work) -> Result<(), flow::IoError> {
        self.storage.post(work).await
    }
    async fn verify_archive(
        &mut self,
        work: &flow::Work,
    ) -> Result<[flow::Reconstruction; 2], flow::IoError> {
        self.storage.verify_archive(work).await
    }
    async fn retrieve(&mut self, work: &flow::Work) -> Result<(), flow::IoError> {
        self.storage.retrieve(work).await
    }
    async fn complete_restore(
        &mut self,
        work: &flow::Work,
    ) -> Result<c::CompleteCopy, flow::IoError> {
        self.storage.complete_restore(work).await
    }
    async fn verify_completed(
        &mut self,
        work: &flow::Work,
        location: &str,
    ) -> Result<c::CompleteCopy, flow::IoError> {
        self.storage.verify_completed(work, location).await
    }
    async fn cleanup_incomplete(&mut self, work: &flow::Work) -> Result<(), flow::IoError> {
        self.storage.cleanup_incomplete(work).await
    }
}

#[derive(Clone)]
struct CopyDescriptor {
    source: n::Object,
    destination: o::Opaque,
    parents: Vec<o::Opaque>,
}
impl CopyDescriptor {
    fn permitted(&self, access: &impl Access, scope: &o::Scope) -> bool {
        access.key_envelope(
            scope,
            &self.source.ciphertext.key_ref,
            &self.source.ciphertext.envelope_ref,
        ) && access.copy_compatible(scope, &self.source, &self.destination)
            && self
                .parents
                .iter()
                .all(|parent| access.container(scope, parent.as_str()))
    }
}
struct CopyAuthority<'a, A> {
    authority: Authority<'a, A>,
    descriptor: &'a CopyDescriptor,
}
impl<A: Access> c::Authority for CopyAuthority<'_, A> {
    fn is_current(&self) -> bool {
        self.authority.is_current()
            && self
                .descriptor
                .permitted(self.authority.access, self.authority.scope)
    }
    fn permits(&self, reference: &c::Reference, action: c::Action) -> bool {
        self.authority.permits(reference, action) && self.is_current()
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
    storage_generation: c::GenerationId,
    expected_revision: u64,
    created_at: u64,
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
    copy: Option<CopyDescriptor>,
    native_upload: bool,
    requires_live_target: bool,
}
#[derive(Clone)]
struct Cursor {
    scope: o::Scope,
    parent: o::Opaque,
    limit: u64,
    expires: u64,
    entries: Vec<o::Entry>,
}

#[derive(Clone)]
struct BoundObject {
    object: n::Object,
    storage_generation: c::GenerationId,
    revision: u64,
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
    objects: BTreeMap<(c::TenantId, c::GenerationId, String), BoundObject>,
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
fn retain_effects(mut failure: o::Failure, effects: o::Effects) -> o::Failure {
    if failure.effects == o::Effects::None
        && !matches!(
            failure.code,
            o::ErrorCode::Denied | o::ErrorCode::Unauthenticated
        )
    {
        failure.effects = effects;
    }
    failure
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
    pub fn limits(&self) -> &Limits {
        &self.limits
    }
    pub fn now(&self) -> u64 {
        self.now
    }
    fn reserve(&self, additional: usize) -> Result<(), o::Failure> {
        let count = self.model.uploads.len()
            + self.model.jobs.len()
            + self.model.transfers.len()
            + self.model.cursors.len()
            + self.model.replay.len()
            + self.model.objects.len()
            + self
                .model
                .uploads
                .values()
                .filter(|upload| {
                    self.model
                        .jobs
                        .get(&upload.job)
                        .is_some_and(|job| job.value.effects != o::Effects::Committed)
                })
                .count();
        if count.saturating_add(additional) > self.limits.records {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        Ok(())
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
    fn catalogue_identity(&mut self, scope: &o::Scope) -> Result<u64, o::Failure> {
        let tenant = self.tenant(scope)?;
        self.model.catalogue.allocate_identity(tenant).map_err(map)
    }
    fn check_bytes(&self, bytes: u64) -> Result<(), o::Failure> {
        if bytes > self.limits.bytes {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        Ok(())
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
    // Write predicates resolve only a tenant/revision/validator-bound logical G.
    // A denied or unbound target is never projected as an absent destination.
    fn write_target(
        &self,
        scope: &o::Scope,
        name: &o::Opaque,
    ) -> Result<(u64, Option<BoundObject>), o::Failure> {
        let auth = self.authority(scope)?;
        let (revision, target) = self
            .model
            .catalogue
            .write_target(auth.tenant, name.as_str(), self.now, &auth)
            .map_err(map)?;
        let Some(target) = target else {
            return Ok((revision, None));
        };
        let bound = self
            .model
            .objects
            .iter()
            .find_map(|((tenant, generation, object), bound)| {
                (*tenant == auth.tenant
                    && object == name.as_str()
                    && bound.storage_generation == *generation
                    && bound.revision == revision
                    && bound.object.target.object.as_str() == name.as_str()
                    && self
                        .model
                        .catalogue
                        .generation(auth.tenant, *generation)
                        .is_ok_and(|stored| stored.metadata.validator == target.validator))
                .then_some(bound.clone())
            })
            .ok_or_else(denied)?;
        Ok((revision, Some(bound)))
    }
    fn write_exact(
        &self,
        scope: &o::Scope,
        target: &o::LogicalReference,
    ) -> Result<u64, o::Failure> {
        let (revision, bound) = self.write_target(scope, &target.reference)?;
        if !bound.is_some_and(|bound| bound.object.target.g.as_str() == target.generation.as_str())
        {
            return Err(fail(o::ErrorCode::PreconditionFailed));
        }
        Ok(revision)
    }
    fn exact(
        &self,
        scope: &o::Scope,
        target: &o::LogicalReference,
    ) -> Result<c::ReferenceView, o::Failure> {
        self.permit(scope, &target.reference, c::Action::Read)?;
        let value = self.lookup(scope, &target.reference)?;
        let bound = self.bound_object(scope, &target.reference, &value)?;
        if bound.object.target.g.as_str() != target.generation.as_str() {
            return Err(fail(o::ErrorCode::PreconditionFailed));
        }
        Ok(value)
    }
    fn bound_object(
        &self,
        scope: &o::Scope,
        name: &o::Opaque,
        view: &c::ReferenceView,
    ) -> Result<&BoundObject, o::Failure> {
        self.model
            .objects
            .get(&(self.tenant(scope)?, view.generation, name.as_str().into()))
            .filter(|bound| {
                bound.storage_generation == view.generation
                    && bound.revision == view.revision
                    && bound.object.target.object.as_str() == name.as_str()
            })
            .ok_or_else(denied)
    }
    fn permit_copy(
        &self,
        scope: &o::Scope,
        request: &o::Request,
    ) -> Result<CopyDescriptor, o::Failure> {
        let source = request.opaque("source").unwrap();
        let view = self.exact(
            scope,
            &o::LogicalReference {
                reference: source.clone(),
                generation: request.opaque("source_generation").unwrap().clone(),
            },
        )?;
        let object = &self.bound_object(scope, source, &view)?.object;
        if !self.access.key_envelope(
            scope,
            &object.ciphertext.key_ref,
            &object.ciphertext.envelope_ref,
        ) {
            return Err(denied());
        }
        if !self
            .access
            .copy_compatible(scope, object, request.opaque("reference").unwrap())
        {
            return Err(fail(o::ErrorCode::Unsupported));
        }
        let tenant = self.tenant(scope)?;
        for (_, parent, _) in self
            .model
            .members
            .iter()
            .filter(|(t, _, name)| *t == tenant && name == source)
        {
            if !self.access.container(scope, parent.as_str()) {
                return Err(denied());
            }
        }
        if !view
            .availability_until
            .is_some_and(|until| until > self.now)
        {
            return Err(fail(o::ErrorCode::NotAvailable));
        }
        Ok(CopyDescriptor {
            source: object.clone(),
            destination: request.opaque("reference").unwrap().clone(),
            parents: self
                .model
                .members
                .iter()
                .filter(|(t, _, name)| *t == tenant && name == source)
                .map(|(_, parent, _)| parent.clone())
                .collect(),
        })
    }
    fn target(request: &o::Request) -> o::LogicalReference {
        o::LogicalReference {
            reference: request.opaque("reference").unwrap().clone(),
            generation: request.opaque("generation").unwrap().clone(),
        }
    }
    fn job(&self, scope: &o::Scope, id: &o::Opaque) -> Result<Job, o::Failure> {
        self.job_access(scope, id, None)
    }
    fn job_access(
        &self,
        scope: &o::Scope,
        id: &o::Opaque,
        action: Option<c::Action>,
    ) -> Result<Job, o::Failure> {
        let job = self.authorized_job(scope, id, action)?;
        let effects = job.value.effects;
        self.project_job(scope, job, action)
            .map_err(|failure| retain_effects(failure, effects))
    }
    fn authorized_job(
        &self,
        scope: &o::Scope,
        id: &o::Opaque,
        action: Option<c::Action>,
    ) -> Result<Job, o::Failure> {
        let job = self
            .model
            .jobs
            .get(id)
            .filter(|j| j.scope == *scope)
            .cloned()
            .ok_or_else(denied)?;
        self.permit(
            scope,
            &job.value.target.reference,
            action.unwrap_or(
                if job.native_upload && job.value.effects != o::Effects::Committed {
                    c::Action::Write
                } else {
                    c::Action::Read
                },
            ),
        )?;
        Ok(job)
    }
    fn project_job(
        &self,
        scope: &o::Scope,
        mut job: Job,
        action: Option<c::Action>,
    ) -> Result<Job, o::Failure> {
        if job.restore.is_some()
            || job.requires_live_target && job.value.effects == o::Effects::Committed
        {
            if action == Some(c::Action::Write) {
                self.write_exact(scope, &job.value.target)?;
            } else {
                self.exact(scope, &job.value.target)?;
            }
        }
        if let Some((id, subscription)) = job
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
                c::JobState::Queued => o::JobState::Queued,
                // RetryWait can only follow a claimed attempt, not fresh admission.
                c::JobState::RetryWait { .. } | c::JobState::Running => o::JobState::Running,
                c::JobState::Complete => {
                    if self
                        .model
                        .catalogue
                        .restore_published(
                            self.tenant(scope)?,
                            id,
                            job.value.target.reference.as_str(),
                            subscription,
                        )
                        .map_err(map)?
                    {
                        o::JobState::Succeeded
                    } else {
                        o::JobState::Failed
                    }
                }
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
                job.value.error = Some(o::Failure {
                    code: o::ErrorCode::Unavailable,
                    effects: job.value.effects,
                });
            }
        }
        if self.now >= job.deadline && !job.value.state.terminal() {
            job.value.state = o::JobState::Failed;
            job.value.error = Some(o::Failure {
                code: o::ErrorCode::Unavailable,
                effects: job.value.effects,
            });
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
    // Only called after full request authorization. Retain scope-bound obligations
    // across policy/state rejection; denial itself must never disclose job state.
    fn retain_request_effects(
        &self,
        scope: &o::Scope,
        request: &o::Request,
        failure: o::Failure,
    ) -> o::Failure {
        if matches!(
            failure.code,
            o::ErrorCode::Denied | o::ErrorCode::Unauthenticated
        ) {
            return failure;
        }
        let write = matches!(
            request.operation(),
            o::Operation::InitiateUpload
                | o::Operation::CommitUpload
                | o::Operation::AbortUpload
                | o::Operation::Copy
                | o::Operation::Delete
        );
        let action = write.then_some(c::Action::Write);
        let effects = |handle| match self.job_access(scope, handle, action) {
            Ok(job) => job.value.effects,
            Err(failure) => failure.effects,
        };
        // An existing identity owns the obligation, never a replacement handle.
        // Both its original request and live output must remain authorized.
        if let Some((prior, output)) = request
            .reconciliation(scope)
            .and_then(|key| self.model.replay.get(&key))
        {
            if self.check_authorization(scope, prior).is_err() {
                return denied();
            }
            return match output {
                o::Output::Job(job)
                | o::Output::Upload { job, .. }
                | o::Output::Cancel { job, .. } => {
                    match self.job_access(scope, &job.handle, action) {
                        Ok(job) => o::Failure {
                            effects: job.value.effects,
                            ..failure
                        },
                        Err(projection) => {
                            if matches!(
                                projection.code,
                                o::ErrorCode::Denied | o::ErrorCode::Unauthenticated
                            ) {
                                projection
                            } else {
                                o::Failure {
                                    effects: projection.effects,
                                    ..failure
                                }
                            }
                        }
                    }
                }
                _ => failure,
            };
        }
        if let Some(handle) = request
            .opaque("transfer")
            .and_then(|handle| {
                self.model
                    .uploads
                    .get(handle)
                    .filter(|upload| upload.scope == *scope)
                    .map(|upload| &upload.job)
            })
            .or(request.opaque("job"))
        {
            return retain_effects(failure, effects(handle));
        }
        failure
    }
    fn permit_descriptor(
        &self,
        scope: &o::Scope,
        descriptor: &Descriptor,
    ) -> Result<(), o::Failure> {
        self.permit(
            scope,
            &operation_id(&descriptor.intent.object)?,
            c::Action::Write,
        )?;
        if !self.access.container(scope, descriptor.parent.as_str())
            || !self.access.key_envelope(
                scope,
                &descriptor.intent.ciphertext.key_ref,
                &descriptor.intent.ciphertext.envelope_ref,
            )
        {
            return Err(denied());
        }
        Ok(())
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
        n::validate_stored_upload(&intent, &self.profile).map_err(|error| {
            fail(match error {
                n::ErrorCode::UnsupportedProfile => o::ErrorCode::Unsupported,
                n::ErrorCode::LimitExceeded => o::ErrorCode::QuotaExceeded,
                _ => o::ErrorCode::InvalidInput,
            })
        })?;
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
        self.permit_descriptor(scope, &upload.descriptor)?;
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
        self.permit_descriptor(scope, &upload.descriptor)?;
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
        self.permit_descriptor(scope, &upload.descriptor)?;
        let job = self.job_access(scope, &upload.job, Some(c::Action::Write))?;
        let result = (|| {
            self.set_now(clock.now().map_err(|_| fail(o::ErrorCode::Unavailable))?)?;
            self.check_bytes(upload.descriptor.intent.ciphertext.length)
        })();
        result.map_err(|failure| retain_effects(failure, job.value.effects))?;
        let job = self.job_access(scope, &upload.job, Some(c::Action::Write))?;
        if job.value.state == o::JobState::Succeeded {
            return Ok(job.value);
        }
        if !upload.submitted
            || job.value.state.terminal()
            || job.value.state == o::JobState::CancelRequested
        {
            return Err(o::Failure {
                code: o::ErrorCode::Conflict,
                effects: job.value.effects,
            });
        }
        let mut metadata = metadata(&upload.descriptor.intent, upload.created_at)?;
        metadata.validator = format!("upload_{}", upload.intent.0);
        let tenant = self.tenant(scope)?;
        let work = flow::Upload {
            tenant,
            intent: upload.intent,
            commit: upload.commit,
            name: upload.transfer.target.reference.as_str().into(),
            expected_revision: upload.expected_revision,
            generation: upload.storage_generation,
            metadata,
            archive_deadline: job.deadline,
        };
        let authority = UploadAuthority {
            authority: Authority {
                access: &self.access,
                scope,
                tenant,
            },
            descriptor: &upload.descriptor,
        };
        if upload.attempts >= self.limits.attempts {
            return Err(o::Failure {
                code: o::ErrorCode::QuotaExceeded,
                effects: job.value.effects,
            });
        }
        self.model.uploads.get_mut(handle).unwrap().attempts += 1;
        let mut storage = UploadStorage {
            storage,
            cleanup: &mut self.model.uploads.get_mut(handle).unwrap().cleanup,
        };
        if let Err(error) = flow::ingest(
            &mut self.model.catalogue,
            &mut storage,
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
                flow::Failure::Clock(_) => fail(o::ErrorCode::Unavailable),
                flow::Failure::Io(flow::IoError::Integrity) => fail(o::ErrorCode::IntegrityFailed),
                flow::Failure::Io(flow::IoError::Uncertain) => o::Failure {
                    code: o::ErrorCode::Unavailable,
                    effects: o::Effects::Unknown,
                },
                _ => fail(o::ErrorCode::Unavailable),
            };
            let effects = if self.model.uploads.get(handle).unwrap().cleanup {
                o::Effects::Unknown
            } else {
                job.value.effects
            };
            self.model.jobs.get_mut(&upload.job).unwrap().value.effects = effects;
            // Keep physical uncertainty internally even if effect-time revocation
            // makes the public result an opaque denial.
            self.permit_descriptor(scope, &upload.descriptor)?;
            return Err(retain_effects(failure, effects));
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
        self.model.objects.insert(
            (tenant, work.generation, work.name),
            BoundObject {
                object,
                storage_generation: work.generation,
                revision: upload.expected_revision + 1,
            },
        );
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
        let view = self.exact(scope, &transfer.value.target)?;
        self.check_bytes(view.metadata.identity.length)?;
        if self.now >= transfer.value.expires_at {
            return Err(fail(o::ErrorCode::NotAvailable));
        }
        let auth = self.authority(scope)?;
        let g = self
            .model
            .catalogue
            .validate_pin(auth.tenant, transfer.pin, self.now, &auth)
            .map_err(map)?;
        if g != self.exact(scope, &transfer.value.target)?.generation {
            return Err(denied());
        }
        Ok((g, transfer.pin))
    }
    fn fence(&self, scope: &o::Scope, request: &o::Request) -> Result<u64, o::Failure> {
        let name = request.opaque("reference").unwrap();
        if request.if_absent() {
            let (revision, current) = self.write_target(scope, name)?;
            // Recreating a tombstone still needs a known revision contract.
            if revision != 0 || current.is_some() {
                return Err(fail(o::ErrorCode::PreconditionFailed));
            }
            Ok(0)
        } else {
            self.write_exact(scope, &Self::target(request))
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
            copy: None,
            native_upload: false,
            requires_live_target: true,
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
    for (i, pair) in hex.as_bytes().as_chunks::<2>().0.iter().enumerate() {
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

impl<A: Access> Service<A> {
    fn check_authorization(
        &self,
        scope: &o::Scope,
        request: &o::Request,
    ) -> Result<(), o::Failure> {
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
            let job = if request.operation() == o::Operation::Cancel {
                self.job_access(scope, id, Some(c::Action::Read))?
            } else {
                self.authorized_job(scope, id, None)?
            };
            if request.operation() == o::Operation::Cancel
                && !job.value.state.terminal()
                && job.value.effects != o::Effects::Committed
            {
                self.permit(
                    scope,
                    &job.value.target.reference,
                    if job.restore.is_some() {
                        c::Action::Restore
                    } else {
                        c::Action::Write
                    },
                )?;
            }
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
            self.permit_descriptor(scope, &upload.descriptor)?;
        }
        if request.operation() == o::Operation::Restore {
            self.permit(
                scope,
                request.opaque("reference").unwrap(),
                c::Action::Restore,
            )?;
        }
        if request.operation() == o::Operation::Copy {
            if let Some(o::Output::Job(job)) = request
                .reconciliation(scope)
                .and_then(|key| self.model.replay.get(&key))
                .filter(|(prior, _)| prior == request)
                .map(|(_, output)| output)
            {
                let stored = self
                    .model
                    .jobs
                    .get(&job.handle)
                    .filter(|job| job.scope == *scope)
                    .ok_or_else(denied)?;
                if !stored
                    .copy
                    .as_ref()
                    .is_some_and(|copy| copy.permitted(&self.access, scope))
                {
                    return Err(denied());
                }
            } else {
                self.permit_copy(scope, request)?;
            }
        }
        if request.operation() == o::Operation::InitiateUpload {
            let descriptor = self
                .model
                .descriptors
                .get(&(scope.clone(), request.opaque("identity").unwrap().clone()))
                .ok_or(fail(o::ErrorCode::InvalidInput))?;
            self.permit_descriptor(scope, descriptor)?;
        }
        Ok(())
    }
}

impl<A: Access> Service<A> {
    fn check_preconditions(
        &mut self,
        scope: &o::Scope,
        request: &o::Request,
    ) -> Result<(), o::Failure> {
        if let Some(id) = request.opaque("job") {
            self.job(scope, id)?;
        }
        if let Some(output) = self.replay(scope, request)? {
            match output {
                o::Output::Job(job)
                | o::Output::Upload { job, .. }
                | o::Output::Cancel { job, .. } => {
                    let write = matches!(
                        request.operation(),
                        o::Operation::InitiateUpload
                            | o::Operation::CommitUpload
                            | o::Operation::AbortUpload
                            | o::Operation::Copy
                            | o::Operation::Delete
                    );
                    self.job_access(scope, &job.handle, write.then_some(c::Action::Write))?;
                }
                o::Output::Download(transfer) => {
                    self.redeem(scope, &transfer.handle)?;
                }
                _ => {}
            }
            if matches!(
                request.operation(),
                o::Operation::InitiateUpload
                    | o::Operation::CommitUpload
                    | o::Operation::AbortUpload
                    | o::Operation::Copy
                    | o::Operation::Delete
            ) {
                return Ok(());
            }
        }
        match request.operation() {
            o::Operation::InitiateUpload | o::Operation::Copy => {
                self.fence(scope, request)?;
            }
            o::Operation::Delete => {
                self.write_exact(scope, &Self::target(request))?;
            }
            o::Operation::Stat | o::Operation::Restore | o::Operation::AuthorizeDownload => {
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
    fn check_admission(
        &mut self,
        scope: &o::Scope,
        request: &o::Request,
    ) -> Result<(), o::Failure> {
        if request
            .number("max_bytes")
            .is_some_and(|b| b > self.limits.bytes)
            || request
                .number("availability_seconds")
                .is_some_and(|s| s > self.limits.job_seconds)
            || request
                .number("max_seconds")
                .is_some_and(|s| s > self.limits.job_seconds)
        {
            return Err(fail(o::ErrorCode::QuotaExceeded));
        }
        match request.operation() {
            o::Operation::CommitUpload => {
                let upload = self
                    .model
                    .uploads
                    .get(request.opaque("transfer").unwrap())
                    .ok_or_else(denied)?;
                self.job_access(scope, &upload.job, Some(c::Action::Write))?;
                self.check_bytes(upload.descriptor.intent.ciphertext.length)?;
            }
            o::Operation::Restore | o::Operation::AuthorizeDownload => {
                let view = self.exact(scope, &Self::target(request))?;
                self.check_bytes(view.metadata.identity.length)?;
            }
            _ => {}
        }
        if self.replay(scope, request)?.is_some() {
            return Ok(());
        }
        // Reserve only the actual new rows, including the reconciliation row.
        // Read-only browse reserves a cursor at the insertion point instead.
        let additional = match request.operation() {
            // Includes the eventual immutable object binding, held until completion.
            o::Operation::InitiateUpload => 4,
            o::Operation::Copy => 3,
            o::Operation::Delete | o::Operation::Restore | o::Operation::AuthorizeDownload => 2,
            o::Operation::CommitUpload | o::Operation::AbortUpload | o::Operation::Cancel => 1,
            _ => 0,
        };
        self.reserve(additional)
    }
}

impl<A: Access> o::OperationPort for Service<A> {
    fn authorize(&mut self, scope: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        self.check_authorization(scope, request)
            .map_err(|failure| self.retain_request_effects(scope, request, failure))
    }
    fn preconditions(&mut self, scope: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        self.check_preconditions(scope, request).map_err(|failure| {
            match self.check_authorization(scope, request) {
                Ok(()) => self.retain_request_effects(scope, request, failure),
                Err(denial) => denial,
            }
        })
    }
    fn admit(&mut self, scope: &o::Scope, request: &o::Request) -> Result<(), o::Failure> {
        self.check_admission(scope, request).map_err(|failure| {
            match self.check_authorization(scope, request) {
                Ok(()) => self.retain_request_effects(scope, request, failure),
                Err(denial) => denial,
            }
        })
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
        if let Some(cursor) = position {
            if request.operation() != o::Operation::Browse
                || request.opaque("cursor") != Some(cursor)
            {
                return Err(fail(o::ErrorCode::InvalidCursor));
            }
            self.resolve_cursor(scope, request, cursor)?;
        } else if request.opaque("cursor").is_some() {
            return Err(fail(o::ErrorCode::InvalidCursor));
        }
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
                Err(self.retain_request_effects(scope, request, error))
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
                let mut job =
                    self.new_job(scope, target.clone(), id, request.number("max_bytes"))?;
                job.native_upload = true;
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
                    storage_generation: c::GenerationId(self.catalogue_identity(scope)?),
                    intent: c::OperationId(self.catalogue_identity(scope)?),
                    commit: c::OperationId(self.catalogue_identity(scope)?),
                    expected_revision,
                    created_at: self.now,
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
                let mut job = self.job_access(scope, &upload.job, Some(c::Action::Write))?;
                if request.operation() == Op::AbortUpload {
                    return self.cancel(scope, job);
                }
                if job.value.state == o::JobState::Succeeded {
                    return Ok(Out::Job(job.value));
                }
                if job.value.state.terminal()
                    || job.value.state == o::JobState::CancelRequested
                    || self.now >= upload.transfer.expires_at
                    || upload.received != upload.transfer.max_bytes
                    || !upload.verified
                {
                    return Err(fail(o::ErrorCode::Conflict));
                }
                let (revision, current) =
                    self.write_target(scope, &upload.transfer.target.reference)?;
                let matches = match &upload.descriptor.intent.precondition {
                    n::Precondition::Absent => revision == 0 && current.is_none(),
                    n::Precondition::Matches(g) => {
                        current.is_some_and(|bound| bound.object.target.g == *g)
                    }
                };
                if revision != upload.expected_revision || !matches {
                    return Err(fail(o::ErrorCode::PreconditionFailed));
                }
                self.model.uploads.get_mut(handle).unwrap().submitted = true;
                job.value.state = o::JobState::Running;
                if job.value.effects != o::Effects::Unknown {
                    job.value.effects = o::Effects::Accepted;
                }
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
                                    generation: operation_id(
                                        &self
                                            .bound_object(scope, name, &view)
                                            .ok()?
                                            .object
                                            .target
                                            .g,
                                    )
                                    .ok()?,
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
                let existing = self
                    .model
                    .cursors
                    .iter()
                    .find(|(_, cursor)| {
                        cursor.scope == *scope
                            && cursor.parent == *parent
                            && cursor.limit == limit
                            && cursor.expires > self.now
                            && entries.len() > limit as usize
                            && cursor.entries == entries[limit as usize..]
                    })
                    .map(|(id, _)| id.clone());
                let cursor = if existing.is_some() {
                    existing
                } else if entries.len() > limit as usize {
                    self.reserve(1)?;
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
                let operation = c::OperationId(self.catalogue_identity(scope)?);
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
                        operation,
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
                if let Some(seconds) = request.number("max_seconds") {
                    job.deadline = self.expiry(seconds)?.min(job.deadline);
                }
                let operation = c::OperationId(self.catalogue_identity(scope)?);
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
                        operation,
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
                job.restore = Some((restore, operation));
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
                    _ => Err(o::Failure {
                        code: o::ErrorCode::NotReady,
                        effects: job.value.effects,
                    }),
                }
            }
            Op::Copy | Op::Delete => {
                let id = self.next()?;
                let operation = c::OperationId(self.catalogue_identity(scope)?);
                let name = request.opaque("reference").unwrap();
                let revision = self.fence(scope, request)?;
                let copy = if request.operation() == Op::Copy {
                    Some(self.permit_copy(scope, request)?)
                } else {
                    None
                };
                let logical_generation = if copy.is_some() {
                    token("g", id)
                } else {
                    request.opaque("generation").unwrap().clone()
                };
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
                let copy_authority;
                let authority: &dyn c::Authority = if let Some(descriptor) = &copy {
                    copy_authority = CopyAuthority {
                        authority: auth,
                        descriptor,
                    };
                    &copy_authority
                } else {
                    &auth
                };
                let result = self
                    .model
                    .catalogue
                    .transact(tenant, operation, mutation, self.now, authority)
                    .map_err(map)?;
                if let Some(descriptor) = &copy {
                    let mut object = descriptor.source.clone();
                    let c::Outcome::Reference {
                        generation: storage_generation,
                        revision,
                    } = result
                    else {
                        return Err(fail(o::ErrorCode::Internal));
                    };
                    object.target = n::Target {
                        object: native_id(name),
                        g: native_id(&logical_generation),
                    };
                    self.model.objects.insert(
                        (tenant, storage_generation, name.as_str().into()),
                        BoundObject {
                            object,
                            storage_generation,
                            revision,
                        },
                    );
                    for parent in descriptor.parents.iter().cloned() {
                        self.model.members.insert((tenant, parent, name.clone()));
                    }
                }
                let mut job = self.new_job(
                    scope,
                    o::LogicalReference {
                        reference: name.clone(),
                        generation: logical_generation,
                    },
                    id,
                    None,
                )?;
                job.value.state = o::JobState::Succeeded;
                job.value.effects = o::Effects::Committed;
                job.copy = copy;
                job.requires_live_target = request.operation() != Op::Delete;
                self.model
                    .jobs
                    .insert(job.value.handle.clone(), job.clone());
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
            self.permit(
                scope,
                &job.value.target.reference,
                if job.restore.is_some() {
                    c::Action::Restore
                } else {
                    c::Action::Write
                },
            )?;
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
                let operation = c::OperationId(self.catalogue_identity(scope)?);
                let auth = Authority {
                    access: &self.access,
                    scope,
                    tenant,
                };
                self.model
                    .catalogue
                    .transact(
                        tenant,
                        operation,
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
