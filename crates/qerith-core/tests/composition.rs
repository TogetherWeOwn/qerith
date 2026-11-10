#![cfg(feature = "native-tls")]
#![allow(dead_code)]

#[path = "composition/service.rs"]
mod product_service;
mod support;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use qerith_core::catalogue::*;
use qerith_core::composition::*;
use sha2::{Digest, Sha256};
use support::{Archive, Event, Fault, FixtureC, Key, MemoryCache, MockBackbone, Trace};

const TENANT: TenantId = TenantId(1);
const GENERATION: GenerationId = GenerationId(1);
const WEEK: u64 = 7 * 24 * 60 * 60;

#[derive(Default)]
struct Auth {
    denied: RefCell<BTreeSet<String>>,
    stale: Cell<bool>,
}
impl Authority for Auth {
    fn is_current(&self) -> bool {
        !self.stale.get()
    }
    fn permits(&self, reference: &Reference, action: Action) -> bool {
        reference.tenant == TENANT
            && !self.denied.borrow().contains(&reference.name)
            && !self
                .denied
                .borrow()
                .contains(&format!("{}:{action:?}", reference.name))
    }
}
struct Time(Cell<u64>);
impl Clock for Time {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        Ok(self.0.get())
    }
}
#[derive(Default)]
struct Rules {
    deny: Cell<bool>,
    cancelled: Rc<Cell<bool>>,
}
impl Policy for Rules {
    fn admit_upload(&self, _: &Upload, _: &Budget, _: u64) -> bool {
        !self.deny.get()
    }
    fn admit_work(&self, _: &Work, _: u64) -> bool {
        !self.deny.get()
    }
    fn cancelled(&self, _: &Work) -> bool {
        self.cancelled.get()
    }
    fn retry_at(&self, _: &Work, error: &IoError, now: u64) -> Option<u64> {
        matches!(
            error,
            IoError::Retryable | IoError::Uncertain | IoError::Cancelled
        )
        .then_some(now + 2)
    }
    fn cleanup_incomplete(&self, _: &Work, _: &IoError) -> bool {
        true
    }
}
struct MockQualification;
impl Qualifier for MockQualification {
    fn qualify(
        &self,
        work: &Work,
        retrieved: &[Reconstruction; 2],
        now: u64,
    ) -> qerith_core::catalogue::Result<Qualification> {
        Ok(Qualification {
            independence: IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "MOCK assessor, not provider qualification".into(),
                decision_ref: "MOCK distinct synthetic spools".into(),
                valid_until: now + 2 * WEEK,
            },
            verification: std::array::from_fn(|n| VerificationEvidence {
                generation: work.job.generation,
                backbone: retrieved[n].backbone,
                reconstructed: retrieved[n].identity.clone(),
                verified_at: now,
                valid_until: now + 2 * WEEK,
                verifier_version: "synthetic-engine-article-v1".into(),
                provenance_ref: format!("mock-spool-{n}"),
                readability_ref: "MOCK opaque C, no cryptographic readability claim".into(),
            }),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Injection {
    None,
    PartialUpload,
    BadReceipt,
    PartialRestore,
    BadDigest,
    Uncertain,
    RepairFailure,
    SameBackbone,
    CleanupFailure,
    Interrupted,
}

type RecoveryInventory = (u64, u64, u64, String);
type AttemptAllocation = (RecoveryInventory, u64);
type IoHook = Box<dyn FnMut(&Work)>;

fn inventory(work: &Work) -> RecoveryInventory {
    (
        work.tenant.0,
        work.job.generation.0,
        work.job.id.0,
        work.inventory_ref.clone(),
    )
}
fn allocation(work: &Work) -> AttemptAllocation {
    (inventory(work), work.attempt)
}

/// The only byte source for a cold attempt is the producer's native engine
/// ARTICLE adapter. The FixtureC value is an immutable assertion oracle, not a
/// warm read path. Completed copies are private until a catalogue serving pin.
struct Io {
    fixture: FixtureC,
    archives: [Archive; 2],
    scratch: BTreeMap<AttemptAllocation, MemoryCache>,
    copies: BTreeMap<String, Vec<u8>>,
    pending: BTreeMap<AttemptAllocation, Vec<u8>>,
    completed: BTreeMap<RecoveryInventory, String>,
    trace: Trace,
    order: Vec<&'static str>,
    inject: Injection,
    fault: Fault,
    revoke_at_complete: Option<(Rc<Auth>, String)>,
    revoke_at_upload: Option<(Rc<Auth>, String)>,
    expire_at_complete: Option<Rc<Time>>,
    expire_at_upload: Option<Rc<Time>>,
    attempts: Vec<(String, u64)>,
    after_io: Option<IoHook>,
    cancel_at_complete: Option<Rc<Cell<bool>>>,
    expire_at_cleanup: Option<Rc<Time>>,
    #[cfg(feature = "archive-provider")]
    provider_record: Option<velmora::archive::v1::ObjectRecord>,
    #[cfg(feature = "archive-provider")]
    provider_write: Option<qerith_core::composition::provider::WriteJournal>,
    #[cfg(feature = "archive-provider")]
    provider_keys: BTreeMap<RecoveryInventory, [u8; 32]>,
}
impl Io {
    async fn new(generation: u64) -> Self {
        let fixture = FixtureC::new(Key {
            object: 1,
            generation,
        });
        let a = Archive::spawn(
            &fixture,
            MockBackbone {
                label: "mock-a",
                provenance: "spool-a",
            },
            Fault::Healthy,
        )
        .await;
        let b = Archive::spawn(
            &fixture,
            MockBackbone {
                label: "mock-b",
                provenance: "spool-b",
            },
            Fault::Healthy,
        )
        .await;
        Self {
            fixture,
            archives: [a, b],
            scratch: BTreeMap::new(),
            copies: BTreeMap::new(),
            pending: BTreeMap::new(),
            completed: BTreeMap::new(),
            trace: Trace::default(),
            order: Vec::new(),
            inject: Injection::None,
            fault: Fault::Healthy,
            revoke_at_complete: None,
            revoke_at_upload: None,
            expire_at_complete: None,
            expire_at_upload: None,
            attempts: Vec::new(),
            after_io: None,
            cancel_at_complete: None,
            expire_at_cleanup: None,
            #[cfg(feature = "archive-provider")]
            provider_record: None,
            #[cfg(feature = "archive-provider")]
            provider_write: None,
            #[cfg(feature = "archive-provider")]
            provider_keys: BTreeMap::new(),
        }
    }
    fn identity(&self) -> CiphertextIdentity {
        CiphertextIdentity {
            length: self.fixture.bytes().len() as u64,
            sha256: self.fixture.digest(),
        }
    }
    fn upload(&self) -> Upload {
        let generation = self.fixture.key().generation;
        Upload {
            tenant: TENANT,
            intent: OperationId(generation * 100),
            commit: OperationId(generation * 100 + 1),
            name: "object".into(),
            expected_revision: generation - 1,
            generation: GenerationId(generation),
            metadata: CiphertextMetadata {
                identity: self.identity(),
                validator: format!("\"opaque-generation-{generation}\""),
                modified_at: 7,
                headers: BTreeMap::from([(
                    "Content-Encoding".into(),
                    "opaque-application-format".into(),
                )]),
                checksums: vec![Checksum {
                    algorithm: "SHA256".into(),
                    kind: ChecksumType::FullObject,
                    value: self.fixture.digest().to_vec(),
                    parts: Vec::new(),
                }],
                recovery_ref: format!("mock-recovery/intent-{}", generation * 100),
            },
            archive_deadline: 3 * WEEK,
        }
    }
    fn copy(&self, metadata: &CiphertextMetadata, location: String) -> CompleteCopy {
        CompleteCopy {
            identity: self.identity(),
            checksums: metadata.checksums.clone(),
            location,
            receipt: "complete immutable mock version".into(),
        }
    }
    fn check(&self, work: &Work) -> std::result::Result<(), IoError> {
        if work.tenant != TENANT
            || work.job.generation.0 != self.fixture.key().generation
            || work.metadata.identity != self.identity()
            || work.budget.max_bytes() < self.identity().length
            || work.budget.max_units() < 3
        {
            return Err(IoError::Integrity);
        }
        Ok(())
    }
    async fn cold_fetch(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.check(work)?;
        self.order.push("engine-retrieve");
        let key = allocation(work);
        let scratch = self.scratch.entry(key.clone()).or_default();
        let result = self.archives[0]
            .reconstruct(&self.fixture, scratch, self.fault, &mut self.trace)
            .await;
        if result.is_err() {
            assert!(self.archives[0].repair_without_retained_source().is_err());
            return Err(IoError::RepairUnavailable);
        }
        let bytes = scratch.delivery(self.fixture.key()).unwrap().to_vec();
        scratch.cleanup(self.fixture.key(), &mut self.trace);
        self.scratch.remove(&key);
        self.pending.insert(key, bytes);
        Ok(())
    }
    fn deliver(
        &self,
        catalogue: &(impl MetadataOutbox + JobPort),
        pin: PinId,
        now: u64,
        auth: &dyn Authority,
    ) -> qerith_core::catalogue::Result<&[u8]> {
        let generation = catalogue.validate_pin(TENANT, pin, now, auth)?;
        if generation.0 != self.fixture.key().generation {
            return Err(Error::Unavailable);
        }
        let location = catalogue
            .generation(TENANT, generation)?
            .cache_location
            .ok_or(Error::Unavailable)?;
        self.copies
            .get(&location)
            .map(Vec::as_slice)
            .ok_or(Error::Unavailable)
    }
    fn assert_cold(&self) {
        assert!(self.copies.is_empty());
        assert!(self.pending.is_empty());
        assert!(self.scratch.is_empty());
        assert!(self.completed.is_empty());
    }
}
impl Storage for Io {
    async fn stage_upload(
        &mut self,
        upload: &Upload,
        _: &Budget,
        until: u64,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.order.push("upload-stage");
        assert!(until <= upload.archive_deadline);
        if let Some(clock) = &self.expire_at_upload {
            clock.0.set(until);
        }
        if self.inject == Injection::PartialUpload {
            return Err(IoError::Retryable);
        }
        let location = format!(
            "mock/{}/{}/intent-{}",
            upload.tenant.0, upload.generation.0, upload.intent.0
        );
        let bytes = self
            .copies
            .get(&location)
            .map(Vec::as_slice)
            .unwrap_or_else(|| self.fixture.bytes());
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        if bytes.len() as u64 != upload.metadata.identity.length
            || digest != upload.metadata.identity.sha256
            || upload.metadata.checksums.iter().any(|c| {
                c.algorithm != "SHA256"
                    || c.kind != ChecksumType::FullObject
                    || c.value != digest
                    || !c.parts.is_empty()
            })
        {
            return Err(IoError::Integrity);
        }
        if let std::collections::btree_map::Entry::Vacant(entry) =
            self.copies.entry(location.clone())
        {
            entry.insert(self.fixture.bytes().to_vec());
        }
        self.order.push("upload-complete");
        if let Some((auth, name)) = &self.revoke_at_upload {
            auth.denied.borrow_mut().insert(name.clone());
        }
        let mut copy = self.copy(&upload.metadata, location);
        if self.inject == Injection::BadReceipt {
            copy.identity.length -= 1;
        }
        Ok(copy)
    }
    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.check(work)?;
        self.attempts
            .push((work.inventory_ref.clone(), work.attempt));
        self.order.push("engine-post");
        let source = self
            .copies
            .get(work.retained_location.as_ref().ok_or(IoError::Integrity)?)
            .ok_or(IoError::Integrity)?;
        for archive in &self.archives {
            for n in 0..3 {
                archive
                    .repost_from_retained(n, source, &mut self.trace)
                    .await
                    .map_err(|_| IoError::Retryable)?;
            }
        }
        if let Some(hook) = &mut self.after_io {
            hook(work);
        }
        if self.inject == Injection::Interrupted {
            return Err(IoError::Cancelled);
        }
        if self.inject == Injection::Uncertain {
            return Err(IoError::Uncertain);
        }
        if self.inject == Injection::CleanupFailure {
            return Err(IoError::Retryable);
        }
        Ok(())
    }
    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        self.check(work)?;
        self.order.push("engine-verify-pair");
        let mut proofs = Vec::new();
        let identity = self.identity();
        for (n, archive) in self.archives.iter_mut().enumerate() {
            if self.fault != Fault::Healthy {
                archive.reset(self.fault).await;
            }
            let mut scratch = MemoryCache::default();
            archive
                .reconstruct(&self.fixture, &mut scratch, Fault::Healthy, &mut self.trace)
                .await
                .map_err(|_| IoError::Integrity)?;
            proofs.push(Reconstruction {
                backbone: BackboneId(if self.inject == Injection::SameBackbone {
                    1
                } else {
                    n as u64 + 1
                }),
                identity: identity.clone(),
            });
        }
        Ok(proofs.try_into().unwrap())
    }
    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.attempts
            .push((work.inventory_ref.clone(), work.attempt));
        if self.inject == Injection::Interrupted {
            return Err(IoError::Cancelled);
        }
        self.check(work)?;
        // Only the exact scoped inventory or catalogue location is eligible;
        // arbitrary physical presence is never a recovery/authorization signal.
        if let Some(location) = self
            .completed
            .get(&inventory(work))
            .cloned()
            .or_else(|| work.retained_location.clone())
        {
            self.verify_completed(work, &location).await?;
        } else {
            if self.inject == Injection::RepairFailure {
                return Err(IoError::RepairUnavailable);
            }
            self.cold_fetch(work).await?;
        }
        if let Some(hook) = &mut self.after_io {
            hook(work);
        }
        Ok(())
    }
    async fn complete_restore(
        &mut self,
        work: &Work,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.order.push("whole-generation-check");
        let retained = self
            .completed
            .get(&inventory(work))
            .cloned()
            .or_else(|| work.retained_location.clone());
        let location = if let Some(location) = retained {
            self.verify_completed(work, &location).await?;
            // Another attempt may have completed after this attempt staged.
            // Release only this now-redundant incomplete allocation.
            self.pending.remove(&allocation(work));
            self.scratch.remove(&allocation(work));
            location
        } else {
            let mut bytes = self
                .pending
                .remove(&allocation(work))
                .ok_or(IoError::Integrity)?;
            if self.inject == Injection::PartialRestore {
                bytes.pop();
            }
            if self.inject == Injection::BadDigest {
                bytes[2000] ^= 1;
            }
            let digest: [u8; 32] = Sha256::digest(&bytes).into();
            if bytes.len() as u64 != work.metadata.identity.length
                || digest != work.metadata.identity.sha256
                || work.metadata.checksums.iter().any(|c| {
                    c.algorithm != "SHA256"
                        || c.kind != ChecksumType::FullObject
                        || c.value != digest
                        || !c.parts.is_empty()
                })
            {
                return Err(IoError::Integrity);
            }
            let location = format!(
                "mock/{}/{}/job-{}-frozen",
                work.tenant.0, work.job.generation.0, work.job.id.0
            );
            if let std::collections::btree_map::Entry::Vacant(entry) =
                self.copies.entry(location.clone())
            {
                entry.insert(bytes);
                self.order.push("cache-install");
            } else {
                self.verify_completed(work, &location).await?;
            }
            location
        };
        // Persist completion before acknowledging it; attempt cleanup never
        // removes this stable entry or its immutable bytes.
        self.completed.insert(inventory(work), location.clone());
        self.order.push("cache-complete");
        if let Some(cancelled) = &self.cancel_at_complete {
            cancelled.set(true);
        }
        if let Some((auth, name)) = &self.revoke_at_complete {
            auth.denied.borrow_mut().insert(name.clone());
        }
        if let Some(clock) = &self.expire_at_complete {
            clock.0.set(work.claim_until);
        }
        Ok(self.copy(&work.metadata, location))
    }
    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.check(work)?;
        self.order.push("verify-winning-cache");
        let bytes = self.copies.get(location).ok_or(IoError::Integrity)?;
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        if bytes.len() as u64 != work.metadata.identity.length
            || digest != work.metadata.identity.sha256
            || work.metadata.checksums.iter().any(|c| {
                c.algorithm != "SHA256"
                    || c.kind != ChecksumType::FullObject
                    || c.value != digest
                    || !c.parts.is_empty()
            })
        {
            return Err(IoError::Integrity);
        }
        Ok(self.copy(&work.metadata, location.into()))
    }
    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        if let Some(clock) = &self.expire_at_cleanup {
            clock.0.set(work.job.deadline);
        }
        if self.inject == Injection::CleanupFailure {
            return Err(IoError::Retryable);
        }
        self.order.push("cleanup-incomplete");
        let key = allocation(work);
        self.pending.remove(&key);
        if let Some(mut scratch) = self.scratch.remove(&key) {
            scratch.restart(self.fixture.key(), &mut self.trace);
        }
        Ok(())
    }
}

