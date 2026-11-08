use super::super::request as request_restore;
use super::*;
use a::{Control, Sink};
use qerith_core::composition::provider::{ArchiveCache, ProviderStorage};
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
    async fn reconcile_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<bool, IoError> {
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
            return Err(IoError::Integrity);
        }
        self.complete_restore(work).await
    }
    async fn verify_provider_completed(
        &mut self,
        work: &Work,
        key: [u8; 32],
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        if self.provider_keys.get(&inventory(work)) != Some(&key) {
            return Err(IoError::Integrity);
        }
        self.verify_completed(work, location).await
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
}
impl Control for Current {
    fn check(&self, target: &a::Target, _: a::Action) -> a::Result<()> {
        if target.tenant.as_str() != TENANT.0.to_string()
            || !self.auth.is_current()
            || !self.auth.permits(
                &Reference {
                    tenant: TENANT,
                    name: "object".into(),
                },
                Action::Restore,
            )
        {
            return Err(a::Failure::Denied);
        }
        Ok(())
    }
}
#[derive(Clone, Copy)]
enum Fault {
    None,
    Missing,
    Corrupt,
    Revoke,
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
        sink.write(&bytes).await?;
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
        control: Current { auth },
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
    for fault in [Fault::Missing, Fault::Corrupt, Fault::Revoke] {
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
