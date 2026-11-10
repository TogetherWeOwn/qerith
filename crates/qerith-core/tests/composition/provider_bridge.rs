use super::super::request as request_restore;
use super::*;
use a::{Control, Sink};
use qerith_core::composition::provider::{ArchiveCache, ProviderStorage, WriteJournal, WritePhase};

#[path = "provider_cache_control.rs"]
mod cache_control;
#[path = "provider_clients.rs"]
mod clients;
#[path = "provider_lifecycle.rs"]
mod lifecycle;
#[path = "provider_native.rs"]
mod native_clients;
#[path = "provider_write.rs"]
mod write;
use velmora::archive::v1 as a;

pub struct Stage<'a> {
    bytes: &'a mut Vec<u8>,
    limit: u64,
}
impl Sink for Stage<'_> {
    async fn write(&mut self, bytes: &[u8]) -> a::Result<()> {
        if bytes.len() > a::STREAM_BLOCK_BYTES
            || self.bytes.len() as u64 + bytes.len() as u64 > self.limit
        {
            return Err(a::Failure::Limit);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
}
impl ArchiveCache for Io {
    type Stage<'a> = Stage<'a>;
    fn archive_record(&self, _: &Work) -> std::result::Result<Option<a::ObjectRecord>, IoError> {
        Ok(self.provider_record.clone())
    }
    fn archive_write(&self, _: &Work) -> std::result::Result<Option<WriteJournal>, IoError> {
        Ok(self.provider_write.clone())
    }
    async fn save_archive_write(
        &mut self,
        work: &Work,
        expected: &WriteJournal,
        next: &WriteJournal,
    ) -> std::result::Result<(), IoError> {
        if self.provider_write.as_ref() != Some(expected) {
            return Err(IoError::Integrity);
        }
        if matches!(next.phase, WritePhase::Aborted { .. }) && self.inject == Injection::Uncertain {
            return Err(IoError::Uncertain);
        }
        let checkpoint = match next.phase {
            WritePhase::BeginPending => "journal-begin",
            WritePhase::Verified { .. } => "journal-verified",
            WritePhase::Ready { ref receipts, .. } if !receipts.is_empty() => "journal-part",
            _ => "journal-other",
        };
        if self.provider_cache_stall == Some(checkpoint) {
            return std::future::pending().await;
        }
        if let WritePhase::Verified { record } = &next.phase {
            if self.inject == Injection::Uncertain {
                return Err(IoError::Uncertain);
            }
            let location = work.retained_location.as_ref().ok_or(IoError::Integrity)?;
            self.verify_completed(work, location).await?;
            self.provider_retained
                .insert(location.clone(), record.identity.cache_key());
            self.provider_record = Some(record.clone());
        }
        // Serialized state is an explicit fake checkpoint, not a durable DB.
        self.provider_write =
            Some(serde_json::from_slice(&serde_json::to_vec(next).unwrap()).unwrap());
        if matches!(
            (checkpoint, self.provider_cache_stall),
            ("journal-begin", Some("journal-begin-saved"))
                | ("journal-verified", Some("journal-verified-saved"))
                | ("journal-part", Some("journal-part-saved"))
        ) {
            return std::future::pending().await;
        }
        Ok(())
    }
    async fn archive_write_part(
        &mut self,
        work: &Work,
        part: &a::Part,
    ) -> std::result::Result<Vec<u8>, IoError> {
        self.check(work)?;
        if self.provider_cache_stall == Some("write-part") {
            return std::future::pending().await;
        }
        let location = work.retained_location.as_ref().ok_or(IoError::Integrity)?;
        let bytes = self.copies.get(location).ok_or(IoError::Integrity)?;
        let start = usize::try_from(part.offset).map_err(|_| IoError::Integrity)?;
        bytes
            .get(start..start + part.bytes as usize)
            .map(|b| b.to_vec())
            .ok_or(IoError::Integrity)
    }
    async fn reconcile_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<bool, IoError> {
        if self.provider_cache_stall == Some("reconcile") {
            return std::future::pending().await;
        }
        if let Some(location) = self
            .completed
            .get(&inventory(work))
            .cloned()
            .or_else(|| work.retained_location.clone())
        {
            self.verify_provider_completed(work, key, &location).await?;
            return Ok(true);
        }
        Ok(false)
    }
    async fn begin_provider_restore<'a>(
        &'a mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<Stage<'a>, IoError> {
        self.check(work)?;
        self.provider_keys.insert(inventory(work), key);
        let bytes = self.pending.entry(allocation(work)).or_default();
        bytes.clear();
        if self.provider_cache_stall == Some("begin") {
            return std::future::pending().await;
        }
        Ok(Stage {
            bytes,
            limit: work.budget.max_bytes(),
        })
    }
    async fn complete_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<CompleteCopy, IoError> {
        if self.provider_keys.get(&inventory(work)) != Some(&key) {
            let location = work
                .retained_location
                .as_deref()
                .ok_or(IoError::Integrity)?;
            self.verify_provider_completed(work, key, location).await?;
        }
        let copy = self.complete_restore(work).await?;
        if self.provider_cache_stall == Some("complete") {
            return std::future::pending().await;
        }
        if self.provider_record_change == Some("complete") {
            self.provider_record.as_mut().unwrap().identity.version = aid("changed-version");
        }
        Ok(copy)
    }
    async fn verify_provider_completed(
        &mut self,
        work: &Work,
        key: [u8; 32],
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        if self.provider_keys.get(&inventory(work)) != Some(&key)
            && self.provider_retained.get(location) != Some(&key)
        {
            return Err(IoError::Integrity);
        }
        let copy = self.verify_completed(work, location).await?;
        if self.provider_cache_stall == Some("verify") {
            return std::future::pending().await;
        }
        if self.provider_record_change == Some("verify") {
            self.provider_record.as_mut().unwrap().identity.version = aid("changed-version");
        }
        Ok(copy)
    }
    async fn cleanup_provider_incomplete(
        &mut self,
        work: &Work,
        _: [u8; 32],
    ) -> std::result::Result<(), IoError> {
        self.cleanup_incomplete(work).await
    }
}

struct Current {
    auth: Rc<Auth>,
    events: tokio::sync::watch::Sender<Option<a::Failure>>,
    deadline: tokio::time::Instant,
}
impl Control for Current {
    fn check(&self, target: &a::Target, action: a::Action) -> a::Result<()> {
        if let Some(error) = *self.events.borrow() {
            return Err(error);
        }
        if tokio::time::Instant::now() >= self.deadline {
            return Err(a::Failure::Deadline);
        }
        if target.tenant.as_str() != TENANT.0.to_string()
            || !self.auth.is_current()
            || !self.auth.permits(
                &Reference {
                    tenant: TENANT,
                    name: "object".into(),
                },
                if matches!(action, a::Action::Write | a::Action::AbortIncomplete) {
                    Action::Write
                } else {
                    Action::Restore
                },
            )
        {
            return Err(a::Failure::Denied);
        }
        Ok(())
    }
    async fn cancelled<'a>(&'a self, target: &'a a::Target, action: a::Action) -> a::Failure {
        // Subscribe before the policy check. watch retains changes in the gap
        // between that check and polling changed(), even with stalled I/O.
        let mut events = self.events.subscribe();
        loop {
            if let Err(error) = self.check(target, action) {
                return error;
            }
            tokio::select! {
                result = events.changed() => {
                    if result.is_err() {
                        return a::Failure::Denied;
                    }
                }
                _ = tokio::time::sleep_until(self.deadline) => return a::Failure::Deadline,
            }
        }
    }
}
#[derive(Clone, Copy)]
enum Fault {
    None,
    Missing,
    Corrupt,
    Revoke,
    Stall,
    UncontrolledStall,
    Oversized,
    Overrun,
    Short,
    IgnoreLimit,
    Split,
}
struct Provider {
    backend: a::Backend,
    bytes: Vec<u8>,
    reads: usize,
    fault: Fault,
    auth: Rc<Auth>,
}
impl a::ArchiveProvider for Provider {
    fn capabilities(&self) -> a::Capabilities {
        a::Capabilities {
            write: false,
            range: true,
            reconcile: false,
            physical_delete: false,
            max_part_bytes: a::MAX_PART_BYTES,
        }
    }
    async fn begin(&mut self, _: &a::WriteIntent, _: &impl Control) -> a::Result<a::WriteSession> {
        Err(a::Failure::Unsupported)
    }
    async fn write_part(
        &mut self,
        _: &a::WriteSession,
        _: usize,
        _: &[u8],
        _: &impl Control,
    ) -> a::Result<a::PartReceipt> {
        Err(a::Failure::Unsupported)
    }
    async fn commit(
        &mut self,
        _: &a::WriteSession,
        _: &[a::PartReceipt],
        _: &impl Control,
    ) -> a::Result<a::WriteProof> {
        Err(a::Failure::Unsupported)
    }
    async fn abort(&mut self, _: &a::WriteSession, _: &impl Control) -> a::Result<a::AbortOutcome> {
        Err(a::Failure::Unsupported)
    }
    async fn stat(
        &mut self,
        _: &a::ObjectRecord,
        _: &impl Control,
    ) -> a::Result<a::ObjectIdentity> {
        Err(a::Failure::Unsupported)
    }
    async fn read_range(
        &mut self,
        record: &a::ObjectRecord,
        range: a::Range,
        sink: &mut impl Sink,
        control: &impl Control,
    ) -> a::Result<()> {
        control.check(&record.identity.target, a::Action::Read)?;
        assert_eq!(record.identity.target.backend, self.backend);
        assert_eq!(
            record.identity.target.account.as_str(),
            "immutable-config-v1"
        );
        assert_eq!(range.offset, 0);
        assert_eq!(range.bytes, self.bytes.len() as u64);
        self.reads += 1;
        if matches!(self.fault, Fault::Missing) {
            return Err(a::Failure::Configuration);
        }
        let mut bytes = self.bytes.clone();
        if matches!(self.fault, Fault::Corrupt) {
            bytes[0] ^= 1;
        }
        if matches!(self.fault, Fault::UncontrolledStall) {
            sink.write(&bytes[..bytes.len() / 2]).await?;
            return std::future::pending().await;
        }
        if matches!(self.fault, Fault::Stall) {
            sink.write(&bytes[..bytes.len() / 2]).await?;
            // No I/O wake or completion after this invisible prefix. Only the
            // invocation's event/timer can make this generated provider finish.
            return Err(control
                .cancelled(&record.identity.target, a::Action::Read)
                .await);
        }
        if matches!(self.fault, Fault::Oversized | Fault::IgnoreLimit) {
            let result = sink.write(&vec![0; a::STREAM_BLOCK_BYTES + 1]).await;
            if matches!(self.fault, Fault::IgnoreLimit) {
                // Even a subsequent valid body must not erase the first error.
                let _ = sink.write(&bytes).await;
                return Ok(());
            }
            return result;
        }
        if matches!(self.fault, Fault::Short) {
            return sink.write(&bytes[..bytes.len() / 2]).await;
        }
        if matches!(self.fault, Fault::Split) {
            let split = bytes.len() / 2;
            sink.write(&bytes[..split]).await?;
            sink.write(&bytes[split..]).await?;
        } else {
            sink.write(&bytes).await?;
        }
        if matches!(self.fault, Fault::Overrun) {
            return sink.write(&[0]).await;
        }
        if matches!(self.fault, Fault::Revoke) {
            self.auth
                .denied
                .borrow_mut()
                .insert("object:Restore".into());
        }
        control.check(&record.identity.target, a::Action::Read)
    }
    async fn reconcile(
        &mut self,
        _: &a::WriteSession,
        _: &impl Control,
    ) -> a::Result<a::Reconciled> {
        Err(a::Failure::Unsupported)
    }
    async fn health(&mut self, _: &a::Target, _: &impl Control) -> a::Result<a::Health> {
        Err(a::Failure::Unsupported)
    }
}
fn aid(value: &str) -> a::Id {
    a::Id::new(value).unwrap()
}
fn record(io: &Io, backend: a::Backend) -> a::ObjectRecord {
    a::ObjectRecord {
        identity: a::ObjectIdentity {
            target: a::Target {
                tenant: aid(&TENANT.0.to_string()),
                backend,
                account: aid("immutable-config-v1"),
                locator: aid("private-allocation-v1"),
                generation: aid(&GENERATION.0.to_string()),
                encryption: a::EncryptionIdentity {
                    format: aid("synthetic_C"),
                    mode: 0,
                    key_epoch: aid("key_ref"),
                    envelope: aid("envelope_ref"),
                },
            },
            version: aid(if backend == a::Backend::Nntp {
                "1"
            } else {
                "s3-version-v1"
            }),
            bytes: io.identity().length,
            sha256: io.identity().sha256,
        },
        operation: aid("persisted-operation"),
        parts: vec![a::Part {
            offset: 0,
            bytes: io.identity().length as u32,
            sha256: io.identity().sha256,
            reference: aid("immutable-part"),
        }],
    }
}
fn bridge(
    io: Io,
    backend: a::Backend,
    auth: Rc<Auth>,
    fault: Fault,
) -> ProviderStorage<Io, Provider, Provider, Current> {
    let make = |kind| Provider {
        backend: kind,
        bytes: io.fixture.bytes().to_vec(),
        reads: 0,
        fault: if backend == kind { fault } else { Fault::None },
        auth: auth.clone(),
    };
    ProviderStorage {
        nntp: make(a::Backend::Nntp),
        s3: make(a::Backend::S3),
        cache: io,
        control: Current {
            auth,
            events: tokio::sync::watch::channel(None).0,
            deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
        },
    }
}
struct ReadCache<'a>(&'a Io);
impl qerith_core::s3::archive::QualifiedCache for ReadCache<'_> {
    fn read(
        &mut self,
        _: TenantId,
        _: GenerationId,
        _: &CiphertextIdentity,
        location: &str,
        _: PinId,
        range: Option<qerith_core::s3::ByteRange>,
    ) -> std::result::Result<Vec<u8>, qerith_core::s3::ErrorCode> {
        assert!(range.is_none());
        self.0
            .copies
            .get(location)
            .cloned()
            .ok_or(qerith_core::s3::ErrorCode::InternalError)
    }
}