fn budget() -> Budget {
    Budget::new(4096, 3, 3, 100).unwrap()
}
fn job_event(c: &impl JobPort, job: JobId) -> EventId {
    c.outbox(TENANT)
        .iter()
        .find_map(|e| match &e.effect {
            Effect::RunJob(j) if j.id == job => Some(e.id),
            _ => None,
        })
        .unwrap()
}
fn commit_job(outcome: Outcome) -> JobId {
    match outcome {
        Outcome::Committed { archive, .. } => archive,
        _ => panic!("not committed"),
    }
}
fn request(
    c: &mut impl MetadataOutbox,
    name: &str,
    op: u64,
    deadline: u64,
    availability_for: u64,
    now: u64,
    auth: &dyn Authority,
) -> JobId {
    let revision = c.lookup(TENANT, name, now, auth).unwrap().revision;
    match c
        .transact(
            TENANT,
            OperationId(op),
            Mutation::RequestRestore {
                name: name.into(),
                expected_revision: revision,
                profile: "synthetic-whole-generation".into(),
                deadline,
                availability_for,
            },
            now,
            auth,
        )
        .unwrap()
    {
        Outcome::Restore(j) => j,
        _ => unreachable!(),
    }
}
fn pin(
    c: &mut impl MetadataOutbox,
    name: &str,
    op: u64,
    now: u64,
    auth: &dyn Authority,
) -> qerith_core::catalogue::Result<PinId> {
    match c.transact(
        TENANT,
        OperationId(op),
        Mutation::AcquireServingPin {
            name: name.into(),
            until: now + 10,
        },
        now,
        auth,
    )? {
        Outcome::Pin(pin) => Ok(pin),
        _ => unreachable!(),
    }
}
async fn run(
    c: &mut impl JobPort,
    io: &mut Io,
    job: JobId,
    time: &Time,
    rules: &Rules,
    auth: &dyn Authority,
) -> RunResult<()> {
    let event = job_event(c, job);
    run_once(
        c,
        io,
        TENANT,
        event,
        &budget(),
        time,
        rules,
        &MockQualification,
        auth,
    )
    .await
}
async fn archived() -> (MemoryCatalogue, Io, JobId, Rc<Time>, Rc<Auth>, Rules) {
    let mut c = MemoryCatalogue::default();
    let mut io = Io::new(1).await;
    let time = Rc::new(Time(Cell::new(10)));
    let auth = Rc::new(Auth::default());
    let rules = Rules::default();
    let upload = io.upload();
    let job = commit_job(
        ingest(
            &mut c,
            &mut io,
            &upload,
            &budget(),
            time.as_ref(),
            &rules,
            auth.as_ref(),
        )
        .await
        .unwrap(),
    );
    assert!(
        pin(&mut c, "object", 500, 10, auth.as_ref()).is_err(),
        "safety bytes cannot authorize GET"
    );
    run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .unwrap();
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
    (c, io, job, time, auth, rules)
}
fn evict(c: &mut impl JobPort, io: &mut Io, time: &Time, auth: &dyn Authority) {
    let now = time.0.get();
    let candidate = c
        .candidate(
            TENANT,
            GENERATION,
            DeletionKind::DeliveryCache,
            now,
            now + 1,
            auth,
        )
        .unwrap();
    time.0.set(now + 1);
    let event = c.finalize_deletion(candidate, now + 1, auth).unwrap();
    let dispatch = c.dispatch_deletion(TENANT, event, now + 1, auth).unwrap();
    assert!(now + 1 < dispatch.valid_until);
    let DeletionTarget::StorageVersion(location) = dispatch.target else {
        panic!("expected exact version");
    };
    assert!(io.copies.remove(&location).is_some());
    c.acknowledge_deletion(TENANT, event).unwrap();
    // Only confirmed exact-version deletion retires completed inventory. An
    // unexpectedly missing recorded copy still fails closed during retrieval.
    io.completed.retain(|_, completed| completed != &location);
    io.assert_cold();
}

