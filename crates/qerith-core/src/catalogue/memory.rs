use super::*;
use std::collections::{BTreeMap, BTreeSet};

type OperationRecord = (Mutation, Outcome, Vec<(String, Action)>);

#[derive(Clone, Default)]
struct Tenant {
    references: BTreeMap<String, LogicalReference>,
    generations: BTreeMap<GenerationId, Generation>,
    reserved: BTreeSet<GenerationId>,
    locations: BTreeSet<String>,
    intents: BTreeMap<OperationId, Intent>,
    operations: BTreeMap<OperationId, OperationRecord>,
    jobs: BTreeMap<JobId, Job>,
    pins: BTreeMap<PinId, Pin>,
    events: BTreeMap<EventId, OutboxEvent>,
    sequence: u64,
}

#[derive(Clone, Default)]
struct LogicalReference {
    revision: u64,
    generation: Option<GenerationId>,
    availability: Option<u64>,
}

#[derive(Clone)]
struct Generation {
    metadata: CiphertextMetadata,
    cache: Option<String>,
    archived: bool,
    safety_hold: bool,
    prohibited: bool,
    moderation_epoch: u64,
    revision: u64,
    deleting: Option<(EventId, DeletionKind)>,
    deletion_dispatched: bool,
    dispatch_valid_until: u64,
    verification: BTreeMap<BackboneId, VerificationEvidence>,
    independence: Option<IndependenceEvidence>,
    #[cfg(feature = "archive-provider")]
    s3_verification: Option<S3VerificationEvidence>,
}

#[derive(Clone)]
struct Intent {
    name: String,
    expected_revision: u64,
    generation: GenerationId,
    metadata: CiphertextMetadata,
    archive_deadline: u64,
    pending: bool,
}

#[derive(Clone)]
struct Subscriber {
    operation: OperationId,
    revision: u64,
    availability_for: u64,
    archive_days: Option<u32>,
}

#[derive(Clone)]
struct Job {
    view: JobView,
    subscribers: BTreeMap<String, Subscriber>,
    published: BTreeSet<(String, OperationId)>,
    fence: u64,
    claimed_until: u64,
    moderation_epoch: u64,
    event: EventId,
}

#[derive(Clone)]
struct Pin {
    name: String,
    revision: u64,
    generation: GenerationId,
    moderation_epoch: u64,
    until: u64,
}

/// Deliberately non-durable, single-process reference implementation. Cloning is
/// used for atomic rollback, not for backup/restart or production scalability.
#[derive(Clone, Default)]
pub struct MemoryCatalogue {
    tenants: BTreeMap<TenantId, Tenant>,
    buckets: BTreeMap<String, (TenantId, BucketView)>,
    bucket_sequence: u64,
}

fn permit(authority: &dyn Authority, tenant: TenantId, name: &str, action: Action) -> Result<()> {
    if !authority.is_current()
        || !authority.permits(
            &Reference {
                tenant,
                name: name.into(),
            },
            action,
        )
    {
        return Err(Error::Unavailable);
    }
    Ok(())
}

fn next(value: u64) -> Result<u64> {
    value.checked_add(1).ok_or(Error::Invalid)
}

fn terminal(state: &JobState) -> bool {
    matches!(
        state,
        JobState::Complete
            | JobState::Cancelled
            | JobState::FailedUnrecoverable
            | JobState::Expired
    )
}

impl Tenant {
    fn allocate(&mut self) -> Result<u64> {
        self.sequence = next(self.sequence)?;
        Ok(self.sequence)
    }

    fn current_revision(&self, name: &str) -> u64 {
        self.references.get(name).map_or(0, |r| r.revision)
    }

    fn metadata(&self, name: &str) -> Result<(&LogicalReference, &Generation)> {
        let r = self.references.get(name).ok_or(Error::Unavailable)?;
        let g = self
            .generations
            .get(&r.generation.ok_or(Error::Unavailable)?)
            .ok_or(Error::Unavailable)?;
        if g.prohibited {
            return Err(Error::Unavailable);
        }
        Ok((r, g))
    }

    fn visible(&self, name: &str) -> Result<(&LogicalReference, &Generation)> {
        let (r, g) = self.metadata(name)?;
        if g.deleting.is_some() {
            return Err(Error::Unavailable);
        }
        Ok((r, g))
    }

    fn touch(&mut self, generation: GenerationId) -> Result<()> {
        let g = self
            .generations
            .get_mut(&generation)
            .ok_or(Error::Unavailable)?;
        g.revision = next(g.revision)?;
        Ok(())
    }

    fn authorize_mutation(
        &self,
        tenant: TenantId,
        mutation: &Mutation,
        authority: &dyn Authority,
    ) -> Result<Vec<(String, Action)>> {
        let names = match mutation {
            Mutation::BeginUpload { name, .. } | Mutation::Tombstone { name, .. } => {
                vec![(name.clone(), Action::Write)]
            }
            Mutation::CommitUpload { intent, .. } | Mutation::AbortUpload { intent } => {
                let i = self.intents.get(intent).ok_or(Error::Unavailable)?;
                vec![(i.name.clone(), Action::Write)]
            }
            Mutation::Link {
                source,
                destination,
                ..
            } => vec![
                (source.clone(), Action::Read),
                (destination.clone(), Action::Write),
            ],
            Mutation::RequestRestore { name, .. }
            | Mutation::RequestArchiveRestore { name, .. }
            | Mutation::RenewArchiveAvailability { name, .. }
            | Mutation::CancelSubscription { name, .. } => {
                vec![(name.clone(), Action::Restore)]
            }
            Mutation::AcquireServingPin { name, .. } => vec![(name.clone(), Action::Read)],
            Mutation::ReleasePin { pin } => {
                let p = self.pins.get(pin).ok_or(Error::Unavailable)?;
                vec![(p.name.clone(), Action::Read)]
            }
        };
        for (name, action) in &names {
            permit(authority, tenant, name, *action)?;
        }
        Ok(names)
    }