#[tokio::test]
async fn provider_restore_reuses_product_job_publication_and_authorized_delivery() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, upload, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        // This fixture's prior eviction uses unchanged synthetic NNTP proof.
        // A separately supplied restore inventory is NOT S3 eviction evidence.
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        io.assert_cold();
        let saved = serde_json::to_vec(&record(&io, backend)).unwrap();
        io.provider_record = Some(serde_json::from_slice(&saved).unwrap());
        let mut storage = bridge(io, backend, auth.clone(), Fault::None);
        service.set_now(60).unwrap();
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            900,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let event = job_event(service.catalogue(), restore);
        run_once(
            service.catalogue_mut(),
            &mut storage,
            TENANT,
            event,
            &budget(),
            &time,
            &Rules::default(),
            &MockQualification,
            auth.as_ref(),
        )
        .await
        .unwrap();
        assert_eq!(
            service.catalogue().job(TENANT, restore).unwrap().state,
            JobState::Complete
        );
        assert_eq!(storage.nntp.reads, usize::from(backend == a::Backend::Nntp));
        assert_eq!(storage.s3.reads, usize::from(backend == a::Backend::S3));
        let o::Output::Download(transfer) = parity(
            &mut service,
            &scope(),
            o::Operation::AuthorizeDownload,
            vec![
                text("reference", upload.target.reference.as_str()),
                text("generation", upload.target.generation.as_str()),
                text("identity", "provider_delivery"),
            ],
        )
        .unwrap() else {
            panic!("download");
        };
        assert_eq!(
            service
                .read_download(
                    &scope(),
                    &transfer.handle,
                    &mut ReadCache(&storage.cache),
                    &time
                )
                .unwrap(),
            storage.cache.fixture.bytes()
        );
        auth.denied.borrow_mut().insert("object".into());
        assert!(service
            .read_download(
                &scope(),
                &transfer.handle,
                &mut ReadCache(&storage.cache),
                &time
            )
            .is_err());
        evidence(
            if backend == a::Backend::S3 {
                "provider-s3-restore.json"
            } else {
                "provider-nntp-restore.json"
            },
            serde_json::json!({
                "head_sha": std::env::var("QERITH_EVIDENCE_HEAD").ok(),
                "kind": "synthetic_shared_contract_restore_to_product_delivery",
                "serialized_provider_inventory": true,
                "common_catalogue_publication_and_serving_pin": true,
                "physical_provider_or_s3_eviction_qualification": false,
                "new_write_path": false,
            }),
        );
    }
}