/// Controlled commit failure/ack-loss, not a durable database implementation.
struct CommitFault {
    inner: MemoryCatalogue,
    apply_before_error: bool,
}
impl MetadataOutbox for CommitFault {
    fn transact(
        &mut self,
        tenant: TenantId,
        operation: OperationId,
        mutation: Mutation,
        now: u64,
        authority: &dyn Authority,
    ) -> qerith_core::catalogue::Result<Outcome> {
        if matches!(mutation, Mutation::CommitUpload { .. }) {
            if self.apply_before_error {
                self.inner
                    .transact(tenant, operation, mutation, now, authority)?;
                return Err(Error::Uncertain);
            }
            return Err(Error::Conflict);
        }
        self.inner
            .transact(tenant, operation, mutation, now, authority)
    }
    fn lookup(
        &self,
        tenant: TenantId,
        name: &str,
        now: u64,
        authority: &dyn Authority,
    ) -> qerith_core::catalogue::Result<ReferenceView> {
        self.inner.lookup(tenant, name, now, authority)
    }
    fn reconcile(
        &self,
        tenant: TenantId,
        operation: OperationId,
        authority: &dyn Authority,
    ) -> qerith_core::catalogue::Result<Reconciliation> {
        self.inner.reconcile(tenant, operation, authority)
    }
    fn validate_pin(
        &self,
        tenant: TenantId,
        pin: PinId,
        now: u64,
        authority: &dyn Authority,
    ) -> qerith_core::catalogue::Result<GenerationId> {
        self.inner.validate_pin(tenant, pin, now, authority)
    }
}

#[tokio::test]
async fn unneeded_restore_cancels_without_invocation_interruption_or_attempt() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    c.transact(
        TENANT,
        OperationId(1001),
        Mutation::CancelSubscription {
            name: "object".into(),
            job,
            subscription: OperationId(1000),
        },
        10,
        auth.as_ref(),
    )
    .unwrap();
    let before = io.order.len();
    assert!(!rules.cancelled.get());
    assert_eq!(
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Cancelled);
    assert_eq!(c.job(TENANT, job).unwrap().checkpoint, 0);
    assert!(c.outbox(TENANT).is_empty());
    assert_eq!(io.order.len(), before);
    assert_eq!(io.copies.len(), 1);
}

#[tokio::test]
async fn unneeded_restore_cancellation_does_not_require_resource_admission() {
    for denied_by in 0..3 {
        let (mut c, mut io, _, time, auth, rules) = archived().await;
        let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
        if denied_by == 0 {
            let fence = c.claim(TENANT, job, 10, 20).unwrap();
            c.transition(
                TENANT,
                fence,
                Transition::Checkpoint {
                    expected: 0,
                    next: 3,
                    inventory_ref: "lost-final-attempt".into(),
                },
                10,
                auth.as_ref(),
            )
            .unwrap();
            time.0.set(21);
        }
        c.transact(
            TENANT,
            OperationId(1001),
            Mutation::CancelSubscription {
                name: "object".into(),
                job,
                subscription: OperationId(1000),
            },
            time.0.get(),
            auth.as_ref(),
        )
        .unwrap();
        let limit = if denied_by == 1 {
            Budget::new(1, 3, 3, 100).unwrap()
        } else {
            budget()
        };
        if denied_by == 2 {
            rules.deny.set(true);
        }
        let before = io.order.len();
        let event = job_event(&c, job);
        assert_eq!(
            run_once(
                &mut c,
                &mut io,
                TENANT,
                event,
                &limit,
                time.as_ref(),
                &rules,
                &MockQualification,
                auth.as_ref()
            )
            .await,
            Err(Failure::Io(IoError::Cancelled))
        );
        assert_eq!(io.order.len(), before);
        assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Cancelled);
        assert_eq!(
            c.job(TENANT, job).unwrap().checkpoint,
            if denied_by == 0 { 3 } else { 0 }
        );
        assert!(c.outbox(TENANT).is_empty());
    }
}

#[tokio::test]
async fn completed_attempt_adoption_releases_only_its_own_staging() {
    let (mut c, mut io, _, time, auth, _) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    let job = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
    let old = Work {
        tenant: TENANT,
        event: job_event(&c, job),
        job: c.job(TENANT, job).unwrap(),
        metadata: c.generation(TENANT, GENERATION).unwrap().metadata,
        retained_location: None,
        inventory_ref: "shared-completed-inventory".into(),
        attempt: 1,
        claim_until: 20,
        budget: budget(),
    };
    let mut new = old.clone();
    new.attempt = 2;
    io.retrieve(&old).await.unwrap();
    io.retrieve(&new).await.unwrap();
    let complete = io.complete_restore(&old).await.unwrap();
    let mut unrelated = new.clone();
    unrelated.attempt = 3;
    io.pending
        .insert(allocation(&unrelated), b"unrelated staging".to_vec());
    assert_eq!(io.complete_restore(&new).await.unwrap(), complete);
    assert!(!io.pending.contains_key(&allocation(&new)));
    assert_eq!(io.pending[&allocation(&unrelated)], b"unrelated staging");
    assert_eq!(io.copies.len(), 1);
}

#[tokio::test]
async fn settled_deletion_allows_a_second_truly_cold_restore() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    for (operation, now) in [(1000, 11), (1001, 100)] {
        time.0.set(now);
        if operation == 1001 {
            evict(&mut c, &mut io, &time, auth.as_ref());
        }
        let job = request(
            &mut c,
            "object",
            operation,
            500,
            40,
            time.0.get(),
            auth.as_ref(),
        );
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
            .await
            .unwrap();
        assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
        assert_eq!(io.copies.len(), 1);
    }
    assert_eq!(
        io.order.iter().filter(|e| **e == "engine-retrieve").count(),
        2
    );
}

#[tokio::test]
async fn deadline_expiry_skips_cleanup_and_survives_cleanup_failure() {
    for expires_during_cleanup in [false, true] {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let upload = io.upload();
        let time = Rc::new(Time(Cell::new(10)));
        let auth = Auth::default();
        let rules = Rules::default();
        let job = commit_job(
            ingest(
                &mut c,
                &mut io,
                &upload,
                &budget(),
                time.as_ref(),
                &rules,
                &auth,
            )
            .await
            .unwrap(),
        );
        io.inject = Injection::CleanupFailure;
        if expires_during_cleanup {
            io.expire_at_cleanup = Some(time.clone());
        } else {
            let time = time.clone();
            io.after_io = Some(Box::new(move |work| time.0.set(work.job.deadline)));
        }
        let result = run(&mut c, &mut io, job, &time, &rules, &auth).await;
        assert_eq!(
            result,
            Err(if expires_during_cleanup {
                Failure::Cleanup
            } else {
                Failure::Io(IoError::Retryable)
            })
        );
        assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Expired);
        assert!(c.outbox(TENANT).is_empty());
        assert_eq!(io.copies.len(), 1, "safety bytes survive expiry");
        assert!(!io.order.contains(&"cleanup-incomplete"));
    }
}

#[tokio::test]
async fn authority_drift_between_io_boundaries_stops_further_physical_work() {
    for archive in [false, true] {
        for stale in [false, true] {
            // Archive obligations survive per-reference revocation, but an
            // uncertain authority snapshot must stop either kind of worker.
            if archive && !stale {
                continue;
            }
            let (mut c, mut io, _, time, auth, rules) = archived().await;
            let job = if archive {
                let mut newer = Io::new(2).await;
                let upload = newer.upload();
                let job = commit_job(
                    ingest(
                        &mut c,
                        &mut newer,
                        &upload,
                        &budget(),
                        time.as_ref(),
                        &rules,
                        auth.as_ref(),
                    )
                    .await
                    .unwrap(),
                );
                io = newer;
                job
            } else {
                evict(&mut c, &mut io, &time, auth.as_ref());
                request(&mut c, "object", 1000, 500, 40, time.0.get(), auth.as_ref())
            };
            let auth_at_io = auth.clone();
            io.after_io = Some(Box::new(move |_| {
                if stale {
                    auth_at_io.stale.set(true);
                } else {
                    auth_at_io.denied.borrow_mut().insert("object".into());
                }
            }));
            assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
                .await
                .is_err());
            assert!(!io.order.contains(&"whole-generation-check"));
            if archive {
                assert!(!io.order.contains(&"engine-verify-pair"));
            }
            assert_ne!(c.job(TENANT, job).unwrap().state, JobState::Complete);
        }
    }
}

#[tokio::test]
async fn cancellation_during_successful_completion_never_publishes() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    let job = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
    io.cancel_at_complete = Some(rules.cancelled.clone());
    assert_eq!(
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(
        c.job(TENANT, job).unwrap().state,
        JobState::RetryWait { not_before: 13 }
    );
    assert_eq!(io.copies.len(), 1);
    assert!(pin(&mut c, "object", 1001, 11, auth.as_ref()).is_err());
}

#[tokio::test]
async fn lost_final_checkpoint_cannot_redispatch_io_before_deadline() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    let event = job_event(&c, job);
    let fence = c.claim(TENANT, job, 10, 20).unwrap();
    c.transition(
        TENANT,
        fence,
        Transition::Checkpoint {
            expected: 0,
            next: 3,
            inventory_ref: "lost-final-attempt".into(),
        },
        10,
        auth.as_ref(),
    )
    .unwrap();
    time.0.set(21);
    let before = io.order.len();
    assert_eq!(
        run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &budget(),
            time.as_ref(),
            &rules,
            &MockQualification,
            auth.as_ref()
        )
        .await,
        Err(Failure::Admission)
    );
    assert_eq!(before, io.order.len());
    assert_eq!(c.job(TENANT, job).unwrap().checkpoint, 3);
    time.0.set(500);
    assert_eq!(
        run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &budget(),
            time.as_ref(),
            &rules,
            &MockQualification,
            auth.as_ref()
        )
        .await,
        Err(Failure::Catalogue(Error::Expired))
    );
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Expired);
}