    fn new_job(
        &mut self,
        generation: GenerationId,
        kind: JobKind,
        profile: Option<String>,
        deadline: u64,
    ) -> Result<JobId> {
        let id = JobId(self.allocate()?);
        let event = EventId(self.allocate()?);
        let view = JobView {
            id,
            generation,
            kind,
            profile,
            state: JobState::Queued,
            checkpoint: 0,
            checkpoint_ref: None,
            deadline,
        };
        self.events.insert(
            event,
            OutboxEvent {
                id: event,
                effect: Effect::RunJob(view.clone()),
            },
        );
        let moderation_epoch = self
            .generations
            .get(&generation)
            .ok_or(Error::Unavailable)?
            .moderation_epoch;
        self.jobs.insert(
            id,
            Job {
                view,
                subscribers: BTreeMap::new(),
                published: BTreeSet::new(),
                fence: 0,
                claimed_until: 0,
                moderation_epoch,
                event,
            },
        );
        Ok(id)
    }

    fn mutate(&mut self, operation: OperationId, mutation: Mutation, now: u64) -> Result<Outcome> {
        match mutation {
            Mutation::BeginUpload {
                name,
                expected_revision,
                generation,
                metadata,
                archive_deadline,
            } => {
                if name.is_empty()
                    || metadata.validator.is_empty()
                    || metadata.recovery_ref.is_empty()
                    || archive_deadline <= now
                {
                    return Err(Error::Invalid);
                }
                if self.current_revision(&name) != expected_revision
                    || !self.reserved.insert(generation)
                {
                    return Err(Error::Conflict);
                }
                self.intents.insert(
                    operation,
                    Intent {
                        name,
                        expected_revision,
                        generation,
                        metadata,
                        archive_deadline,
                        pending: true,
                    },
                );
                Ok(Outcome::UploadIntent(operation))
            }
            Mutation::CommitUpload { intent, copy } => {
                let i = self.intents.get(&intent).ok_or(Error::Unavailable)?.clone();
                if !i.pending || self.current_revision(&i.name) != i.expected_revision {
                    return Err(Error::Conflict);
                }
                if i.archive_deadline <= now {
                    return Err(Error::Expired);
                }
                complete_copy(&i.metadata, &copy)?;
                if !self.locations.insert(copy.location.clone())
                    || self
                        .generations
                        .values()
                        .any(|g| g.metadata.validator == i.metadata.validator)
                {
                    return Err(Error::Conflict);
                }
                let revision = next(i.expected_revision)?;
                if let Some(old) = self.references.get(&i.name).and_then(|r| r.generation) {
                    self.touch(old)?;
                }
                self.generations.insert(
                    i.generation,
                    Generation {
                        metadata: i.metadata,
                        cache: Some(copy.location),
                        archived: false,
                        safety_hold: false,
                        prohibited: false,
                        moderation_epoch: 0,
                        revision: 1,
                        deleting: None,
                        deletion_dispatched: false,
                        dispatch_valid_until: 0,
                        verification: BTreeMap::new(),
                        independence: None,
                        #[cfg(feature = "archive-provider")]
                        s3_verification: None,
                    },
                );
                self.references.insert(
                    i.name,
                    LogicalReference {
                        revision,
                        generation: Some(i.generation),
                        availability: None,
                    },
                );
                self.intents
                    .get_mut(&intent)
                    .ok_or(Error::Unavailable)?
                    .pending = false;
                let archive =
                    self.new_job(i.generation, JobKind::Archive, None, i.archive_deadline)?;
                Ok(Outcome::Committed {
                    generation: i.generation,
                    revision,
                    archive,
                })
            }
            Mutation::AbortUpload { intent } => {
                let i = self.intents.get_mut(&intent).ok_or(Error::Unavailable)?;
                if !i.pending {
                    return Err(Error::Conflict);
                }
                i.pending = false;
                Ok(Outcome::Applied)
            }
            Mutation::Link {
                source,
                destination,
                expected_revision,
            } => {
                let (r, _) = self.visible(&source)?;
                let generation = r.generation.ok_or(Error::Unavailable)?;
                if self.current_revision(&destination) != expected_revision {
                    return Err(Error::Conflict);
                }
                if let Some(old) = self.references.get(&destination).and_then(|r| r.generation) {
                    self.touch(old)?;
                }
                let revision = next(expected_revision)?;
                self.references.insert(
                    destination,
                    LogicalReference {
                        revision,
                        generation: Some(generation),
                        availability: None,
                    },
                );
                self.touch(generation)?;
                Ok(Outcome::Reference {
                    generation,
                    revision,
                })
            }
            Mutation::Tombstone {
                name,
                expected_revision,
            } => {
                if self.current_revision(&name) != expected_revision {
                    return Err(Error::Conflict);
                }
                let revision = next(expected_revision)?;
                if let Some(old) = self.references.get(&name).and_then(|r| r.generation) {
                    self.touch(old)?;
                }
                self.references.insert(
                    name,
                    LogicalReference {
                        revision,
                        generation: None,
                        availability: None,
                    },
                );
                Ok(Outcome::Applied)
            }
            Mutation::RequestRestore {
                name,
                expected_revision,
                profile,
                deadline,
                availability_for,
            } => {
                let (r, g) = self.visible(&name)?;
                let moderation_epoch = g.moderation_epoch;
                if r.revision != expected_revision {
                    return Err(Error::Conflict);
                }
                let generation = r.generation.ok_or(Error::Unavailable)?;
                if deadline <= now
                    || availability_for == 0
                    || deadline.checked_add(availability_for).is_none()
                {
                    return Err(Error::Invalid);
                }
                let existing = self
                    .jobs
                    .iter()
                    .find(|(_, j)| {
                        j.view.generation == generation
                            && j.view.kind == JobKind::Restore
                            && j.moderation_epoch == moderation_epoch
                            && j.view.profile.as_ref() == Some(&profile)
                            && !terminal(&j.view.state)
                            && j.view.deadline == deadline
                            && j.view.deadline > now
                    })
                    .map(|(id, _)| *id);
                let id = match existing {
                    Some(id) => id,
                    None => self.new_job(generation, JobKind::Restore, Some(profile), deadline)?,
                };
                let j = self.jobs.get_mut(&id).ok_or(Error::Unavailable)?;
                if j.subscribers
                    .get(&name)
                    .is_some_and(|s| s.revision == expected_revision)
                {
                    return Err(Error::Conflict);
                }
                j.subscribers.insert(
                    name,
                    Subscriber {
                        operation,
                        revision: expected_revision,
                        availability_for,
                        archive_days: None,
                    },
                );
                self.touch(generation)?;
                Ok(Outcome::Restore(id))
            }
            Mutation::RequestArchiveRestore {
                name,
                expected_revision,
                deadline,
                days,
            } => {
                archive_expiry(deadline, days)?;
                let (reference, generation_view) = self.visible(&name)?;
                let generation = reference.generation.ok_or(Error::Unavailable)?;
                let moderation_epoch = generation_view.moderation_epoch;
                // A duplicate on the same logical revision remains pending even
                // when a retry proposes a different deadline or Days value.
                if self.jobs.values().any(|j| {
                    j.view.generation == generation
                        && j.moderation_epoch == moderation_epoch
                        && j.view.kind == JobKind::Restore
                        && !terminal(&j.view.state)
                        && j.view.deadline > now
                        && j.subscribers
                            .get(&name)
                            .is_some_and(|s| s.revision == expected_revision)
                }) {
                    return Err(Error::Conflict);
                }
                let outcome = self.mutate(
                    operation,
                    Mutation::RequestRestore {
                        name: name.clone(),
                        expected_revision,
                        profile: "s3-standard-calendar".into(),
                        deadline,
                        availability_for: u64::from(days) * 86400,
                    },
                    now,
                )?;
                let Outcome::Restore(id) = outcome else {
                    return Err(Error::Invalid);
                };
                self.jobs
                    .get_mut(&id)
                    .ok_or(Error::Unavailable)?
                    .subscribers
                    .get_mut(&name)
                    .ok_or(Error::Unavailable)?
                    .archive_days = Some(days);
                Ok(outcome)
            }
            Mutation::RenewArchiveAvailability {
                name,
                expected_revision,
                days,
                reservation,
            } => {
                let (r, g) = self.visible(&name)?;
                let old = r.availability.filter(|t| *t > now).ok_or(Error::Expired)?;
                let until = archive_expiry(now, days)?.max(old);
                let generation = r.generation.ok_or(Error::Unavailable)?;
                if r.revision != expected_revision || reservation.generation != generation {
                    return Err(Error::Conflict);
                }
                if g.cache.is_none() || reservation.until < until || reservation.receipt.is_empty()
                {
                    return Err(Error::Unsafe);
                }
                self.references
                    .get_mut(&name)
                    .ok_or(Error::Unavailable)?
                    .availability = Some(until);
                self.touch(generation)?;
                Ok(Outcome::Applied)
            }
            Mutation::CancelSubscription {
                name,
                job,
                subscription,
            } => {
                let j = self.jobs.get_mut(&job).ok_or(Error::Unavailable)?;
                if j.view.kind != JobKind::Restore || terminal(&j.view.state) {
                    return Err(Error::Conflict);
                }
                let subscriber = j.subscribers.get(&name).ok_or(Error::Unavailable)?;
                if subscriber.operation != subscription {
                    return Err(Error::Conflict);
                }
                j.subscribers.remove(&name);
                let generation = j.view.generation;
                self.touch(generation)?;
                Ok(Outcome::Applied)
            }
            Mutation::AcquireServingPin { name, until } => {
                let (r, g) = self.visible(&name)?;
                let expiry = r
                    .availability
                    .filter(|expiry| *expiry > now)
                    .ok_or(Error::Unavailable)?;
                if g.cache.is_none() || until <= now || until > expiry {
                    return Err(Error::Unavailable);
                }
                let revision = r.revision;
                let generation = r.generation.ok_or(Error::Unavailable)?;
                let moderation_epoch = g.moderation_epoch;
                let pin = PinId(self.allocate()?);
                self.pins.insert(
                    pin,
                    Pin {
                        name,
                        revision,
                        generation,
                        moderation_epoch,
                        until,
                    },
                );
                self.touch(generation)?;
                Ok(Outcome::Pin(pin))
            }
            Mutation::ReleasePin { pin } => {
                let p = self.pins.remove(&pin).ok_or(Error::Unavailable)?;
                self.touch(p.generation)?;
                Ok(Outcome::Applied)
            }
        }
    }

