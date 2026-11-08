//! Bounded product orchestration over the catalogue and trusted storage ports.
//!
//! No executor, queue, engine mechanism, database or serving transport lives here.
//! See `CONTRACT.md` for port trust, recovery and qualification boundaries.

use crate::catalogue::*;

/// Future authorized-window envelope; this schema grants no probe permission.
pub const EVIDENCE_SCHEMA: &str = include_str!("evidence.schema.json");

/// Explicit invocation limits, not advertised product or Workers limits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    max_bytes: u64,
    max_units: u32,
    max_attempts: u64,
    claim_for: u64,
}

impl Budget {
    pub fn new(max_bytes: u64, max_units: u32, max_attempts: u64, claim_for: u64) -> Result<Self> {
        if max_bytes == 0 || max_units == 0 || max_attempts == 0 || claim_for == 0 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            max_bytes,
            max_units,
            max_attempts,
            claim_for,
        })
    }

    pub fn max_bytes(&self) -> u64 {
        self.max_bytes
    }
    pub fn max_units(&self) -> u32 {
        self.max_units
    }
}

/// A trusted clock must fail closed on rollback or uncertainty.
pub trait Clock {
    fn now(&self) -> Result<u64>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upload {
    pub tenant: TenantId,
    pub intent: OperationId,
    pub commit: OperationId,
    pub name: String,
    pub expected_revision: u64,
    pub generation: GenerationId,
    pub metadata: CiphertextMetadata,
    pub archive_deadline: u64,
}

/// Stable scoped identities survive at-least-once notification and worker loss.
/// The checkpoint reference names a recoverable inventory, not a second queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Work {
    pub tenant: TenantId,
    pub event: EventId,
    pub job: JobView,
    pub metadata: CiphertextMetadata,
    pub retained_location: Option<String>,
    pub inventory_ref: String,
    pub attempt: u64,
    pub claim_until: u64,
    pub budget: Budget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IoError {
    Retryable,
    Integrity,
    RepairUnavailable,
    Cancelled,
    /// An issued remote effect may have completed. Never delete or guess absence.
    Uncertain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    Catalogue(Error),
    Io(IoError),
    Admission,
    Cleanup,
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self::Catalogue(error)
    }
}