#[tokio::test]
async fn old_cleanup_cannot_erase_new_attempt_staging() {
    let (mut c, mut io, _, time, auth, _) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    let job = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
    let mut old = Work {
        tenant: TENANT,
        event: job_event(&c, job),
        job: c.job(TENANT, job).unwrap(),
        metadata: c.generation(TENANT, GENERATION).unwrap().metadata,
        retained_location: None,
        inventory_ref: "interleaved-attempts".into(),
        attempt: 1,
        claim_until: 20,
        budget: budget(),
    };
    let fence = c.claim(TENANT, job, 11, 20).unwrap();
    c.transition(
        TENANT,
        fence.clone(),
        Transition::Checkpoint {
            expected: 0,
            next: 1,
            inventory_ref: old.inventory_ref.clone(),
        },
        11,
        auth.as_ref(),
    )
    .unwrap();
    io.retrieve(&old).await.unwrap();
    let mut new = old.clone();
    new.attempt = 2;
    new.claim_until = 40;
    c.claim(TENANT, job, 21, 40).unwrap();
    io.retrieve(&new).await.unwrap();
    for work in [&old, &new] {
        let scratch = io.scratch.entry(allocation(work)).or_default();
        scratch.begin(io.fixture.key(), &mut io.trace);
        scratch.append(io.fixture.key(), b"attempt-local partial", &mut io.trace);
    }
    // Even a malformed caller snapshot must not affect the allocation key.
    old.job.checkpoint = 2;
    io.cleanup_incomplete(&old).await.unwrap();
    assert!(!io.scratch.contains_key(&allocation(&old)));
    assert!(io.scratch.contains_key(&allocation(&new)));
    assert!(io.pending.contains_key(&allocation(&new)));
    let copy = io.complete_restore(&new).await.unwrap();
    assert_eq!(io.copies[&copy.location], io.fixture.bytes());
    assert_eq!(
        c.transition(
            TENANT,
            fence,
            Transition::PublishRestore { copy },
            21,
            auth.as_ref()
        ),
        Err(Error::Fenced)
    );
}

#[tokio::test]
async fn upload_rejects_unverified_or_unsupported_checksums_before_commit() {
    for invalid in 0..4 {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let mut upload = io.upload();
        // Keep a valid assertion first: every checksum must be checked.
        let mut checksum = upload.metadata.checksums[0].clone();
        match invalid {
            0 => checksum.value[0] ^= 1,
            1 => checksum.algorithm = "unsupported".into(),
            2 => checksum.kind = ChecksumType::Composite,
            3 => checksum.parts.push(checksum.value.clone()),
            _ => unreachable!(),
        }
        upload.metadata.checksums.push(checksum);
        let time = Time(Cell::new(10));
        let auth = Auth::default();
        assert_eq!(
            ingest(
                &mut c,
                &mut io,
                &upload,
                &budget(),
                &time,
                &Rules::default(),
                &auth,
            )
            .await,
            Err(Failure::Io(IoError::Integrity))
        );
        assert_eq!(
            c.reconcile(TENANT, upload.intent, &auth).unwrap(),
            Reconciliation::Applied(Outcome::UploadIntent(upload.intent))
        );
        assert_eq!(
            c.reconcile(TENANT, upload.commit, &auth).unwrap(),
            Reconciliation::Absent
        );
        assert!(c.lookup(TENANT, "object", 10, &auth).is_err());
        assert!(c.generation(TENANT, GENERATION).is_err());
        assert!(c.outbox(TENANT).is_empty());
        assert!(io.copies.is_empty());
        assert!(!io.order.contains(&"upload-complete"));
        assert!(!io.order.contains(&"cleanup-incomplete"));

        // A rejected retry also leaves previously retained safety bytes intact.
        let retained = io.stage_upload(&io.upload(), &budget(), 110).await.unwrap();
        let allocation = io.copies[&retained.location].as_ptr();
        assert_eq!(
            ingest(
                &mut c,
                &mut io,
                &upload,
                &budget(),
                &time,
                &Rules::default(),
                &auth,
            )
            .await,
            Err(Failure::Io(IoError::Integrity))
        );
        assert_eq!(io.copies[&retained.location], io.fixture.bytes());
        assert_eq!(io.copies[&retained.location].as_ptr(), allocation);
        assert_eq!(io.copies.len(), 1);
        assert!(c.outbox(TENANT).is_empty());
        assert!(!io.order.contains(&"cleanup-incomplete"));
    }
}

#[tokio::test]
async fn delivery_uses_published_version_after_an_unpublished_completion() {
    for expired in [false, true] {
        for missing in [false, true] {
            let (mut c, mut io, _, time, auth, rules) = archived().await;
            evict(&mut c, &mut io, &time, auth.as_ref());
            c.transact(
                TENANT,
                OperationId(900),
                Mutation::Link {
                    source: "object".into(),
                    destination: "other".into(),
                    expected_revision: 0,
                },
                11,
                auth.as_ref(),
            )
            .unwrap();
            let first = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
            let second = request(&mut c, "other", 1001, 600, 60, 11, auth.as_ref());
            let mut work = Work {
                tenant: TENANT,
                event: job_event(&c, second),
                job: c.job(TENANT, second).unwrap(),
                metadata: c.generation(TENANT, GENERATION).unwrap().metadata,
                retained_location: None,
                inventory_ref: "unpublished-second-restore".into(),
                attempt: 1,
                claim_until: 20,
                budget: budget(),
            };
            let fence = c.claim(TENANT, second, 11, 20).unwrap();
            c.transition(
                TENANT,
                fence.clone(),
                Transition::Checkpoint {
                    expected: 0,
                    next: 1,
                    inventory_ref: work.inventory_ref.clone(),
                },
                11,
                auth.as_ref(),
            )
            .unwrap();
            run(&mut c, &mut io, first, &time, &rules, auth.as_ref())
                .await
                .unwrap();
            let published = c
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .unwrap();
            let serving = pin(&mut c, "object", 1002, 11, auth.as_ref()).unwrap();
            // B retains its earlier cold snapshot despite A's publication.
            work.job = c.job(TENANT, second).unwrap();
            io.retrieve(&work).await.unwrap();
            let unpublished = io.complete_restore(&work).await.unwrap();
            assert_ne!(published, unpublished.location);
            let now = if expired { 20 } else { 11 };
            if !expired {
                auth.denied.borrow_mut().insert("other".into());
            }
            assert!(c
                .transition(
                    TENANT,
                    fence,
                    Transition::PublishRestore {
                        copy: unpublished.clone()
                    },
                    now,
                    auth.as_ref(),
                )
                .is_err());
            if missing {
                io.copies.remove(&unpublished.location).unwrap();
            } else {
                io.copies.get_mut(&unpublished.location).unwrap()[0] ^= 1;
            }
            assert_eq!(
                c.generation(TENANT, GENERATION).unwrap().cache_location,
                Some(published.clone())
            );
            assert_eq!(
                io.deliver(&c, serving, now, auth.as_ref()).unwrap(),
                io.copies[&published]
            );
            assert_eq!(io.copies[&published], io.fixture.bytes());
        }
    }
}

#[tokio::test]
async fn completed_restore_survives_lost_publication_without_replacement() {
    for cold in [false, true] {
        for corrupt in [false, true] {
            let (mut c, mut io, _, time, auth, rules) = archived().await;
            if cold {
                evict(&mut c, &mut io, &time, auth.as_ref());
            }
            let now = time.0.get();
            let job = request(&mut c, "object", 1000, 500, 40, now, auth.as_ref());
            let work = Work {
                tenant: TENANT,
                event: job_event(&c, job),
                job: c.job(TENANT, job).unwrap(),
                metadata: c.generation(TENANT, GENERATION).unwrap().metadata,
                retained_location: c.generation(TENANT, GENERATION).unwrap().cache_location,
                inventory_ref: "completed-before-worker-loss".into(),
                attempt: 1,
                claim_until: 20,
                budget: budget(),
            };
            let stale = c.claim(TENANT, job, now, 20).unwrap();
            c.transition(
                TENANT,
                stale.clone(),
                Transition::Checkpoint {
                    expected: 0,
                    next: 1,
                    inventory_ref: work.inventory_ref.clone(),
                },
                now,
                auth.as_ref(),
            )
            .unwrap();
            io.retrieve(&work).await.unwrap();
            let completed = io.complete_restore(&work).await.unwrap();
            if corrupt {
                io.copies.get_mut(&completed.location).unwrap()[0] ^= 1;
            }
            let original = io.copies[&completed.location].clone();
            let allocation = io.copies[&completed.location].as_ptr();
            let installs = io.order.iter().filter(|e| **e == "cache-install").count();
            time.0.set(21);
            assert_eq!(
                c.transition(
                    TENANT,
                    stale,
                    Transition::PublishRestore {
                        copy: completed.clone()
                    },
                    21,
                    auth.as_ref(),
                ),
                Err(Error::Fenced)
            );
            // A completed immutable inventory entry must be checked before
            // attempting ARTICLE, including when its bytes are corrupt.
            io.inject = Injection::RepairFailure;
            let retrievals = io.order.iter().filter(|e| **e == "engine-retrieve").count();
            let result = run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await;
            assert_eq!(
                io.order.iter().filter(|e| **e == "engine-retrieve").count(),
                retrievals
            );
            if corrupt {
                assert_eq!(result, Err(Failure::Io(IoError::Integrity)));
                assert!(pin(&mut c, "object", 1001, 21, auth.as_ref()).is_err());
            } else {
                result.unwrap();
                let serving = pin(&mut c, "object", 1001, 21, auth.as_ref()).unwrap();
                assert_eq!(
                    io.deliver(&c, serving, 21, auth.as_ref()).unwrap(),
                    original
                );
            }
            assert_eq!(io.copies[&completed.location], original);
            assert_eq!(io.copies[&completed.location].as_ptr(), allocation);
            assert_eq!(
                io.order.iter().filter(|e| **e == "cache-install").count(),
                installs
            );
            assert_eq!(c.job(TENANT, job).unwrap().checkpoint, 2);
            assert_eq!(io.copies.len(), 1);
        }
    }
}