    fn has_current_subscriber(
        &self,
        tenant: TenantId,
        job: &Job,
        authority: &dyn Authority,
    ) -> bool {
        job.subscribers.iter().any(|(name, s)| {
            self.references.get(name).is_some_and(|r| {
                r.revision == s.revision && r.generation == Some(job.view.generation)
            }) && permit(authority, tenant, name, Action::Restore).is_ok()
        })
    }

    fn archive_verified(&self, tenant: TenantId, generation: GenerationId, now: u64) -> bool {
        #[cfg(not(feature = "archive-provider"))]
        let _ = tenant;
        #[cfg(feature = "archive-provider")]
        if let Some(g) = self.generations.get(&generation) {
            if let Some(proof) = &g.s3_verification {
                return proof.valid(tenant, generation, &g.metadata, now);
            }
        }
        self.verified(generation, now)
    }

    fn verified(&self, generation: GenerationId, now: u64) -> bool {
        let Some(g) = self.generations.get(&generation) else {
            return false;
        };
        let Some(i) = &g.independence else {
            return false;
        };
        if i.valid_until <= now
            || i.backbones[0] == i.backbones[1]
            || i.assessor_ref.is_empty()
            || i.decision_ref.is_empty()
        {
            return false;
        }
        i.backbones.iter().all(|b| {
            g.verification.get(b).is_some_and(|v| {
                v.generation == generation
                    && v.reconstructed == g.metadata.identity
                    && v.verified_at <= now
                    && v.valid_until > now
                    && !v.readability_ref.is_empty()
                    && !v.verifier_version.is_empty()
                    && !v.provenance_ref.is_empty()
            })
        })
    }