pub type RunResult<T> = std::result::Result<T, Failure>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reconstruction {
    pub backbone: BackboneId,
    pub identity: CiphertextIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Qualification {
    pub independence: IndependenceEvidence,
    pub verification: [VerificationEvidence; 2],
}

/// Current infrastructure admission, cancellation, retry and cleanup decisions.
/// Account-wide reservations are the adapter's responsibility, not this value's.
pub trait Policy {
    fn admit_upload(&self, upload: &Upload, budget: &Budget, now: u64) -> bool;
    fn admit_work(&self, work: &Work, now: u64) -> bool;
    fn cancelled(&self, work: &Work) -> bool;
    fn retry_at(&self, work: &Work, error: &IoError, now: u64) -> Option<u64>;
    /// Only incomplete attempt-local allocations may be abandoned. Completed,
    /// committed and uncertain copies always require separate reconciliation.
    fn cleanup_incomplete(&self, work: &Work, error: &IoError) -> bool;
}

/// Trusted physical I/O ports, normally implemented by several collaborating
/// adapters. Every method is bounded by Work's bytes/units/claim/deadline and
/// must propagate cancellation and timeouts inside engine calls, not just after.
///
/// `inventory_ref` must persist stable article IDs, remote request identities and
/// immutable staged/completed versions BEFORE acknowledging their effects. A
/// repeated call reconciles that inventory; it never allocates an unrelated copy.
/// `complete_restore` verifies *all* staged C against N/SHA-256 and supported
/// checksums, completes the cache object, then returns a trusted receipt. It does
/// not make bytes accessible to users. No method delivers from NNTP to a user.
#[allow(async_fn_in_trait)]
pub trait Storage {
    async fn stage_upload(
        &mut self,
        upload: &Upload,
        budget: &Budget,
        // Absolute invocation deadline, bounded by the upload archive deadline.
        until: u64,
    ) -> std::result::Result<CompleteCopy, IoError>;
    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError>;
    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError>;
    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError>;
    async fn complete_restore(&mut self, work: &Work)
        -> std::result::Result<CompleteCopy, IoError>;
    /// Verify the exact immutable completed winner, under the remaining Work
    /// budget/deadline. Do not alias or delete the losing completed allocation;
    /// record it in the stable inventory for separate orphan reconciliation.
    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError>;
    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError>;
}

/// Separate authenticated readability and external independence assessor. This
/// cannot manufacture independence from the two reconstruction labels. Synthetic
/// assessors qualify software only, never provider independence or encryption.
pub trait Qualifier {
    fn qualify(
        &self,
        work: &Work,
        retrieved: &[Reconstruction; 2],
        now: u64,
    ) -> Result<Qualification>;
}

fn complete(metadata: &CiphertextMetadata, copy: &CompleteCopy) -> Result<()> {
    if metadata.identity != copy.identity
        || metadata.checksums != copy.checksums
        || copy.location.is_empty()
        || copy.receipt.is_empty()
    {
        return Err(Error::IncompleteCopy);
    }
    Ok(())
}

/// Stage -> complete-copy verification -> atomic reference/job/outbox commit.
/// Errors never grant a lease. In particular Uncertain leaves safety bytes intact
/// and requires reconcile with these same operation IDs before any cleanup.
pub async fn ingest<C: MetadataOutbox, S: Storage>(
    catalogue: &mut C,
    storage: &mut S,
    upload: &Upload,
    budget: &Budget,
    clock: &impl Clock,
    policy: &impl Policy,
    authority: &dyn Authority,
) -> RunResult<Outcome> {
    let now = clock.now()?;
    if !authority.is_current()
        || upload.metadata.identity.length > budget.max_bytes
        || upload.archive_deadline <= now
        || !policy.admit_upload(upload, budget, now)
    {
        return Err(Failure::Admission);
    }
    let until = now
        .checked_add(budget.claim_for)
        .ok_or(Error::Invalid)?
        .min(upload.archive_deadline);
    catalogue.transact(
        upload.tenant,
        upload.intent,
        Mutation::BeginUpload {
            name: upload.name.clone(),
            expected_revision: upload.expected_revision,
            generation: upload.generation,
            metadata: upload.metadata.clone(),
            archive_deadline: upload.archive_deadline,
        },
        now,
        authority,
    )?;
    let copy = storage
        .stage_upload(upload, budget, until)
        .await
        .map_err(Failure::Io)?;
    complete(&upload.metadata, &copy)?;
    let now = clock.now()?;
    if now >= until || !policy.admit_upload(upload, budget, now) {
        return Err(Failure::Admission);
    }
    Ok(catalogue.transact(
        upload.tenant,
        upload.commit,
        Mutation::CommitUpload {
            intent: upload.intent,
            copy,
        },
        now,
        authority,
    )?)
}

/// One bounded attempt from an existing committed outbox notification. The
/// catalogue alone owns jobs, subscriptions, fences, retries and publication.
/// Cancellation and revocation at the final transition cannot be bypassed by a
/// completed physical cache. No background task is spawned by this function.
#[allow(clippy::too_many_arguments)]
pub async fn run_once<C: JobPort, S: Storage>(
    catalogue: &mut C,
    storage: &mut S,
    tenant: TenantId,
    event: EventId,
    budget: &Budget,
    clock: &impl Clock,
    policy: &impl Policy,
    qualifier: &impl Qualifier,
    authority: &dyn Authority,
) -> RunResult<()> {
    let notification = catalogue.outbox_event(tenant, event)?;
    let Effect::RunJob(notification) = notification.effect else {
        return Err(Error::Invalid.into());
    };
    let job = catalogue.job(tenant, notification.id)?;
    let now = clock.now()?;
    if now >= job.deadline {
        catalogue.expire_job(tenant, job.id, now)?;
        return Err(Error::Expired.into());
    }
    if job.checkpoint >= budget.max_attempts {
        return Err(Failure::Admission);
    }
    let generation = catalogue.generation(tenant, job.generation)?;
    let claim_until = now
        .checked_add(budget.claim_for)
        .ok_or(Error::Invalid)?
        .min(job.deadline);
    let work = Work {
        tenant,
        event,
        attempt: job.checkpoint + 1,
        inventory_ref: job.checkpoint_ref.clone().unwrap_or_else(|| {
            format!(
                "composition-v1/{}/{}/{}",
                tenant.0, job.generation.0, job.id.0
            )
        }),
        job,
        metadata: generation.metadata,
        retained_location: generation.cache_location,
        claim_until,
        budget: budget.clone(),
    };
    if !authority.is_current()
        || work.metadata.identity.length > budget.max_bytes
        || !policy.admit_work(&work, now)
    {
        return Err(Failure::Admission);
    }
    if policy.cancelled(&work) {
        if work.job.kind == JobKind::Restore {
            match catalogue.cancel_unneeded_restore(tenant, work.job.id, now, authority) {
                Ok(()) | Err(Error::Unsafe) => {}
                Err(error) => return Err(error.into()),
            }
        }
        // Invocation interruption is not cancellation of a logical obligation.
        // A needed restore or archive stays queued without consuming an attempt.
        return Err(Failure::Io(IoError::Cancelled));
    }
    let fence = catalogue.claim(tenant, work.job.id, now, claim_until)?;
    // Reserve the attempt in the authoritative checkpoint BEFORE external I/O.
    // A crash consumes this attempt, rather than resetting a retry budget.
    catalogue.transition(
        tenant,
        fence.clone(),
        Transition::Checkpoint {
            expected: work.job.checkpoint,
            next: work.attempt,
            inventory_ref: work.inventory_ref.clone(),
        },
        now,
        authority,
    )?;
    let result = execute(
        catalogue, storage, &work, &fence, clock, policy, qualifier, authority,
    )
    .await;
    if let Err(Failure::Io(error)) = &result {
        let now = clock.now()?;
        // Uncertain effects retain their inventory and bytes; the next bounded
        // attempt must reconcile, not mistake a timeout for absence.
        if !matches!(error, IoError::Uncertain)
            && policy.cleanup_incomplete(&work, error)
            && storage.cleanup_incomplete(&work).await.is_err()
        {
            return Err(Failure::Cleanup);
        }
        let now = clock.now()?.max(now);
        if now >= work.job.deadline {
            catalogue.expire_job(tenant, work.job.id, now)?;
        } else if now < work.claim_until {
            if matches!(error, IoError::Cancelled) && work.job.kind == JobKind::Restore {
                match catalogue.transition(
                    tenant,
                    fence.clone(),
                    Transition::CancelIfUnneeded,
                    now,
                    authority,
                ) {
                    Ok(()) => return result,
                    Err(Error::Unsafe) => {} // A live subscriber still needs this job.
                    Err(error) => return Err(error.into()),
                }
            }
            let transition = if work.attempt < budget.max_attempts {
                match policy.retry_at(&work, error, now) {
                    Some(at) if at > now && at < work.job.deadline => {
                        Transition::Retry { not_before: at }
                    }
                    _ => Transition::FailUnrecoverable,
                }
            } else {
                Transition::FailUnrecoverable
            };
            catalogue.transition(tenant, fence, transition, now, authority)?;
        }
    }
    result
}

fn guard(work: &Work, clock: &impl Clock, policy: &impl Policy) -> RunResult<u64> {
    let now = clock.now()?;
    if now >= work.claim_until || now >= work.job.deadline {
        return Err(Error::Expired.into());
    }
    if !policy.admit_work(work, now) {
        return Err(Failure::Admission);
    }
    if policy.cancelled(work) {
        return Err(Failure::Io(IoError::Cancelled));
    }
    Ok(now)
}

#[allow(clippy::too_many_arguments)]
async fn execute<C: JobPort, S: Storage>(
    catalogue: &mut C,
    storage: &mut S,
    work: &Work,
    fence: &Fence,
    clock: &impl Clock,
    policy: &impl Policy,
    qualifier: &impl Qualifier,
    authority: &dyn Authority,
) -> RunResult<()> {
    guard(work, clock, policy)?;
    match work.job.kind {
        JobKind::Archive => {
            storage.post(work).await.map_err(Failure::Io)?;
            guard(work, clock, policy)?;
            let retrieved = storage.verify_archive(work).await.map_err(Failure::Io)?;
            let now = guard(work, clock, policy)?;
            if retrieved[0].backbone == retrieved[1].backbone
                || retrieved
                    .iter()
                    .any(|r| r.identity != work.metadata.identity)
            {
                return Err(Failure::Io(IoError::Integrity));
            }
            let qualification = qualifier.qualify(work, &retrieved, now)?;
            // Validate the entire pair before writing either half of its evidence.
            for (observed, proof) in retrieved.iter().zip(&qualification.verification) {
                if proof.generation != work.job.generation
                    || proof.backbone != observed.backbone
                    || proof.reconstructed != observed.identity
                    || proof.verified_at > now
                    || proof.valid_until <= now
                    || proof.verifier_version.is_empty()
                    || proof.provenance_ref.is_empty()
                    || proof.readability_ref.is_empty()
                    || !qualification
                        .independence
                        .backbones
                        .contains(&observed.backbone)
                {
                    return Err(Error::Unsafe.into());
                }
            }
            if qualification.independence.backbones[0] == qualification.independence.backbones[1]
                || qualification.independence.valid_until <= now
                || qualification.independence.assessor_ref.is_empty()
                || qualification.independence.decision_ref.is_empty()
            {
                return Err(Error::Unsafe.into());
            }
            // Persisting one half then losing the worker is safe: incomplete
            // qualification grants neither archive completion nor cache deletion.
            for proof in qualification.verification {
                catalogue.record_verification(
                    work.tenant,
                    proof,
                    qualification.independence.clone(),
                    now,
                )?;
            }
            catalogue.transition(
                work.tenant,
                fence.clone(),
                Transition::CompleteArchive,
                guard(work, clock, policy)?,
                authority,
            )?;
        }
        JobKind::Restore => {
            storage.retrieve(work).await.map_err(Failure::Io)?;
            guard(work, clock, policy)?;
            let copy = storage.complete_restore(work).await.map_err(Failure::Io)?;
            complete(&work.metadata, &copy)?;
            let result = catalogue.transition(
                work.tenant,
                fence.clone(),
                Transition::PublishRestore { copy: copy.clone() },
                guard(work, clock, policy)?,
                authority,
            );
            if result == Err(Error::Conflict) {
                // Another viable job may have installed its immutable version
                // after this attempt's snapshot. Reconcile once, not a retry loop.
                let winner = catalogue
                    .generation(work.tenant, work.job.generation)?
                    .cache_location
                    .ok_or(Error::Conflict)?;
                if winner == copy.location {
                    return Err(Error::Conflict.into());
                }
                guard(work, clock, policy)?;
                let receipt = storage
                    .verify_completed(work, &winner)
                    .await
                    .map_err(Failure::Io)?;
                complete(&work.metadata, &receipt)?;
                if receipt.location != winner {
                    return Err(Error::IncompleteCopy.into());
                }
                catalogue.transition(
                    work.tenant,
                    fence.clone(),
                    Transition::PublishRestore { copy: receipt },
                    guard(work, clock, policy)?,
                    authority,
                )?;
            } else {
                result?;
            }
        }
    }
    Ok(())
}