#[tokio::test]
async fn missing_recorded_completion_is_not_silently_refetched() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    let job = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
    io.expire_at_complete = Some(time.clone());
    assert_eq!(
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await,
        Err(Failure::Catalogue(Error::Expired))
    );
    let completed = io.completed.values().next().unwrap().clone();
    io.copies.remove(&completed).unwrap();
    io.expire_at_complete = None;
    let retrievals = io.order.iter().filter(|e| **e == "engine-retrieve").count();
    assert_eq!(
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await,
        Err(Failure::Io(IoError::Integrity))
    );
    assert_eq!(
        io.order.iter().filter(|e| **e == "engine-retrieve").count(),
        retrievals
    );
    assert!(io.copies.is_empty());
    assert!(pin(&mut c, "object", 1001, time.0.get(), auth.as_ref()).is_err());
}

#[tokio::test]
async fn unrecorded_physical_presence_cannot_authorize_recovery() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    io.copies
        .insert("unrecorded-orphan".into(), io.fixture.bytes().to_vec());
    io.inject = Injection::RepairFailure;
    let job = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
    assert_eq!(
        run(&mut c, &mut io, job, &time, &rules, auth.as_ref()).await,
        Err(Failure::Io(IoError::RepairUnavailable))
    );
    assert!(!io.order.contains(&"verify-winning-cache"));
    assert!(pin(&mut c, "object", 1001, 11, auth.as_ref()).is_err());
}

#[tokio::test]
async fn upload_invocation_expiry_prevents_commit_but_retains_completed_bytes() {
    let mut c = MemoryCatalogue::default();
    let mut io = Io::new(1).await;
    let upload = io.upload();
    let time = Rc::new(Time(Cell::new(10)));
    io.expire_at_upload = Some(time.clone());
    let auth = Auth::default();
    assert_eq!(
        ingest(
            &mut c,
            &mut io,
            &upload,
            &budget(),
            time.as_ref(),
            &Rules::default(),
            &auth
        )
        .await,
        Err(Failure::Admission)
    );
    assert_eq!(time.0.get(), 110, "invocation limit, not archive deadline");
    assert_eq!(io.copies.len(), 1);
    assert!(c.outbox(TENANT).is_empty());
    assert_eq!(
        c.reconcile(TENANT, upload.commit, &auth).unwrap(),
        Reconciliation::Absent
    );
}

#[tokio::test]
async fn completed_upload_survives_lost_commit_without_replacement() {
    for empty_checksums in [false, true] {
        for corrupt in [false, true] {
            let mut c = MemoryCatalogue::default();
            let mut io = Io::new(1).await;
            let mut upload = io.upload();
            if empty_checksums {
                upload.metadata.checksums.clear();
            }
            let time = Rc::new(Time(Cell::new(10)));
            let auth = Auth::default();
            let rules = Rules::default();
            io.expire_at_upload = Some(time.clone());
            assert_eq!(
                ingest(
                    &mut c,
                    &mut io,
                    &upload,
                    &budget(),
                    time.as_ref(),
                    &rules,
                    &auth,
                )
                .await,
                Err(Failure::Admission)
            );
            assert_eq!(time.0.get(), 110);
            assert_eq!(io.copies.len(), 1);
            let location = io.copies.keys().next().unwrap().clone();
            if corrupt {
                io.copies.get_mut(&location).unwrap()[0] ^= 1;
            }
            let original = io.copies[&location].clone();
            let allocation = io.copies[&location].as_ptr();
            io.expire_at_upload = None;
            let result = ingest(
                &mut c,
                &mut io,
                &upload,
                &budget(),
                time.as_ref(),
                &rules,
                &auth,
            )
            .await;
            if corrupt {
                assert_eq!(result, Err(Failure::Io(IoError::Integrity)));
                assert_eq!(
                    c.reconcile(TENANT, upload.intent, &auth).unwrap(),
                    Reconciliation::Applied(Outcome::UploadIntent(upload.intent))
                );
                assert_eq!(
                    c.reconcile(TENANT, upload.commit, &auth).unwrap(),
                    Reconciliation::Absent
                );
                assert!(c.lookup(TENANT, "object", 110, &auth).is_err());
                assert!(c.generation(TENANT, GENERATION).is_err());
                assert!(c.outbox(TENANT).is_empty());
                assert_eq!(
                    io.order.iter().filter(|e| **e == "upload-complete").count(),
                    1
                );
            } else {
                let committed = result.unwrap();
                let archive = commit_job(committed.clone());
                assert_eq!(c.job(TENANT, archive).unwrap().checkpoint, 0);
                assert_eq!(c.outbox(TENANT).len(), 1);
                assert_eq!(
                    ingest(
                        &mut c,
                        &mut io,
                        &upload,
                        &budget(),
                        time.as_ref(),
                        &rules,
                        &auth,
                    )
                    .await
                    .unwrap(),
                    committed
                );
                assert_eq!(c.outbox(TENANT).len(), 1);
                assert_eq!(
                    c.generation(TENANT, GENERATION).unwrap().cache_location,
                    Some(location.clone())
                );
            }
            assert_eq!(io.copies[&location], original);
            assert_eq!(io.copies[&location].as_ptr(), allocation);
            assert_eq!(io.copies.len(), 1);
            assert!(!io.order.contains(&"cleanup-incomplete"));
            assert!(pin(&mut c, "object", 1000, 110, &auth).is_err());
        }
    }
}