    fn safe_to_delete(
        &self,
        tenant: TenantId,
        generation: GenerationId,
        kind: DeletionKind,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()> {
        let g = self
            .generations
            .get(&generation)
            .ok_or(Error::Unavailable)?;
        if !authority.is_current()
            || g.safety_hold
            || !g.archived
            || !self.verified(generation, now)
        {
            return Err(Error::Unsafe);
        }
        let refs: Vec<_> = self
            .references
            .iter()
            .filter(|(_, r)| r.generation == Some(generation))
            .collect();
        if refs.iter().any(|(name, r)| {
            permit(authority, tenant, name, Action::Read).is_err()
                || r.availability.is_some_and(|until| until > now)
        }) {
            return Err(Error::Unsafe);
        }
        if kind == DeletionKind::UnreferencedGeneration && !refs.is_empty() {
            return Err(Error::Unsafe);
        }
        if kind == DeletionKind::DeliveryCache && (g.cache.is_none() || g.prohibited) {
            return Err(Error::Unsafe);
        }
        if self.intents.values().any(|i| {
            i.pending
                && (i.generation == generation
                    || self
                        .references
                        .get(&i.name)
                        .is_some_and(|r| r.generation == Some(generation)))
        }) || self
            .jobs
            .values()
            .any(|j| j.view.generation == generation && !terminal(&j.view.state))
            || self
                .pins
                .values()
                .any(|p| p.generation == generation && p.until > now)
        {
            return Err(Error::Unsafe);
        }
        Ok(())
    }
}

fn complete_copy(metadata: &CiphertextMetadata, copy: &CompleteCopy) -> Result<()> {
    if metadata.identity != copy.identity
        || metadata.checksums != copy.checksums
        || copy.location.is_empty()
        || copy.receipt.is_empty()
    {
        return Err(Error::IncompleteCopy);
    }
    Ok(())
}

impl MetadataOutbox for MemoryCatalogue {
    fn transact(
        &mut self,
        tenant: TenantId,
        operation: OperationId,
        mutation: Mutation,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Outcome> {
        let mut staged = self.tenants.get(&tenant).cloned().unwrap_or_default();
        if let Some((old, result, names)) = staged.operations.get(&operation) {
            for (name, action) in names {
                permit(authority, tenant, name, *action)?;
            }
            if old != &mutation {
                return Err(Error::Conflict);
            }
            return Ok(result.clone());
        }
        let names = staged.authorize_mutation(tenant, &mutation, authority)?;
        if let Mutation::RenewArchiveAvailability {
            name, reservation, ..
        } = &mutation
        {
            if reservation.tenant != tenant
                || reservation.name != *name
                || reservation.operation != operation
            {
                return Err(Error::Unsafe);
            }
        }
        let result = staged.mutate(operation, mutation.clone(), now)?;
        staged
            .operations
            .insert(operation, (mutation, result.clone(), names));
        self.tenants.insert(tenant, staged);
        Ok(result)
    }

    fn lookup(
        &self,
        tenant: TenantId,
        name: &str,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<ReferenceView> {
        permit(authority, tenant, name, Action::Read)?;
        let t = self.tenants.get(&tenant).ok_or(Error::Unavailable)?;
        let (r, g) = t.metadata(name)?;
        Ok(ReferenceView {
            generation: r.generation.ok_or(Error::Unavailable)?,
            revision: r.revision,
            metadata: g.metadata.clone(),
            availability_until: r.availability.filter(|until| *until > now),
        })
    }

    fn reconcile(
        &self,
        tenant: TenantId,
        operation: OperationId,
        authority: &dyn Authority,
    ) -> Result<Reconciliation> {
        if !authority.is_current() {
            return Err(Error::Unavailable);
        }
        let Some(t) = self.tenants.get(&tenant) else {
            return Ok(Reconciliation::Absent);
        };
        let Some((_, outcome, names)) = t.operations.get(&operation) else {
            return Ok(Reconciliation::Absent);
        };
        for (name, action) in names {
            permit(authority, tenant, name, *action)?;
        }
        Ok(Reconciliation::Applied(outcome.clone()))
    }

    fn validate_pin(
        &self,
        tenant: TenantId,
        pin: PinId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<GenerationId> {
        let t = self.tenants.get(&tenant).ok_or(Error::Unavailable)?;
        let p = t.pins.get(&pin).ok_or(Error::Unavailable)?;
        permit(authority, tenant, &p.name, Action::Read)?;
        let (r, g) = t.visible(&p.name)?;
        if p.until <= now
            || p.moderation_epoch != g.moderation_epoch
            || r.revision != p.revision
            || r.generation != Some(p.generation)
            || g.cache.is_none()
        {
            return Err(Error::Unavailable);
        }
        Ok(p.generation)
    }
}

impl MutationTargets for MemoryCatalogue {
    fn write_target(
        &self,
        tenant: TenantId,
        name: &str,
        _now: u64,
        authority: &dyn Authority,
    ) -> Result<(u64, Option<WriteTarget>)> {
        permit(authority, tenant, name, Action::Write)?;
        let Some(t) = self.tenants.get(&tenant) else {
            return Ok((0, None));
        };
        let revision = t.current_revision(name);
        if t.references
            .get(name)
            .is_none_or(|r| r.generation.is_none())
        {
            return Ok((revision, None));
        }
        let (_, g) = t.visible(name)?;
        Ok((
            revision,
            Some(WriteTarget {
                validator: g.metadata.validator.clone(),
            }),
        ))
    }
}

impl MemoryCatalogue {
    /// Trusted reference-model projection of this exact subscription's publication.
    /// Shared physical completion alone says nothing about an excluded subscriber.
    pub fn restore_published(
        &self,
        tenant: TenantId,
        job: JobId,
        name: &str,
        subscription: OperationId,
    ) -> Result<bool> {
        let job = self
            .tenants
            .get(&tenant)
            .and_then(|tenant| tenant.jobs.get(&job))
            .ok_or(Error::Unavailable)?;
        Ok(job.published.contains(&(name.into(), subscription)))
    }

    /// Trusted fixture identity allocation, shared with all catalogue mutations.
    /// Monotonic above both replay records and reserved generations, including
    /// identities supplied by other adapters. Burned unused IDs are intentional;
    /// a durable adapter must provide its own transactional allocation contract.
    pub fn allocate_identity(&mut self, tenant: TenantId) -> Result<u64> {
        let t = self.tenants.entry(tenant).or_default();
        let operation = t.operations.last_key_value().map_or(0, |(id, _)| id.0);
        let generation = t.reserved.last().map_or(0, |id| id.0);
        let id = next(t.sequence.max(operation).max(generation))?;
        t.sequence = id;
        Ok(id)
    }

    fn atomic<T>(
        &mut self,
        tenant: TenantId,
        apply: impl FnOnce(&mut Tenant) -> Result<T>,
    ) -> Result<T> {
        let mut staged = self
            .tenants
            .get(&tenant)
            .cloned()
            .ok_or(Error::Unavailable)?;
        let result = apply(&mut staged)?;
        self.tenants.insert(tenant, staged);
        Ok(result)
    }
}

impl ArchiveReadPort for MemoryCatalogue {
    fn release_serving_pin(&mut self, tenant: TenantId, pin: PinId) -> Result<()> {
        self.atomic(tenant, |t| {
            let p = t.pins.remove(&pin).ok_or(Error::Unavailable)?;
            t.touch(p.generation)
        })
    }

    fn create_bucket(
        &mut self,
        tenant: TenantId,
        name: &str,
        region: &str,
        now: u64,
    ) -> std::result::Result<BucketView, BucketError> {
        if let Some((owner, _)) = self.buckets.get(name) {
            return Err(if *owner == tenant {
                BucketError::AlreadyOwned
            } else {
                BucketError::Unavailable
            });
        }
        self.bucket_sequence = self
            .bucket_sequence
            .checked_add(1)
            .ok_or(BucketError::Invalid)?;
        let view = BucketView {
            name: name.into(),
            region: region.into(),
            created_at: now,
            incarnation: self.bucket_sequence,
        };
        self.buckets.insert(name.into(), (tenant, view.clone()));
        Ok(view)
    }

    fn bucket(&self, tenant: TenantId, name: &str) -> std::result::Result<BucketView, BucketError> {
        self.buckets
            .get(name)
            .filter(|(owner, _)| *owner == tenant)
            .map(|(_, view)| view.clone())
            .ok_or(BucketError::Unavailable)
    }

    fn buckets(&self, tenant: TenantId) -> Vec<BucketView> {
        self.buckets
            .values()
            .filter(|(owner, _)| *owner == tenant)
            .map(|(_, view)| view.clone())
            .collect()
    }

    fn delete_bucket(
        &mut self,
        tenant: TenantId,
        name: &str,
    ) -> std::result::Result<(), BucketError> {
        self.bucket(tenant, name)?;
        let prefix = format!("{name}/");
        if self.tenants.get(&tenant).is_some_and(|t| {
            t.references
                .iter()
                .any(|(n, r)| n.starts_with(&prefix) && r.generation.is_some())
                || t.intents
                    .values()
                    .any(|i| i.pending && i.name.starts_with(&prefix))
        }) {
            return Err(BucketError::NotEmpty);
        }
        self.buckets.remove(name);
        Ok(())
    }

    fn list_references(
        &self,
        tenant: TenantId,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Vec<(String, ReferenceView)>> {
        if !authority.is_current() {
            return Err(Error::Unavailable);
        }
        let Some(t) = self.tenants.get(&tenant) else {
            return Ok(Vec::new());
        };
        let start = after.unwrap_or(prefix).max(prefix).to_owned();
        Ok(t.references
            .range(start..)
            .take_while(|(n, _)| n.starts_with(prefix))
            .filter(|(n, _)| after.is_none_or(|a| n.as_str() > a))
            .filter_map(|(n, _)| {
                self.lookup(tenant, n, now, authority)
                    .ok()
                    .map(|v| (n.clone(), v))
            })
            .take(limit)
            .collect())
    }

    fn archive_view(
        &self,
        tenant: TenantId,
        name: &str,
        action: Action,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<ArchiveView> {
        if !matches!(action, Action::Read | Action::Restore) {
            return Err(Error::Invalid);
        }
        permit(authority, tenant, name, action)?;
        let t = self.tenants.get(&tenant).ok_or(Error::Unavailable)?;
        let (r, g) = t.metadata(name)?;
        let reference = ReferenceView {
            generation: r.generation.ok_or(Error::Unavailable)?,
            revision: r.revision,
            metadata: g.metadata.clone(),
            availability_until: r.availability.filter(|until| *until > now),
        };
        let pending = t.jobs.values().any(|j| {
            j.view.generation == reference.generation
                && j.view.kind == JobKind::Restore
                && !terminal(&j.view.state)
                && j.view.deadline > now
                && j.moderation_epoch == g.moderation_epoch
                && j.subscribers
                    .get(name)
                    .is_some_and(|s| s.revision == reference.revision)
        });
        Ok(ArchiveView {
            reference,
            pending,
            cache_location: g.cache.clone(),
        })
    }
}

impl JobPort for MemoryCatalogue {
    fn outbox(&self, tenant: TenantId) -> Vec<OutboxEvent> {
        self.tenants
            .get(&tenant)
            .map_or_else(Vec::new, |t| t.events.values().cloned().collect())
    }

    fn outbox_event(&self, tenant: TenantId, event: EventId) -> Result<OutboxEvent> {
        self.tenants
            .get(&tenant)
            .and_then(|t| t.events.get(&event))
            .cloned()
            .ok_or(Error::Unavailable)
    }

    fn job(&self, tenant: TenantId, job: JobId) -> Result<JobView> {
        Ok(self
            .tenants
            .get(&tenant)
            .and_then(|t| t.jobs.get(&job))
            .ok_or(Error::Unavailable)?
            .view
            .clone())
    }

    fn generation(&self, tenant: TenantId, generation: GenerationId) -> Result<GenerationView> {
        let g = self
            .tenants
            .get(&tenant)
            .and_then(|t| t.generations.get(&generation))
            .ok_or(Error::Unavailable)?;
        Ok(GenerationView {
            metadata: g.metadata.clone(),
            cache_location: g.cache.clone(),
        })
    }

    fn retire_upload_intent(
        &mut self,
        tenant: TenantId,
        intent: OperationId,
        now: u64,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let i = t.intents.get(&intent).ok_or(Error::Unavailable)?;
            if !i.pending
                || (now < i.archive_deadline && t.current_revision(&i.name) == i.expected_revision)
            {
                return Err(Error::Conflict);
            }
            let generation = t.references.get(&i.name).and_then(|r| r.generation);
            t.intents
                .get_mut(&intent)
                .ok_or(Error::Unavailable)?
                .pending = false;
            if let Some(generation) = generation {
                t.touch(generation)?;
            }
            Ok(())
        })
    }

    fn claim(&mut self, tenant: TenantId, job: JobId, now: u64, until: u64) -> Result<Fence> {
        self.atomic(tenant, |t| {
            let j = t.jobs.get_mut(&job).ok_or(Error::Unavailable)?;
            let g = t
                .generations
                .get(&j.view.generation)
                .ok_or(Error::Unavailable)?;
            if g.prohibited || g.deleting.is_some() {
                return Err(Error::Unavailable);
            }
            if j.view.kind == JobKind::Restore && j.moderation_epoch != g.moderation_epoch {
                return Err(Error::Unavailable);
            }
            if terminal(&j.view.state) || j.claimed_until > now {
                return Err(Error::Fenced);
            }
            if now >= j.view.deadline || until <= now || until > j.view.deadline {
                return Err(Error::Expired);
            }
            if matches!(j.view.state, JobState::RetryWait { not_before } if now < not_before) {
                return Err(Error::Conflict);
            }
            j.fence = next(j.fence)?;
            // Archival obligation survives policy changes. Only a new claim may
            // adopt the current epoch; prior workers retain their stale fence.
            if j.view.kind == JobKind::Archive {
                j.moderation_epoch = g.moderation_epoch;
            }
            j.claimed_until = until;
            j.view.state = JobState::Running;
            let fence = Fence {
                job,
                token: j.fence,
            };
            let generation = j.view.generation;
            t.touch(generation)?;
            Ok(fence)
        })
    }

    fn expire_job(&mut self, tenant: TenantId, job: JobId, now: u64) -> Result<()> {
        self.atomic(tenant, |t| {
            let j = t.jobs.get_mut(&job).ok_or(Error::Unavailable)?;
            if terminal(&j.view.state) || now < j.view.deadline {
                return Err(Error::Conflict);
            }
            j.view.state = JobState::Expired;
            j.fence = next(j.fence)?;
            let generation = j.view.generation;
            t.events.remove(&j.event);
            t.touch(generation)
        })
    }

    fn cancel_unneeded_restore(
        &mut self,
        tenant: TenantId,
        job: JobId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let j = t.jobs.get(&job).ok_or(Error::Unavailable)?;
            if terminal(&j.view.state) || j.claimed_until > now {
                return Err(Error::Fenced);
            }
            if now >= j.view.deadline {
                return Err(Error::Expired);
            }
            if !authority.is_current()
                || j.view.kind != JobKind::Restore
                || t.has_current_subscriber(tenant, j, authority)
            {
                return Err(Error::Unsafe);
            }
            let j = t.jobs.get_mut(&job).ok_or(Error::Unavailable)?;
            // Conditional terminalization grants no worker/publication authority.
            j.fence = next(j.fence)?;
            j.view.state = JobState::Cancelled;
            let generation = j.view.generation;
            t.events.remove(&j.event);
            t.touch(generation)
        })
    }

    fn transition(
        &mut self,
        tenant: TenantId,
        fence: Fence,
        transition: Transition,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let mut j = t.jobs.get(&fence.job).ok_or(Error::Unavailable)?.clone();
            if j.fence != fence.token || j.view.state != JobState::Running || j.claimed_until <= now
            {
                return Err(Error::Fenced);
            }
            if now >= j.view.deadline {
                return Err(Error::Expired);
            }
            let generation = j.view.generation;
            let g = t.generations.get(&generation).ok_or(Error::Unavailable)?;
            if g.deleting.is_some() {
                return Err(Error::Fenced);
            }
            if !authority.is_current() {
                return Err(Error::Unsafe);
            }
            if (g.prohibited || j.moderation_epoch != g.moderation_epoch)
                && !matches!(
                    transition,
                    Transition::FailUnrecoverable | Transition::CancelIfUnneeded
                )
            {
                return Err(Error::Unavailable);
            }
            match transition {
                Transition::Revalidate => {
                    if j.view.kind == JobKind::Restore
                        && !t.has_current_subscriber(tenant, &j, authority)
                    {
                        return Err(Error::Unavailable);
                    }
                    return Ok(());
                }
                Transition::Checkpoint {
                    expected,
                    next,
                    inventory_ref,
                } => {
                    if j.view.checkpoint != expected || next <= expected || inventory_ref.is_empty()
                    {
                        return Err(Error::Conflict);
                    }
                    j.view.checkpoint = next;
                    j.view.checkpoint_ref = Some(inventory_ref);
                }
                Transition::Retry { not_before } => {
                    if not_before <= now || not_before >= j.view.deadline {
                        return Err(Error::Invalid);
                    }
                    j.view.state = JobState::RetryWait { not_before };
                    j.claimed_until = 0;
                }
                Transition::CompleteArchive => {
                    if j.view.kind != JobKind::Archive
                        || g.prohibited
                        || !t.archive_verified(tenant, generation, now)
                    {
                        return Err(Error::Unsafe);
                    }
                    t.generations
                        .get_mut(&generation)
                        .ok_or(Error::Unavailable)?
                        .archived = true;
                    j.view.state = JobState::Complete;
                }
                Transition::PublishRestore { copy } => {
                    if j.view.kind != JobKind::Restore
                        || g.prohibited
                        || !g.archived
                        || !t.archive_verified(tenant, generation, now)
                    {
                        return Err(Error::Unsafe);
                    }
                    complete_copy(&g.metadata, &copy)?;
                    match &g.cache {
                        Some(location) if location != &copy.location => {
                            return Err(Error::Conflict)
                        }
                        None if !t.locations.insert(copy.location.clone()) => {
                            return Err(Error::Conflict)
                        }
                        _ => {}
                    }
                    let mut eligible = Vec::new();
                    for (name, subscriber) in &j.subscribers {
                        if permit(authority, tenant, name, Action::Restore).is_err() {
                            continue;
                        }
                        let Some(r) = t.references.get(name) else {
                            continue;
                        };
                        if r.revision != subscriber.revision || r.generation != Some(generation) {
                            continue;
                        }
                        eligible.push((
                            name.clone(),
                            match subscriber.archive_days {
                                Some(days) => archive_expiry(now, days)?,
                                None => now
                                    .checked_add(subscriber.availability_for)
                                    .ok_or(Error::Invalid)?,
                            },
                        ));
                    }
                    if eligible.is_empty() {
                        return Err(Error::Unavailable);
                    }
                    for (name, until) in eligible {
                        let r = t.references.get_mut(&name).ok_or(Error::Unavailable)?;
                        r.availability = Some(r.availability.map_or(until, |old| old.max(until)));
                        j.published
                            .insert((name.clone(), j.subscribers[&name].operation));
                    }
                    t.generations
                        .get_mut(&generation)
                        .ok_or(Error::Unavailable)?
                        .cache = Some(copy.location);
                    j.view.state = JobState::Complete;
                }
                Transition::FailUnrecoverable => j.view.state = JobState::FailedUnrecoverable,
                Transition::CancelIfUnneeded => {
                    if j.view.kind == JobKind::Archive
                        || t.has_current_subscriber(tenant, &j, authority)
                    {
                        return Err(Error::Unsafe);
                    }
                    j.view.state = JobState::Cancelled;
                }
            }
            if terminal(&j.view.state) {
                t.events.remove(&j.event);
            }
            t.touch(generation)?;
            t.jobs.insert(fence.job, j);
            Ok(())
        })
    }