#[tokio::test]
async fn provider_restore_errors_never_publish_or_fall_back() {
    for fault in [
        Fault::Missing,
        Fault::Corrupt,
        Fault::Revoke,
        Fault::Oversized,
        Fault::Overrun,
        Fault::Short,
        Fault::IgnoreLimit,
    ] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        io.provider_record = Some(record(&io, a::Backend::S3));
        let mut storage = bridge(io, a::Backend::S3, auth.clone(), fault);
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            901,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let event = job_event(service.catalogue(), restore);
        assert!(run_once(
            service.catalogue_mut(),
            &mut storage,
            TENANT,
            event,
            &budget(),
            &time,
            &Rules::default(),
            &MockQualification,
            auth.as_ref()
        )
        .await
        .is_err());
        assert!(service
            .catalogue()
            .generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .is_none());
        assert_eq!(storage.nntp.reads, 0);
        assert_eq!(storage.s3.reads, 1);
        assert!(storage.cache.copies.is_empty());
        assert!(storage.cache.pending.is_empty());
    }
}

#[tokio::test]
async fn provider_restore_stream_is_bounded_and_verified_before_cache_completion() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for fault in [
            Fault::Oversized,
            Fault::Overrun,
            Fault::Short,
            Fault::IgnoreLimit,
            Fault::Corrupt,
        ] {
            let (mut service, mut io, _, _, auth) = hot_upload().await;
            let time = Time(Cell::new(60));
            evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
            io.provider_record = Some(record(&io, backend));
            let mut storage = bridge(io, backend, auth.clone(), fault);
            let restore = request_restore(
                service.catalogue_mut(),
                "object",
                902,
                1000,
                50,
                60,
                auth.as_ref(),
            );
            let job = service.catalogue().job(TENANT, restore).unwrap();
            let generation = service
                .catalogue()
                .generation(TENANT, job.generation)
                .unwrap();
            let work = Work {
                tenant: TENANT,
                event: job_event(service.catalogue(), restore),
                attempt: 1,
                inventory_ref: format!(
                    "composition-v1/{}/{}/{}",
                    TENANT.0, job.generation.0, job.id.0
                ),
                job,
                metadata: generation.metadata,
                retained_location: generation.cache_location,
                claim_until: 100,
                budget: budget(),
            };
            // Inspect the invisible allocation before job cleanup. The bridge,
            // not completion-time validation, must refuse excess cache writes.
            assert_eq!(storage.retrieve(&work).await, Err(IoError::Integrity));
            let staged = &storage.cache.pending[&allocation(&work)];
            if matches!(fault, Fault::Oversized | Fault::IgnoreLimit) {
                assert!(staged.is_empty());
            } else {
                assert!(staged.len() <= work.metadata.identity.length as usize);
            }
            assert!(storage.cache.completed.is_empty());
            assert!(storage.cache.copies.is_empty());
            assert!(service
                .catalogue()
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .is_none());
            storage.cleanup_incomplete(&work).await.unwrap();
            assert!(storage.cache.pending.is_empty());
            // Retry the real product job with valid segmented bytes; stream
            // accounting is attempt-local and cannot poison a fresh restore.
            if backend == a::Backend::Nntp {
                storage.nntp.fault = Fault::Split;
            } else {
                storage.s3.fault = Fault::Split;
            }
            run_once(
                service.catalogue_mut(),
                &mut storage,
                TENANT,
                work.event,
                &budget(),
                &time,
                &Rules::default(),
                &MockQualification,
                auth.as_ref(),
            )
            .await
            .unwrap();
            assert_eq!(
                service.catalogue().job(TENANT, restore).unwrap().state,
                JobState::Complete
            );
            let location = service
                .catalogue()
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .unwrap();
            assert_eq!(
                storage.cache.copies[&location],
                storage.cache.fixture.bytes()
            );
            assert_eq!(
                storage.nntp.reads,
                2 * usize::from(backend == a::Backend::Nntp)
            );
            assert_eq!(storage.s3.reads, 2 * usize::from(backend == a::Backend::S3));
        }
    }
}