#[tokio::test]
async fn worker_interruption_preserves_archive_and_needed_restore_retries() {
    let mut c = MemoryCatalogue::default();
    let mut io = Io::new(1).await;
    let upload = io.upload();
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    let auth = Auth::default();
    let archive = commit_job(
        ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
            .await
            .unwrap(),
    );
    rules.cancelled.set(true);
    assert_eq!(
        run(&mut c, &mut io, archive, &time, &rules, &auth).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(c.job(TENANT, archive).unwrap().checkpoint, 0);
    assert_eq!(c.job(TENANT, archive).unwrap().state, JobState::Queued);
    rules.cancelled.set(false);
    io.inject = Injection::Interrupted;
    assert_eq!(
        run(&mut c, &mut io, archive, &time, &rules, &auth).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(
        c.job(TENANT, archive).unwrap().state,
        JobState::RetryWait { not_before: 12 }
    );
    assert_eq!(io.copies.len(), 1);
    time.0.set(12);
    io.inject = Injection::None;
    run(&mut c, &mut io, archive, &time, &rules, &auth)
        .await
        .unwrap();
    let restore = request(&mut c, "object", 1000, 500, 50, 12, &auth);
    rules.cancelled.set(true);
    assert_eq!(
        run(&mut c, &mut io, restore, &time, &rules, &auth).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(c.job(TENANT, restore).unwrap().checkpoint, 0);
    rules.cancelled.set(false);
    io.inject = Injection::Interrupted;
    assert_eq!(
        run(&mut c, &mut io, restore, &time, &rules, &auth).await,
        Err(Failure::Io(IoError::Cancelled))
    );
    assert_eq!(
        c.job(TENANT, restore).unwrap().state,
        JobState::RetryWait { not_before: 14 }
    );
    time.0.set(14);
    io.inject = Injection::None;
    run(&mut c, &mut io, restore, &time, &rules, &auth)
        .await
        .unwrap();
    assert!(pin(&mut c, "object", 1001, 14, &auth).is_ok());
}

// Inject a competing publication after the caller's generation snapshot. Bulk
// outbox access panics so these worker tests also enforce bounded event lookup.
#[derive(Clone, Copy)]
enum BoundaryDrift {
    Moderation,
    Prohibited,
    Fence,
}
struct TerminalClock {
    committed: Rc<Cell<bool>>,
    lose_ack: bool,
    now: u64,
    deadline: u64,
}
impl Clock for TerminalClock {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        if self.committed.get() {
            if self.lose_ack {
                Ok(self.deadline)
            } else {
                Err(Error::Uncertain)
            }
        } else {
            Ok(self.now)
        }
    }
}
struct InterleavedCatalogue {
    terminal: Option<(Rc<Cell<bool>>, bool)>,
    drift: Option<(Rc<Cell<bool>>, BoundaryDrift)>,
    inner: MemoryCatalogue,
    winner: Option<(Fence, CompleteCopy)>,
    event_reads: Cell<usize>,
}
macro_rules! forward_job {
    (read $name:ident ($($arg:ident: $ty:ty),*) -> $out:ty) => {
        fn $name(&self, $($arg: $ty),*) -> $out { self.inner.$name($($arg),*) }
    };
    (write $name:ident ($($arg:ident: $ty:ty),*) -> $out:ty) => {
        fn $name(&mut self, $($arg: $ty),*) -> $out { self.inner.$name($($arg),*) }
    };
}
impl JobPort for InterleavedCatalogue {
    fn outbox(&self, _: TenantId) -> Vec<OutboxEvent> {
        panic!("worker must not materialize tenant backlog")
    }
    fn outbox_event(
        &self,
        tenant: TenantId,
        event: EventId,
    ) -> qerith_core::catalogue::Result<OutboxEvent> {
        self.event_reads.set(self.event_reads.get() + 1);
        self.inner.outbox_event(tenant, event)
    }
    forward_job!(read job(tenant: TenantId, job: JobId) -> qerith_core::catalogue::Result<JobView>);
    forward_job!(read generation(tenant: TenantId, generation: GenerationId) -> qerith_core::catalogue::Result<GenerationView>);
    forward_job!(write retire_upload_intent(tenant: TenantId, intent: OperationId, now: u64) -> qerith_core::catalogue::Result<()>);
    forward_job!(write claim(tenant: TenantId, job: JobId, now: u64, until: u64) -> qerith_core::catalogue::Result<Fence>);
    forward_job!(write expire_job(tenant: TenantId, job: JobId, now: u64) -> qerith_core::catalogue::Result<()>);
    forward_job!(write cancel_unneeded_restore(tenant: TenantId, job: JobId, now: u64, authority: &dyn Authority) -> qerith_core::catalogue::Result<()>);
    fn transition(
        &mut self,
        tenant: TenantId,
        fence: Fence,
        transition: Transition,
        now: u64,
        authority: &dyn Authority,
    ) -> qerith_core::catalogue::Result<()> {
        if self.drift.as_ref().is_some_and(|(signal, _)| signal.get()) {
            let (_, drift) = self.drift.take().unwrap();
            let generation = self.inner.job(tenant, fence.job)?.generation;
            match drift {
                BoundaryDrift::Moderation | BoundaryDrift::Prohibited => {
                    self.inner.set_moderation(
                        tenant,
                        generation,
                        1,
                        matches!(drift, BoundaryDrift::Prohibited),
                    )?
                }
                BoundaryDrift::Fence => self.inner.transition(
                    tenant,
                    fence.clone(),
                    Transition::FailUnrecoverable,
                    now,
                    authority,
                )?,
            }
        }
        if matches!(transition, Transition::PublishRestore { .. }) {
            if let Some((winner, copy)) = self.winner.take() {
                self.inner.transition(
                    tenant,
                    winner,
                    Transition::PublishRestore { copy },
                    now,
                    authority,
                )?;
            }
        }
        let terminal = matches!(
            transition,
            Transition::PublishRestore { .. } | Transition::CompleteArchive
        );
        self.inner
            .transition(tenant, fence, transition, now, authority)?;
        if terminal {
            if let Some((committed, lose_ack)) = self.terminal.take() {
                committed.set(true);
                if lose_ack {
                    return Err(Error::Uncertain);
                }
            }
        }
        Ok(())
    }
    forward_job!(write record_verification(tenant: TenantId, evidence: VerificationEvidence, independence: IndependenceEvidence, now: u64) -> qerith_core::catalogue::Result<()>);
    forward_job!(write set_safety_hold(tenant: TenantId, generation: GenerationId, hold: bool) -> qerith_core::catalogue::Result<()>);
    forward_job!(write set_moderation(tenant: TenantId, generation: GenerationId, epoch: u64, prohibited: bool) -> qerith_core::catalogue::Result<()>);
    forward_job!(read candidate(tenant: TenantId, generation: GenerationId, kind: DeletionKind, now: u64, not_before: u64, authority: &dyn Authority) -> qerith_core::catalogue::Result<DeletionCandidate>);
    forward_job!(write finalize_deletion(candidate: DeletionCandidate, now: u64, authority: &dyn Authority) -> qerith_core::catalogue::Result<EventId>);
    forward_job!(write dispatch_deletion(tenant: TenantId, event: EventId, now: u64, authority: &dyn Authority) -> qerith_core::catalogue::Result<DeletionDispatch>);
    forward_job!(write cancel_deletion(tenant: TenantId, event: EventId) -> qerith_core::catalogue::Result<()>);
    forward_job!(write reconcile_retained_deletion(tenant: TenantId, event: EventId, retained: CompleteCopy, settlement_ref: String, now: u64) -> qerith_core::catalogue::Result<()>);
    forward_job!(write acknowledge_deletion(tenant: TenantId, event: EventId) -> qerith_core::catalogue::Result<()>);
}

#[tokio::test]
async fn terminal_success_and_uncertainty_survive_post_commit_clock_faults() {
    for archive in [false, true] {
        for lose_ack in [false, true] {
            let (mut c, mut io, _, time, auth, rules) = archived().await;
            let job = if archive {
                let mut newer = Io::new(2).await;
                let upload = newer.upload();
                let job = commit_job(
                    ingest(
                        &mut c,
                        &mut newer,
                        &upload,
                        &budget(),
                        time.as_ref(),
                        &rules,
                        auth.as_ref(),
                    )
                    .await
                    .unwrap(),
                );
                io = newer;
                job
            } else {
                request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref())
            };
            let event = job_event(&c, job);
            let committed = Rc::new(Cell::new(false));
            let clock = TerminalClock {
                committed: committed.clone(),
                lose_ack,
                now: 10,
                deadline: c.job(TENANT, job).unwrap().deadline,
            };
            let mut c = InterleavedCatalogue {
                inner: c,
                terminal: Some((committed.clone(), lose_ack)),
                drift: None,
                winner: None,
                event_reads: Cell::new(0),
            };
            assert_eq!(
                run_once(
                    &mut c,
                    &mut io,
                    TENANT,
                    event,
                    &budget(),
                    &clock,
                    &rules,
                    &MockQualification,
                    auth.as_ref()
                )
                .await,
                if lose_ack {
                    Err(Failure::Catalogue(Error::Uncertain))
                } else {
                    Ok(())
                }
            );
            assert!(committed.get());
            assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
            assert!(c.inner.outbox(TENANT).is_empty());
            assert!(!io.order.contains(&"cleanup-incomplete"));
            assert_eq!(io.copies.len(), 1);
        }
    }
}

#[tokio::test]
async fn catalogue_drift_stops_at_next_io_boundary() {
    for archive in [false, true] {
        for drift in [
            BoundaryDrift::Moderation,
            BoundaryDrift::Prohibited,
            BoundaryDrift::Fence,
        ] {
            let (mut c, mut io, _, time, auth, rules) = archived().await;
            let job = if archive {
                let mut newer = Io::new(2).await;
                let upload = newer.upload();
                let job = commit_job(
                    ingest(
                        &mut c,
                        &mut newer,
                        &upload,
                        &budget(),
                        time.as_ref(),
                        &rules,
                        auth.as_ref(),
                    )
                    .await
                    .unwrap(),
                );
                io = newer;
                job
            } else {
                evict(&mut c, &mut io, &time, auth.as_ref());
                request(&mut c, "object", 1000, 500, 40, time.0.get(), auth.as_ref())
            };
            let event = job_event(&c, job);
            let signal = Rc::new(Cell::new(false));
            let after_io = signal.clone();
            io.after_io = Some(Box::new(move |_| after_io.set(true)));
            io.order.clear();
            let mut c = InterleavedCatalogue {
                drift: Some((signal, drift)),
                terminal: None,
                inner: c,
                winner: None,
                event_reads: Cell::new(0),
            };
            assert_eq!(
                run_once(
                    &mut c,
                    &mut io,
                    TENANT,
                    event,
                    &budget(),
                    time.as_ref(),
                    &rules,
                    &MockQualification,
                    auth.as_ref()
                )
                .await,
                Err(Failure::Catalogue(
                    if matches!(drift, BoundaryDrift::Fence) {
                        Error::Fenced
                    } else {
                        Error::Unavailable
                    }
                ))
            );
            assert!(c.drift.is_none());
            assert!(!io.order.contains(&"whole-generation-check"));
            assert!(!io.order.contains(&"engine-verify-pair"));
            assert_ne!(c.job(TENANT, job).unwrap().state, JobState::Complete);
        }
    }
}

#[tokio::test]
async fn competing_cold_restores_reconcile_verified_winner_with_one_attempt() {
    for corrupt_winner in [false, true] {
        let (mut c, mut io, _, time, auth, rules) = archived().await;
        evict(&mut c, &mut io, &time, auth.as_ref());
        c.transact(
            TENANT,
            OperationId(900),
            Mutation::Link {
                source: "object".into(),
                destination: "other".into(),
                expected_revision: 0,
            },
            11,
            auth.as_ref(),
        )
        .unwrap();
        let first = request(&mut c, "object", 1000, 500, 40, 11, auth.as_ref());
        let second = request(&mut c, "other", 1001, 600, 60, 11, auth.as_ref());
        assert_ne!(first, second);
        let work = Work {
            tenant: TENANT,
            event: job_event(&c, first),
            job: c.job(TENANT, first).unwrap(),
            metadata: c.generation(TENANT, GENERATION).unwrap().metadata,
            retained_location: None,
            inventory_ref: "first-cold-restore".into(),
            attempt: 1,
            claim_until: 111,
            budget: budget(),
        };
        let fence = c.claim(TENANT, first, 11, 111).unwrap();
        c.transition(
            TENANT,
            fence.clone(),
            Transition::Checkpoint {
                expected: 0,
                next: 1,
                inventory_ref: work.inventory_ref.clone(),
            },
            11,
            auth.as_ref(),
        )
        .unwrap();
        io.retrieve(&work).await.unwrap();
        let winner = io.complete_restore(&work).await.unwrap();
        if corrupt_winner {
            io.copies.get_mut(&winner.location).unwrap()[0] ^= 1;
        }
        let event = job_event(&c, second);
        let mut c = InterleavedCatalogue {
            drift: None,
            terminal: None,
            inner: c,
            winner: Some((fence, winner.clone())),
            event_reads: Cell::new(0),
        };
        assert_eq!(
            c.generation(TENANT, GENERATION).unwrap().cache_location,
            None
        );
        let single = Budget::new(4096, 3, 1, 100).unwrap();
        let result = run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &single,
            time.as_ref(),
            &rules,
            &MockQualification,
            auth.as_ref(),
        )
        .await;
        assert_eq!(c.event_reads.get(), 1);
        assert_eq!(
            c.generation(TENANT, GENERATION).unwrap().cache_location,
            Some(winner.location.clone())
        );
        assert_eq!(
            io.copies.len(),
            2,
            "losing completed copy requires separate orphan reconciliation"
        );
        assert!(io.order.contains(&"verify-winning-cache"));
        assert_eq!(c.job(TENANT, second).unwrap().checkpoint, 1);
        if corrupt_winner {
            assert_eq!(result, Err(Failure::Io(IoError::Integrity)));
            assert!(pin(&mut c.inner, "other", 1002, 11, auth.as_ref()).is_err());
        } else {
            result.unwrap();
            assert_eq!(c.job(TENANT, first).unwrap().state, JobState::Complete);
            assert_eq!(c.job(TENANT, second).unwrap().state, JobState::Complete);
            let pin = pin(&mut c.inner, "other", 1002, 11, auth.as_ref()).unwrap();
            assert_eq!(
                io.deliver(&c.inner, pin, 11, auth.as_ref()).unwrap(),
                io.fixture.bytes()
            );
            assert_eq!(
                c.generation(TENANT, GENERATION).unwrap().cache_location,
                Some(winner.location)
            );
        }
    }
}

#[tokio::test]
async fn backlog_lookup_is_event_scoped_even_before_failed_admission() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let mut job = None;
    for n in 0..200 {
        job = Some(request(
            &mut c,
            "object",
            1000 + n,
            1000 + n,
            40,
            10,
            auth.as_ref(),
        ));
    }
    assert_eq!(c.outbox(TENANT).len(), 200);
    let event = job_event(&c, job.unwrap());
    assert_eq!(c.outbox_event(TenantId(2), event), Err(Error::Unavailable));
    assert_eq!(
        c.outbox_event(TENANT, EventId(u64::MAX)),
        Err(Error::Unavailable)
    );
    let mut c = InterleavedCatalogue {
        drift: None,
        terminal: None,
        inner: c,
        winner: None,
        event_reads: Cell::new(0),
    };
    rules.deny.set(true);
    assert_eq!(
        run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &budget(),
            time.as_ref(),
            &rules,
            &MockQualification,
            auth.as_ref()
        )
        .await,
        Err(Failure::Admission)
    );
    assert_eq!(c.event_reads.get(), 1);
}