    fn record_verification(
        &mut self,
        tenant: TenantId,
        evidence: VerificationEvidence,
        independence: IndependenceEvidence,
        now: u64,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let g = t
                .generations
                .get_mut(&evidence.generation)
                .ok_or(Error::Unavailable)?;
            #[cfg(feature = "archive-provider")]
            if g.s3_verification.is_some() {
                return Err(Error::Unsafe);
            }
            if g.deletion_dispatched
                || g.prohibited
                || evidence.reconstructed != g.metadata.identity
                || evidence.verified_at > now
                || evidence.valid_until <= now
                || evidence.verifier_version.is_empty()
                || evidence.provenance_ref.is_empty()
                || evidence.readability_ref.is_empty()
                || independence.backbones[0] == independence.backbones[1]
                || !independence.backbones.contains(&evidence.backbone)
                || independence.valid_until <= now
                || independence.assessor_ref.is_empty()
                || independence.decision_ref.is_empty()
            {
                return Err(Error::Unsafe);
            }
            // An authenticated, still-valid exact replay is a no-op. Same-time
            // changed content or attribution remains a conflict, not a refresh.
            if g.verification.get(&evidence.backbone) == Some(&evidence)
                && g.independence.as_ref() == Some(&independence)
            {
                return Ok(());
            }
            if g.verification
                .get(&evidence.backbone)
                .is_some_and(|old| old.verified_at >= evidence.verified_at)
            {
                return Err(Error::Conflict);
            }
            g.verification.insert(evidence.backbone, evidence);
            g.independence = Some(independence);
            g.revision = next(g.revision)?;
            Ok(())
        })
    }

    #[cfg(feature = "archive-provider")]
    fn record_s3_verification(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        evidence: S3VerificationEvidence,
        now: u64,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            if g.deleting.is_some()
                || g.prohibited
                || !g.verification.is_empty()
                || g.independence.is_some()
                || !evidence.valid(tenant, generation, &g.metadata, now)
            {
                return Err(Error::Unsafe);
            }
            if let Some(old) = &g.s3_verification {
                if old == &evidence {
                    return Ok(());
                }
                if old.record != evidence.record || old.verified_at >= evidence.verified_at {
                    return Err(Error::Conflict);
                }
            }
            g.s3_verification = Some(evidence);
            g.revision = next(g.revision)?;
            Ok(())
        })
    }

    fn set_safety_hold(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        hold: bool,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            g.safety_hold = hold;
            t.touch(generation)
        })
    }

    fn set_moderation(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        epoch: u64,
        prohibited: bool,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            if epoch <= g.moderation_epoch {
                return Err(Error::Fenced);
            }
            g.moderation_epoch = epoch;
            g.prohibited = prohibited;
            t.touch(generation)
        })
    }

    fn candidate(
        &self,
        tenant: TenantId,
        generation: GenerationId,
        kind: DeletionKind,
        now: u64,
        not_before: u64,
        authority: &dyn Authority,
    ) -> Result<DeletionCandidate> {
        let t = self.tenants.get(&tenant).ok_or(Error::Unavailable)?;
        if not_before <= now {
            return Err(Error::Invalid);
        }
        t.safe_to_delete(tenant, generation, kind, now, authority)?;
        if t.generations[&generation].deleting.is_some() {
            return Err(Error::Unsafe);
        }
        Ok(DeletionCandidate {
            tenant,
            generation,
            revision: t.generations[&generation].revision,
            not_before,
            kind,
        })
    }

    fn finalize_deletion(
        &mut self,
        candidate: DeletionCandidate,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<EventId> {
        self.atomic(candidate.tenant, |t| {
            if now < candidate.not_before {
                return Err(Error::Conflict);
            }
            t.safe_to_delete(
                candidate.tenant,
                candidate.generation,
                candidate.kind,
                now,
                authority,
            )?;
            let g = t
                .generations
                .get(&candidate.generation)
                .ok_or(Error::Unavailable)?;
            if g.revision != candidate.revision {
                return Err(Error::Fenced);
            }
            // Physical archive deletion is deliberately absent: logical deletion
            // cannot promise erasure of propagated Usenet articles.
            let target = g
                .cache
                .clone()
                .map_or(DeletionTarget::MetadataOnly, DeletionTarget::StorageVersion);
            let id = EventId(t.allocate()?);
            t.events.insert(
                id,
                OutboxEvent {
                    id,
                    effect: Effect::Delete {
                        generation: candidate.generation,
                        kind: candidate.kind,
                        target,
                    },
                },
            );
            t.generations
                .get_mut(&candidate.generation)
                .ok_or(Error::Unavailable)?
                .deleting = Some((id, candidate.kind));
            t.touch(candidate.generation)?;
            Ok(id)
        })
    }

    fn dispatch_deletion(
        &mut self,
        tenant: TenantId,
        event: EventId,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<DeletionDispatch> {
        self.atomic(tenant, |t| {
            let e = t.events.get(&event).ok_or(Error::Unavailable)?.clone();
            let Effect::Delete {
                generation,
                kind,
                target,
            } = e.effect
            else {
                return Err(Error::Invalid);
            };
            let g = t.generations.get(&generation).ok_or(Error::Unavailable)?;
            if g.deleting != Some((event, kind)) || g.deletion_dispatched {
                return Err(Error::Fenced);
            }
            t.safe_to_delete(tenant, generation, kind, now, authority)?;
            let i = g.independence.as_ref().ok_or(Error::Unsafe)?;
            let mut valid_until = i.valid_until;
            for b in &i.backbones {
                valid_until =
                    valid_until.min(g.verification.get(b).ok_or(Error::Unsafe)?.valid_until);
            }
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            g.deletion_dispatched = true;
            g.dispatch_valid_until = valid_until;
            t.touch(generation)?;
            Ok(DeletionDispatch {
                event,
                generation,
                kind,
                target,
                valid_until,
            })
        })
    }

    fn cancel_deletion(&mut self, tenant: TenantId, event: EventId) -> Result<()> {
        self.atomic(tenant, |t| {
            let e = t.events.get(&event).ok_or(Error::Unavailable)?;
            let Effect::Delete {
                generation, kind, ..
            } = e.effect
            else {
                return Err(Error::Invalid);
            };
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            if g.deleting != Some((event, kind)) || g.deletion_dispatched {
                return Err(Error::Fenced);
            }
            g.deleting = None;
            t.events.remove(&event);
            t.touch(generation)
        })
    }

    fn reconcile_retained_deletion(
        &mut self,
        tenant: TenantId,
        event: EventId,
        retained: CompleteCopy,
        settlement_ref: String,
        now: u64,
    ) -> Result<()> {
        self.atomic(tenant, |t| {
            let e = t.events.get(&event).ok_or(Error::Unavailable)?;
            let Effect::Delete {
                generation,
                kind,
                ref target,
            } = e.effect
            else {
                return Err(Error::Invalid);
            };
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            if g.deleting != Some((event, kind))
                || !g.deletion_dispatched
                || now < g.dispatch_valid_until
            {
                return Err(Error::Fenced);
            }
            if settlement_ref.is_empty()
                || target != &DeletionTarget::StorageVersion(retained.location.clone())
                || g.cache.as_ref() != Some(&retained.location)
            {
                return Err(Error::Unsafe);
            }
            complete_copy(&g.metadata, &retained)?;
            g.deleting = None;
            g.deletion_dispatched = false;
            t.events.remove(&event);
            t.touch(generation)
        })
    }

    fn acknowledge_deletion(&mut self, tenant: TenantId, event: EventId) -> Result<()> {
        self.atomic(tenant, |t| {
            let e = t.events.get(&event).ok_or(Error::Unavailable)?;
            let Effect::Delete {
                generation, kind, ..
            } = e.effect
            else {
                return Err(Error::Invalid);
            };
            let g = t
                .generations
                .get_mut(&generation)
                .ok_or(Error::Unavailable)?;
            if g.deleting != Some((event, kind)) || !g.deletion_dispatched {
                return Err(Error::Fenced);
            }
            g.cache = None;
            g.deletion_dispatched = false;
            // Keep the generation, moderation epoch and operation/tombstone
            // ledger. An acknowledged delete never makes its identity reusable.
            g.deleting = if kind == DeletionKind::UnreferencedGeneration {
                Some((event, kind))
            } else {
                None
            };
            t.events.remove(&event);
            t.touch(generation)
        })
    }
}
