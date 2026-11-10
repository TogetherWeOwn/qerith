//! Vendor-neutral catalogue and durable-job *contracts*.
//!
//! [`MemoryCatalogue`] is a non-durable executable specification, not a database,
//! scheduler, cryptographic verifier or authorization service. See `CONTRACT.md`
//! for the durable adapter's atomicity, recovery and trust requirements.

mod archive;
mod memory;
pub use archive::{
    archive_expiry, ArchiveReadPort, ArchiveView, BucketError, BucketView, CapacityReservation,
};
pub use memory::MemoryCatalogue;

use std::collections::BTreeMap;

macro_rules! id {
    ($($name:ident),+ $(,)?) => {$ (
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(pub u64);
    )+ };
}
id!(
    TenantId,
    GenerationId,
    OperationId,
    JobId,
    EventId,
    PinId,
    BackboneId
);

/// Logical names have meaning only within their authenticated tenant scope.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Reference {
    pub tenant: TenantId,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Read,
    Write,
    Restore,
}

/// Supplied by a trusted adapter, never deserialized from an untrusted request.
/// Implementations must consult current policy, not the worker's queued snapshot.
pub trait Authority {
    fn is_current(&self) -> bool;
    fn permits(&self, reference: &Reference, action: Action) -> bool;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CiphertextIdentity {
    pub length: u64,
    pub sha256: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChecksumType {
    FullObject,
    Composite,
}

/// Negotiated checksums are preserved as evidence, not silently reinterpreted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checksum {
    pub algorithm: String,
    pub kind: ChecksumType,
    pub value: Vec<u8>,
    pub parts: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CiphertextMetadata {
    pub identity: CiphertextIdentity,
    pub validator: String,
    pub modified_at: u64,
    pub headers: BTreeMap<String, String>,
    pub checksums: Vec<Checksum>,
    /// Opaque, access-controlled recovery catalogue reference; never key material.
    pub recovery_ref: String,
}

/// A trusted storage verifier's assertion of a complete retained/staged copy.
/// This contract compares evidence; it does not inspect bytes or prove encryption.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompleteCopy {
    pub identity: CiphertextIdentity,
    pub checksums: Vec<Checksum>,
    /// Immutable, generation/copy-qualified storage version, never a reusable key.
    pub location: String,
    pub receipt: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerificationEvidence {
    pub generation: GenerationId,
    pub backbone: BackboneId,
    pub reconstructed: CiphertextIdentity,
    pub verified_at: u64,
    pub valid_until: u64,
    pub verifier_version: String,
    pub provenance_ref: String,
    /// Separate trusted-client authenticated readability result, without keys.
    pub readability_ref: String,
}

/// Trusted backend-specific qualification, not an S3 acknowledgement or an ETag.
/// The worker authenticates these external references; no client can supply them.
/// This permits archive completion/publication only, never safety-copy eviction.
#[cfg(feature = "archive-provider")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct S3VerificationEvidence {
    pub record: velmora::archive::v1::ObjectRecord,
    pub recovery_ref: String,
    pub verified_at: u64,
    pub valid_until: u64,
    pub verifier_version: String,
    pub provenance_ref: String,
    pub readability_ref: String,
    pub durability_ref: String,
}

#[cfg(feature = "archive-provider")]
impl S3VerificationEvidence {
    pub(crate) fn valid(
        &self,
        tenant: TenantId,
        generation: GenerationId,
        metadata: &CiphertextMetadata,
        now: u64,
    ) -> bool {
        let identity = &self.record.identity;
        self.record.validate().is_ok()
            && identity.target.backend == velmora::archive::v1::Backend::S3
            && identity.target.tenant.as_str() == tenant.0.to_string()
            && identity.target.generation.as_str() == generation.0.to_string()
            && identity.bytes == metadata.identity.length
            && identity.sha256 == metadata.identity.sha256
            && self.recovery_ref == metadata.recovery_ref
            && self.verified_at <= now
            && self.valid_until > now
            && !self.verifier_version.is_empty()
            && !self.provenance_ref.is_empty()
            && !self.readability_ref.is_empty()
            && !self.durability_ref.is_empty()
    }
}

/// External qualification, not a deduction from two reseller names or receipts.
/// Only the trusted worker port accepts it. Fixture values prove no real-world
/// backbone independence. A durable adapter must authenticate the attribution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndependenceEvidence {
    pub backbones: [BackboneId; 2],
    pub assessor_ref: String,
    pub decision_ref: String,
    pub valid_until: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mutation {
    BeginUpload {
        name: String,
        expected_revision: u64,
        generation: GenerationId,
        metadata: CiphertextMetadata,
        archive_deadline: u64,
    },
    CommitUpload {
        intent: OperationId,
        copy: CompleteCopy,
    },
    AbortUpload {
        intent: OperationId,
    },
    Link {
        source: String,
        destination: String,
        expected_revision: u64,
    },
    Tombstone {
        name: String,
        expected_revision: u64,
    },
    RequestRestore {
        name: String,
        expected_revision: u64,
        profile: String,
        deadline: u64,
        availability_for: u64,
    },
    /// Same durable job path, with a persisted calendar period starting only at
    /// verified publication. Does not change generic RequestRestore semantics.
    RequestArchiveRestore {
        name: String,
        expected_revision: u64,
        deadline: u64,
        days: u32,
    },
    RenewArchiveAvailability {
        name: String,
        expected_revision: u64,
        days: u32,
        reservation: CapacityReservation,
    },
    CancelSubscription {
        name: String,
        job: JobId,
        /// Operation identity of the accepted RequestRestore, not this cancellation.
        subscription: OperationId,
    },
    AcquireServingPin {
        name: String,
        until: u64,
    },
    ReleasePin {
        pin: PinId,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    UploadIntent(OperationId),
    Committed {
        generation: GenerationId,
        revision: u64,
        archive: JobId,
    },
    Reference {
        generation: GenerationId,
        revision: u64,
    },
    Restore(JobId),
    Pin(PinId),
    Applied,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// Includes unauthorized and missing references: no existence oracle.
    Unavailable,
    Conflict,
    IncompleteCopy,
    Invalid,
    Fenced,
    Expired,
    Unsafe,
    /// Durable adapters must not equate uncertain commit with absence.
    Uncertain,
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceView {
    pub generation: GenerationId,
    pub revision: u64,
    pub metadata: CiphertextMetadata,
    pub availability_until: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reconciliation {
    Absent,
    Applied(Outcome),
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobKind {
    Archive,
    Restore,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    RetryWait { not_before: u64 },
    Complete,
    Cancelled,
    FailedUnrecoverable,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobView {
    pub id: JobId,
    pub generation: GenerationId,
    pub kind: JobKind,
    /// Restore settings, absent for archival work. Also present in RunJob events.
    pub profile: Option<String>,
    pub state: JobState,
    pub checkpoint: u64,
    /// Opaque manifest/article/repair inventory reference, not engine internals.
    pub checkpoint_ref: Option<String>,
    pub deadline: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fence {
    pub job: JobId,
    pub token: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeletionKind {
    DeliveryCache,
    UnreferencedGeneration,
}

/// Minted at candidate time; cannot be constructed from unchecked public fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletionCandidate {
    tenant: TenantId,
    generation: GenerationId,
    revision: u64,
    not_before: u64,
    kind: DeletionKind,
}

/// Worker-only generation inputs; not subject to logical-reference visibility.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationView {
    pub metadata: CiphertextMetadata,
    pub cache_location: Option<String>,
    /// Immutable record pinned by backend-specific qualification, including when
    /// its assessment expires. Expiry never permits a different version/backend.
    #[cfg(feature = "archive-provider")]
    pub qualified_s3_record: Option<velmora::archive::v1::ObjectRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeletionTarget {
    StorageVersion(String),
    /// Retire catalogue metadata without issuing a storage request.
    MetadataOnly,
}

/// Dispatch authorization is bounded by the earliest verification expiry.
/// A worker must not start storage I/O at or after valid_until.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletionDispatch {
    pub event: EventId,
    pub generation: GenerationId,
    pub kind: DeletionKind,
    pub target: DeletionTarget,
    pub valid_until: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    RunJob(JobView),
    /// Queue notification only: dispatch_deletion must authorize execution.
    Delete {
        generation: GenerationId,
        kind: DeletionKind,
        target: DeletionTarget,
    },
}

/// Stable identity for reconciliation, not a claim of remote exactly-once I/O.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxEvent {
    pub id: EventId,
    pub effect: Effect,
}

/// One serializable metadata/outbox boundary. An error must leave no partial
/// mutation, except `Uncertain`, which must be reconciled before further effects.
/// Authenticated tenant identity must come from the adapter, not request payload.
pub trait MetadataOutbox {
    fn transact(
        &mut self,
        tenant: TenantId,
        operation: OperationId,
        mutation: Mutation,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Outcome>;
    fn lookup(
        &self,
        tenant: TenantId,
        name: &str,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<ReferenceView>;
    fn reconcile(
        &self,
        tenant: TenantId,
        operation: OperationId,
        authority: &dyn Authority,
    ) -> Result<Reconciliation>;
    fn validate_pin(
        &self,
        tenant: TenantId,
        pin: PinId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<GenerationId>;
}

/// Minimal live-object evidence for write predicates, not read-protected metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteTarget {
    pub validator: String,
}

/// Write-authorized revision inspection, including absent and tombstoned keys.
/// This is not a read/list grant. Adapters must not turn denied/masked objects
/// into absence; implementations return an error for prohibited generations.
pub trait MutationTargets: MetadataOutbox {
    fn write_target(
        &self,
        tenant: TenantId,
        name: &str,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<(u64, Option<WriteTarget>)>;
}

/// Trusted infrastructure port, separate from end-user mutations. Every method
/// is atomic with its emitted outbox records. No external side effect runs here.
pub trait JobPort {
    fn outbox(&self, tenant: TenantId) -> Vec<OutboxEvent>;
    /// Read exactly one notification without materializing the tenant backlog.
    fn outbox_event(&self, tenant: TenantId, event: EventId) -> Result<OutboxEvent>;
    fn job(&self, tenant: TenantId, job: JobId) -> Result<JobView>;
    fn generation(&self, tenant: TenantId, generation: GenerationId) -> Result<GenerationView>;
    /// Retire an expired or superseded intent, without deleting staged bytes.
    fn retire_upload_intent(
        &mut self,
        tenant: TenantId,
        intent: OperationId,
        now: u64,
    ) -> Result<()>;
    fn claim(&mut self, tenant: TenantId, job: JobId, now: u64, until: u64) -> Result<Fence>;
    fn expire_job(&mut self, tenant: TenantId, job: JobId, now: u64) -> Result<()>;
    /// Atomically cancel an unneeded restore without acquiring publication rights.
    /// Reject a live claim or any currently authorized, matching subscriber;
    /// advance its fence and remove its notification, without adopting a new epoch.
    fn cancel_unneeded_restore(
        &mut self,
        tenant: TenantId,
        job: JobId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()>;
    fn transition(
        &mut self,
        tenant: TenantId,
        fence: Fence,
        transition: Transition,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()>;
    /// Exact, still-valid evidence + independence replay is a no-op. A replay
    /// must not extend validity, replace attribution or hide conflicting content.
    fn record_verification(
        &mut self,
        tenant: TenantId,
        evidence: VerificationEvidence,
        independence: IndependenceEvidence,
        now: u64,
    ) -> Result<()>;
    /// Exact replay is a no-op; refreshed evidence cannot replace immutable
    /// routing/version/encryption identity or coexist with NNTP qualification.
    #[cfg(feature = "archive-provider")]
    fn record_s3_verification(
        &mut self,
        _tenant: TenantId,
        _generation: GenerationId,
        _evidence: S3VerificationEvidence,
        _now: u64,
    ) -> Result<()> {
        Err(Error::Unsafe)
    }
    fn set_safety_hold(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        hold: bool,
    ) -> Result<()>;
    fn set_moderation(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        epoch: u64,
        prohibited: bool,
    ) -> Result<()>;
    fn candidate(
        &self,
        tenant: TenantId,
        generation: GenerationId,
        kind: DeletionKind,
        now: u64,
        not_before: u64,
        authority: &dyn Authority,
    ) -> Result<DeletionCandidate>;
    fn finalize_deletion(
        &mut self,
        candidate: DeletionCandidate,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<EventId>;
    /// Recheck current obligations before issuing any storage request. Repeated
    /// dispatch is fenced; uncertain remote outcomes require reconciliation.
    fn dispatch_deletion(
        &mut self,
        tenant: TenantId,
        event: EventId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<DeletionDispatch>;
    /// Withdraw only a queued effect that has never been dispatched.
    fn cancel_deletion(&mut self, tenant: TenantId, event: EventId) -> Result<()>;
    /// After dispatch expiry, recover only with trusted evidence that no remote
    /// request remains in flight, no effect occurred, and the same copy survives.
    /// settlement_ref identifies the worker/storage reconciliation record.
    fn reconcile_retained_deletion(
        &mut self,
        tenant: TenantId,
        event: EventId,
        retained: CompleteCopy,
        settlement_ref: String,
        now: u64,
    ) -> Result<()>;
    /// Only after confirmed storage completion (or metadata-only dispatch).
    fn acknowledge_deletion(&mut self, tenant: TenantId, event: EventId) -> Result<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transition {
    /// Read-only revalidation under the current claim, moderation epoch and
    /// authority. A restore must still have a matching authorized subscriber.
    /// This grants no publication rights and does not consume a checkpoint.
    Revalidate,
    Checkpoint {
        expected: u64,
        next: u64,
        inventory_ref: String,
    },
    Retry {
        not_before: u64,
    },
    CompleteArchive,
    PublishRestore {
        copy: CompleteCopy,
    },
    FailUnrecoverable,
    CancelIfUnneeded,
}