struct FrozenQualification(Qualification);
impl Qualifier for FrozenQualification {
    fn qualify(
        &self,
        _: &Work,
        _: &[Reconstruction; 2],
        _: u64,
    ) -> qerith_core::catalogue::Result<Qualification> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn partial_and_complete_proof_pair_replay_survives_lost_worker() {
    for recorded in [1, 2] {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let upload = io.upload();
        let time = Time(Cell::new(10));
        let rules = Rules::default();
        let auth = Auth::default();
        let archive = commit_job(
            ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
                .await
                .unwrap(),
        );
        let event = job_event(&c, archive);
        let work = Work {
            tenant: TENANT,
            event,
            job: c.job(TENANT, archive).unwrap(),
            metadata: upload.metadata.clone(),
            retained_location: c.generation(TENANT, GENERATION).unwrap().cache_location,
            inventory_ref: "recoverable-lost-worker".into(),
            attempt: 1,
            claim_until: 110,
            budget: budget(),
        };
        let fence = c.claim(TENANT, archive, 10, 110).unwrap();
        c.transition(
            TENANT,
            fence,
            Transition::Checkpoint {
                expected: 0,
                next: 1,
                inventory_ref: work.inventory_ref.clone(),
            },
            10,
            &auth,
        )
        .unwrap();
        io.post(&work).await.unwrap();
        let retrieved = io.verify_archive(&work).await.unwrap();
        let pair = MockQualification.qualify(&work, &retrieved, 10).unwrap();
        for proof in pair.verification.iter().take(recorded) {
            c.record_verification(TENANT, proof.clone(), pair.independence.clone(), 10)
                .unwrap();
        }
        // Same timestamp but different authenticated content is not an idempotent replay.
        let mut changed = pair.verification[0].clone();
        changed.readability_ref.push_str("-different");
        assert_eq!(
            c.record_verification(TENANT, changed, pair.independence.clone(), 111),
            Err(Error::Conflict)
        );
        let mut changed_attribution = pair.independence.clone();
        changed_attribution.decision_ref.push_str("-different");
        assert_eq!(
            c.record_verification(
                TENANT,
                pair.verification[0].clone(),
                changed_attribution,
                111
            ),
            Err(Error::Conflict)
        );
        assert_eq!(
            c.record_verification(
                TENANT,
                pair.verification[0].clone(),
                pair.independence.clone(),
                pair.verification[0].valid_until
            ),
            Err(Error::Unsafe)
        );
        time.0.set(111);
        run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &budget(),
            &time,
            &rules,
            &FrozenQualification(pair),
            &auth,
        )
        .await
        .unwrap();
        assert_eq!(c.job(TENANT, archive).unwrap().state, JobState::Complete);
        assert_eq!(c.job(TENANT, archive).unwrap().checkpoint, 2);
    }
}

#[tokio::test]
async fn failed_and_uncertain_commit_are_not_success_or_cleanup_permission() {
    for apply_before_error in [false, true] {
        let mut c = CommitFault {
            inner: MemoryCatalogue::default(),
            apply_before_error,
        };
        let mut io = Io::new(1).await;
        let upload = io.upload();
        let time = Time(Cell::new(10));
        let auth = Auth::default();
        let rules = Rules::default();
        let result = ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth).await;
        assert_eq!(
            result,
            Err(Failure::Catalogue(if apply_before_error {
                Error::Uncertain
            } else {
                Error::Conflict
            }))
        );
        assert_eq!(
            io.copies.len(),
            1,
            "complete retained source survives unknown commit"
        );
        assert!(!io.order.contains(&"cleanup-incomplete"));
        assert!(pin(&mut c, "object", 500, 10, &auth).is_err());
        let reconciled = c.reconcile(TENANT, upload.commit, &auth).unwrap();
        if apply_before_error {
            assert!(matches!(
                reconciled,
                Reconciliation::Applied(Outcome::Committed { .. })
            ));
            assert_eq!(c.inner.outbox(TENANT).len(), 1);
        } else {
            assert_eq!(reconciled, Reconciliation::Absent);
            assert!(c.lookup(TENANT, "object", 10, &auth).is_err());
            assert!(c.inner.outbox(TENANT).is_empty());
        }
    }
}

#[tokio::test]
async fn missing_corrupt_or_unavailable_archive_proof_keeps_week_old_safety() {
    for fault in [Fault::Missing(1), Fault::Corrupt(1), Fault::Unavailable] {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let time = Time(Cell::new(10));
        let auth = Auth::default();
        let rules = Rules::default();
        let upload = io.upload();
        let job = commit_job(
            ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
                .await
                .unwrap(),
        );
        io.fault = fault;
        assert!(run(&mut c, &mut io, job, &time, &rules, &auth)
            .await
            .is_err());
        time.0.set(WEEK + 10);
        assert!(c
            .candidate(
                TENANT,
                GENERATION,
                DeletionKind::DeliveryCache,
                WEEK + 10,
                WEEK + 11,
                &auth
            )
            .is_err());
        assert_eq!(io.copies.values().next().unwrap(), io.fixture.bytes());
        assert!(pin(&mut c, "object", 500, WEEK + 10, &auth).is_err());
    }
}

#[tokio::test]
async fn bounded_retries_keep_inventory_and_never_restart_after_attempt_cap() {
    let mut c = MemoryCatalogue::default();
    let mut io = Io::new(1).await;
    let time = Time(Cell::new(10));
    let auth = Auth::default();
    let rules = Rules::default();
    let upload = io.upload();
    let job = commit_job(
        ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
            .await
            .unwrap(),
    );
    io.inject = Injection::Uncertain;
    for n in 1..=3 {
        assert!(run(&mut c, &mut io, job, &time, &rules, &auth)
            .await
            .is_err());
        assert_eq!(c.job(TENANT, job).unwrap().checkpoint, n);
        if n < 3 {
            assert_eq!(
                c.job(TENANT, job).unwrap().state,
                JobState::RetryWait {
                    not_before: time.0.get() + 2
                }
            );
        }
        time.0.set(time.0.get() + 2);
    }
    assert_eq!(
        c.job(TENANT, job).unwrap().state,
        JobState::FailedUnrecoverable
    );
    assert!(c.outbox(TENANT).is_empty());
    assert_eq!(io.attempts.len(), 3);
    assert!(io.attempts.iter().all(|a| a.0 == io.attempts[0].0));
    assert!(!io.order.contains(&"cleanup-incomplete"));
    assert_eq!(io.copies.len(), 1);
}

#[tokio::test]
async fn differing_subscriber_deadlines_never_silently_extend_a_physical_job() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    c.transact(
        TENANT,
        OperationId(900),
        Mutation::Link {
            source: "object".into(),
            destination: "other".into(),
            expected_revision: 0,
        },
        10,
        auth.as_ref(),
    )
    .unwrap();
    let short = request(&mut c, "object", 1000, 20, 40, 10, auth.as_ref());
    let long = request(&mut c, "other", 1001, 500, 60, 10, auth.as_ref());
    assert_ne!(short, long);
    time.0.set(20);
    assert!(run(&mut c, &mut io, short, &time, &rules, auth.as_ref())
        .await
        .is_err());
    run(&mut c, &mut io, long, &time, &rules, auth.as_ref())
        .await
        .unwrap();
    assert!(pin(&mut c, "object", 1002, 20, auth.as_ref()).is_err());
    assert!(pin(&mut c, "other", 1003, 20, auth.as_ref()).is_ok());
}

#[tokio::test]
async fn cold_restore_coalesces_twenty_scoped_subscribers_before_delivery() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let original = c
        .lookup(TENANT, "object", 10, auth.as_ref())
        .unwrap()
        .metadata;
    assert_eq!(
        io.trace
            .0
            .iter()
            .filter(|e| matches!(e, Event::RepairPosted(_)))
            .count(),
        6,
        "engine POST actually executed"
    );
    assert_eq!(
        &io.order[..4],
        &[
            "upload-stage",
            "upload-complete",
            "engine-post",
            "engine-verify-pair"
        ]
    );
    evict(&mut c, &mut io, &time, auth.as_ref());
    for n in 0..20 {
        c.transact(
            TENANT,
            OperationId(1000 + n),
            Mutation::Link {
                source: "object".into(),
                destination: format!("subscriber-{n}"),
                expected_revision: 0,
            },
            time.0.get(),
            auth.as_ref(),
        )
        .unwrap();
    }
    let jobs: Vec<_> = (0..20)
        .map(|n| {
            request(
                &mut c,
                &format!("subscriber-{n}"),
                2000 + n,
                500,
                50 + n,
                time.0.get(),
                auth.as_ref(),
            )
        })
        .collect();
    assert!(jobs.iter().all(|j| *j == jobs[0]));
    assert_eq!(c.outbox(TENANT).len(), 1);
    c.transact(
        TENANT,
        OperationId(3000),
        Mutation::CancelSubscription {
            name: "subscriber-0".into(),
            job: jobs[0],
            subscription: OperationId(2000),
        },
        time.0.get(),
        auth.as_ref(),
    )
    .unwrap();
    auth.denied.borrow_mut().insert("subscriber-1".into());
    c.transact(
        TENANT,
        OperationId(3001),
        Mutation::Tombstone {
            name: "subscriber-2".into(),
            expected_revision: 1,
        },
        time.0.get(),
        auth.as_ref(),
    )
    .unwrap();
    assert!(pin(&mut c, "subscriber-3", 3002, time.0.get(), auth.as_ref()).is_err());
    run(&mut c, &mut io, jobs[0], &time, &rules, auth.as_ref())
        .await
        .unwrap();
    io.order.push("catalogue-published");
    assert_eq!(
        &io.order[io.order.len() - 5..],
        &[
            "engine-retrieve",
            "whole-generation-check",
            "cache-install",
            "cache-complete",
            "catalogue-published"
        ]
    );
    assert!(pin(&mut c, "subscriber-0", 4000, time.0.get(), auth.as_ref()).is_err());
    assert!(pin(&mut c, "subscriber-1", 4001, time.0.get(), auth.as_ref()).is_err());
    assert!(pin(&mut c, "subscriber-2", 4002, time.0.get(), auth.as_ref()).is_err());
    for n in 3..20 {
        let view = c
            .lookup(
                TENANT,
                &format!("subscriber-{n}"),
                time.0.get(),
                auth.as_ref(),
            )
            .unwrap();
        assert_eq!(view.metadata, original);
        assert_eq!(view.availability_until, Some(time.0.get() + 50 + n));
        let p = pin(
            &mut c,
            &format!("subscriber-{n}"),
            4000 + n,
            time.0.get(),
            auth.as_ref(),
        )
        .unwrap();
        let bytes = io.deliver(&c, p, time.0.get(), auth.as_ref()).unwrap();
        assert_eq!(bytes, io.fixture.bytes());
        assert_eq!(&bytes[100..900], &io.fixture.bytes()[100..900]);
    }
    // Physical bytes and IDs in the other tenant do not confer logical access.
    assert!(c
        .lookup(TenantId(2), "subscriber-3", time.0.get(), auth.as_ref())
        .is_err());
    assert!(c
        .validate_pin(TenantId(2), PinId(1), time.0.get(), auth.as_ref())
        .is_err());
    let p = pin(&mut c, "subscriber-3", 5000, time.0.get(), auth.as_ref()).unwrap();
    auth.denied.borrow_mut().insert("subscriber-3".into());
    assert!(io.deliver(&c, p, time.0.get(), auth.as_ref()).is_err());
    time.0.set(1000);
    assert!(
        pin(&mut c, "subscriber-4", 5001, 1000, auth.as_ref()).is_err(),
        "lease expiry denies despite completed physical copy"
    );
}