#[tokio::test]
async fn provider_stalled_restore_wakes_on_policy_cancel_and_deadline_without_publication() {
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Wake};
    use std::time::Duration;

    #[derive(Default)]
    struct Wakes(AtomicUsize);
    impl Wake for Wakes {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for (fault, stop) in [Fault::Stall, Fault::UncontrolledStall]
            .into_iter()
            .flat_map(|fault| {
                [
                    a::Failure::Denied,
                    a::Failure::Cancelled,
                    a::Failure::Deadline,
                ]
                .into_iter()
                .map(move |stop| (fault, stop))
            })
        {
            let (mut service, mut io, _, _, auth) = hot_upload().await;
            let time = Time(Cell::new(60));
            evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
            io.provider_record = Some(record(&io, backend));
            // Setup uses loopback archive I/O with real timeouts. Pause only
            // after it settles, so auto-advance cannot expire setup reads.
            tokio::time::pause();
            let mut storage = bridge(io, backend, auth.clone(), fault);
            let events = storage.control.events.clone();
            let restore = request_restore(
                service.catalogue_mut(),
                "object",
                903,
                1000,
                50,
                60,
                auth.as_ref(),
            );
            let event = job_event(service.catalogue(), restore);
            let rules = Rules::default();
            let limits = budget();
            {
                let run = run_once(
                    service.catalogue_mut(),
                    &mut storage,
                    TENANT,
                    event,
                    &limits,
                    &time,
                    &rules,
                    &MockQualification,
                    auth.as_ref(),
                );
                let mut run = std::pin::pin!(run);
                let wakes = Arc::new(Wakes::default());
                let waker = wakes.clone().into();
                let mut cx = Context::from_waker(&waker);
                assert!(run.as_mut().poll(&mut cx).is_pending());
                assert_eq!(wakes.0.load(Ordering::SeqCst), 0);
                match stop {
                    a::Failure::Denied => {
                        auth.denied.borrow_mut().insert("object:Restore".into());
                        // A policy-change event, not a cached authority boolean.
                        events.send_replace(None);
                    }
                    a::Failure::Cancelled => {
                        events.send_replace(Some(stop));
                    }
                    a::Failure::Deadline => tokio::time::advance(Duration::from_secs(31)).await,
                    _ => unreachable!(),
                }
                assert!(wakes.0.load(Ordering::SeqCst) > 0, "missing {stop:?} wake");
                assert!(tokio::time::timeout(Duration::from_secs(1), run)
                    .await
                    .expect("stalled provider must be interrupted")
                    .is_err());
            }
            assert_eq!(storage.nntp.reads, usize::from(backend == a::Backend::Nntp));
            assert_eq!(storage.s3.reads, usize::from(backend == a::Backend::S3));
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.copies.is_empty());
            assert!(service
                .catalogue()
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .is_none());
            assert_ne!(
                service.catalogue().job(TENANT, restore).unwrap().state,
                JobState::Complete
            );
            tokio::time::resume();
        }
    }
}