#[tokio::test]
async fn incomplete_or_conflicting_ingest_never_commits_or_grants_a_lease() {
    for injection in [Injection::PartialUpload, Injection::BadReceipt] {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        io.inject = injection;
        let time = Time(Cell::new(10));
        let auth = Auth::default();
        let rules = Rules::default();
        let upload = io.upload();
        assert!(
            ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
                .await
                .is_err()
        );
        assert!(c.lookup(TENANT, "object", 10, &auth).is_err());
        assert!(c.outbox(TENANT).is_empty());
        assert!(pin(&mut c, "object", 500, 10, &auth).is_err());
    }
    let mut c = MemoryCatalogue::default();
    let mut io = Io::new(1).await;
    let time = Time(Cell::new(10));
    let auth = Auth::default();
    let rules = Rules::default();
    let upload = io.upload();
    let first = ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
        .await
        .unwrap();
    assert_eq!(
        ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
            .await
            .unwrap(),
        first
    );
    assert_eq!(c.outbox(TENANT).len(), 1);
    let mut wrong = upload.clone();
    wrong.commit = OperationId(600);
    wrong.metadata.identity.length -= 1;
    assert!(
        ingest(&mut c, &mut io, &wrong, &budget(), &time, &rules, &auth)
            .await
            .is_err()
    );
    assert_eq!(
        c.lookup(TENANT, "object", 10, &auth).unwrap().metadata,
        upload.metadata
    );
}

#[tokio::test]
async fn failed_or_uncertain_archive_retains_safety_after_seven_days() {
    for injection in [
        Injection::SameBackbone,
        Injection::Uncertain,
        Injection::CleanupFailure,
    ] {
        let mut c = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let time = Time(Cell::new(10));
        let auth = Auth::default();
        let rules = Rules::default();
        let upload = io.upload();
        let job = commit_job(
            ingest(&mut c, &mut io, &upload, &budget(), &time, &rules, &auth)
                .await
                .unwrap(),
        );
        io.inject = injection;
        assert!(run(&mut c, &mut io, job, &time, &rules, &auth)
            .await
            .is_err());
        time.0.set(WEEK + 10);
        assert!(c
            .candidate(
                TENANT,
                GENERATION,
                DeletionKind::DeliveryCache,
                WEEK + 10,
                WEEK + 11,
                &auth
            )
            .is_err());
        assert_eq!(io.copies.values().next().unwrap(), io.fixture.bytes());
        assert!(pin(&mut c, "object", 500, WEEK + 10, &auth).is_err());
        if injection == Injection::Uncertain {
            assert!(!io.order.contains(&"cleanup-incomplete"));
        }
    }
}

#[tokio::test]
async fn corrupt_missing_and_failed_repair_never_publish_a_lease() {
    for (fault, injection) in [
        (Fault::Corrupt(1), Injection::None),
        (Fault::Missing(1), Injection::None),
        (Fault::Healthy, Injection::PartialRestore),
        (Fault::Healthy, Injection::BadDigest),
        (Fault::Healthy, Injection::RepairFailure),
    ] {
        let (mut c, mut io, _, time, auth, rules) = archived().await;
        evict(&mut c, &mut io, &time, auth.as_ref());
        io.archives[0].reset(fault).await;
        io.fault = fault;
        io.inject = injection;
        let job = request(&mut c, "object", 1000, 500, 40, time.0.get(), auth.as_ref());
        assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
            .await
            .is_err());
        assert_eq!(
            c.job(TENANT, job).unwrap().state,
            JobState::FailedUnrecoverable
        );
        assert!(pin(&mut c, "object", 1001, time.0.get(), auth.as_ref()).is_err());
        assert!(!io.order.contains(&"cache-complete"));
        assert!(io.copies.is_empty());
    }
}

#[tokio::test]
async fn lost_worker_restart_uses_checkpoint_and_fences_stale_publication() {
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    evict(&mut c, &mut io, &time, auth.as_ref());
    let job = request(&mut c, "object", 1000, 500, 40, time.0.get(), auth.as_ref());
    let event = job_event(&c, job);
    let stale = c.claim(TENANT, job, 11, 20).unwrap();
    c.transition(
        TENANT,
        stale.clone(),
        Transition::Checkpoint {
            expected: 0,
            next: 1,
            inventory_ref: "retained-inventory-before-worker-loss".into(),
        },
        11,
        auth.as_ref(),
    )
    .unwrap();
    // Lose only the worker's incomplete allocation. Do not clone/reimport the
    // authoritative catalogue or describe this as durable database recovery.
    let key = (
        (
            TENANT.0,
            GENERATION.0,
            job.0,
            "retained-inventory-before-worker-loss".into(),
        ),
        1,
    );
    let scratch = io.scratch.entry(key.clone()).or_default();
    scratch.begin(io.fixture.key(), &mut io.trace);
    scratch.append(io.fixture.key(), b"stale partial", &mut io.trace);
    scratch.restart(io.fixture.key(), &mut io.trace);
    io.scratch.remove(&key);
    time.0.set(21);
    run_once(
        &mut c,
        &mut io,
        TENANT,
        event,
        &budget(),
        time.as_ref(),
        &rules,
        &MockQualification,
        auth.as_ref(),
    )
    .await
    .unwrap();
    assert_eq!(
        io.attempts.last().unwrap(),
        &("retained-inventory-before-worker-loss".into(), 2)
    );
    let copy = io.copy(
        &io.upload().metadata,
        c.generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .unwrap(),
    );
    assert_eq!(
        c.transition(
            TENANT,
            stale,
            Transition::PublishRestore { copy },
            21,
            auth.as_ref()
        ),
        Err(Error::Fenced)
    );
    assert_eq!(c.job(TENANT, job).unwrap().checkpoint, 2);
}

#[tokio::test]
async fn revoke_overwrite_ban_and_expired_claim_cannot_publish() {
    // Revocation happens after physical completion, before the atomic publish.
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    io.revoke_at_complete = Some((auth.clone(), "object".into()));
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    auth.denied.borrow_mut().clear();
    assert!(pin(&mut c, "object", 1001, 10, auth.as_ref()).is_err());

    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    let mut newer = Io::new(2).await;
    let upload = newer.upload();
    ingest(
        &mut c,
        &mut newer,
        &upload,
        &budget(),
        time.as_ref(),
        &rules,
        auth.as_ref(),
    )
    .await
    .unwrap();
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    assert_eq!(
        c.lookup(TENANT, "object", 10, auth.as_ref())
            .unwrap()
            .generation,
        GenerationId(2)
    );
    assert!(pin(&mut c, "object", 1001, 10, auth.as_ref()).is_err());

    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    c.set_moderation(TENANT, GENERATION, 1, true).unwrap();
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    assert!(pin(&mut c, "object", 1001, 10, auth.as_ref()).is_err());

    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    io.expire_at_complete = Some(time.clone());
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    assert!(pin(&mut c, "object", 1001, time.0.get(), auth.as_ref()).is_err());
}

#[tokio::test]
async fn explicit_budget_deadline_and_cancellation_fail_closed() {
    assert_eq!(Budget::new(0, 3, 3, 10), Err(Error::Invalid));
    assert_eq!(Budget::new(4096, 0, 3, 10), Err(Error::Invalid));
    assert_eq!(Budget::new(4096, 3, 0, 10), Err(Error::Invalid));
    assert_eq!(Budget::new(4096, 3, 3, 0), Err(Error::Invalid));
    let (mut c, mut io, _, time, auth, rules) = archived().await;
    let job = request(&mut c, "object", 1000, 500, 40, 10, auth.as_ref());
    let event = job_event(&c, job);
    let count = io.order.len();
    assert_eq!(
        run_once(
            &mut c,
            &mut io,
            TENANT,
            event,
            &Budget::new(100, 3, 3, 100).unwrap(),
            time.as_ref(),
            &rules,
            &MockQualification,
            auth.as_ref()
        )
        .await,
        Err(Failure::Admission)
    );
    assert_eq!(count, io.order.len());
    c.transact(
        TENANT,
        OperationId(1001),
        Mutation::CancelSubscription {
            name: "object".into(),
            job,
            subscription: OperationId(1000),
        },
        10,
        auth.as_ref(),
    )
    .unwrap();
    rules.cancelled.set(true);
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Cancelled);
    assert_eq!(count, io.order.len());
    rules.cancelled.set(false);
    let job = request(&mut c, "object", 1002, 30, 40, 10, auth.as_ref());
    time.0.set(30);
    assert!(run(&mut c, &mut io, job, &time, &rules, auth.as_ref())
        .await
        .is_err());
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Expired);
    assert_eq!(count, io.order.len());
}