#[tokio::test]
async fn provider_control_observes_events_before_wait_registration() {
    let (_, io, _, _, auth) = hot_upload().await;
    let target = record(&io, a::Backend::S3).identity.target;
    let storage = bridge(io, a::Backend::S3, auth.clone(), Fault::None);
    storage
        .control
        .events
        .send_replace(Some(a::Failure::Cancelled));
    assert_eq!(
        storage.control.cancelled(&target, a::Action::Read).await,
        a::Failure::Cancelled
    );
    storage.control.events.send_replace(None);
    auth.denied.borrow_mut().insert("object:Restore".into());
    assert_eq!(
        storage.control.cancelled(&target, a::Action::Read).await,
        a::Failure::Denied
    );
}

#[tokio::test]
async fn provider_record_scope_is_checked_before_any_io() {
    for field in ["tenant", "generation", "digest", "length"] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        let mut saved = record(&io, a::Backend::S3);
        match field {
            "tenant" => saved.identity.target.tenant = aid("2"),
            "generation" => saved.identity.target.generation = aid("2"),
            "digest" => saved.identity.sha256[0] ^= 1,
            "length" => saved.identity.bytes += 1,
            _ => unreachable!(),
        }
        io.provider_record = Some(saved);
        let mut storage = bridge(io, a::Backend::S3, auth.clone(), Fault::None);
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            902,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let event = job_event(service.catalogue(), restore);
        assert!(run_once(
            service.catalogue_mut(),
            &mut storage,
            TENANT,
            event,
            &budget(),
            &time,
            &Rules::default(),
            &MockQualification,
            auth.as_ref()
        )
        .await
        .is_err());
        assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
        assert!(storage.cache.pending.is_empty());
    }
}
