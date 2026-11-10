use super::*;

// One common cache port with explicitly enrolled generation inventories. A missing
// entry is not a legacy record. This fake has no durable catalogue or live config.
struct MixedCache {
    generations: BTreeMap<u64, Io>,
    recovery_refs: BTreeMap<u64, String>,
    new_write: Option<a::Backend>,
}
impl MixedCache {
    fn get(&self, work: &Work) -> std::result::Result<&Io, IoError> {
        let io = self
            .generations
            .get(&work.job.generation.0)
            .ok_or(IoError::Integrity)?;
        if work.tenant != TENANT
            || self.recovery_refs.get(&work.job.generation.0) != Some(&work.metadata.recovery_ref)
        {
            return Err(IoError::Integrity);
        }
        io.check(work)?;
        Ok(io)
    }
    fn get_mut(&mut self, work: &Work) -> std::result::Result<&mut Io, IoError> {
        self.get(work)?;
        Ok(self.generations.get_mut(&work.job.generation.0).unwrap())
    }
}
impl Storage for MixedCache {
    async fn stage_upload(
        &mut self,
        upload: &Upload,
        budget: &Budget,
        until: u64,
    ) -> std::result::Result<CompleteCopy, IoError> {
        let backend = self.new_write.ok_or(IoError::RepairUnavailable)?;
        let io = self
            .generations
            .get_mut(&upload.generation.0)
            .ok_or(IoError::Integrity)?;
        if upload.tenant != TENANT || upload.metadata != io.upload().metadata {
            return Err(IoError::Integrity);
        }
        if io.provider_write.is_none() {
            let mut selected = record(io, backend);
            selected.identity.target.generation = aid(&upload.generation.0.to_string());
            selected.identity.target.account = aid(if backend == a::Backend::Nntp {
                "nntp-account-v1"
            } else {
                "s3-account-v1"
            });
            selected.identity.target.locator = aid(&format!("allocation-{}", upload.generation.0));
            if backend == a::Backend::Nntp {
                selected.identity.version = selected.identity.target.generation.clone();
            }
            io.provider_write = Some(WriteJournal {
                intent: selected.intent(),
                phase: WritePhase::Prepared,
            });
        }
        io.stage_upload(upload, budget, until).await
    }
    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.get_mut(work)?.post(work).await
    }
    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        self.get_mut(work)?.verify_archive(work).await
    }
    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.get_mut(work)?.retrieve(work).await
    }
    async fn complete_restore(
        &mut self,
        work: &Work,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.get_mut(work)?.complete_restore(work).await
    }
    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.get_mut(work)?.verify_completed(work, location).await
    }
    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.get_mut(work)?.cleanup_incomplete(work).await
    }
}
impl ArchiveCache for MixedCache {
    type Stage<'a> = Stage<'a>;
    fn archive_record(&self, work: &Work) -> std::result::Result<Option<a::ObjectRecord>, IoError> {
        self.get(work)?.archive_record(work)
    }
    fn archive_write(&self, work: &Work) -> std::result::Result<Option<WriteJournal>, IoError> {
        self.get(work)?.archive_write(work)
    }
    async fn save_archive_write(
        &mut self,
        work: &Work,
        expected: &WriteJournal,
        next: &WriteJournal,
    ) -> std::result::Result<(), IoError> {
        self.get_mut(work)?
            .save_archive_write(work, expected, next)
            .await
    }
    async fn archive_write_part(
        &mut self,
        work: &Work,
        part: &a::Part,
    ) -> std::result::Result<Vec<u8>, IoError> {
        self.get_mut(work)?.archive_write_part(work, part).await
    }
    async fn reconcile_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<bool, IoError> {
        self.get_mut(work)?
            .reconcile_provider_restore(work, key)
            .await
    }
    async fn begin_provider_restore<'a>(
        &'a mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<Self::Stage<'a>, IoError> {
        self.get_mut(work)?.begin_provider_restore(work, key).await
    }
    async fn complete_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.get_mut(work)?
            .complete_provider_restore(work, key)
            .await
    }
    async fn verify_provider_completed(
        &mut self,
        work: &Work,
        key: [u8; 32],
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.get_mut(work)?
            .verify_provider_completed(work, key, location)
            .await
    }
    async fn cleanup_provider_incomplete(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<(), IoError> {
        self.get_mut(work)?
            .cleanup_provider_incomplete(work, key)
            .await
    }
}

fn work(c: &MemoryCatalogue, job: JobId) -> Work {
    let job = c.job(TENANT, job).unwrap();
    let generation = c.generation(TENANT, job.generation).unwrap();
    Work {
        tenant: TENANT,
        event: job_event(c, job.id),
        inventory_ref: format!(
            "composition-v1/{}/{}/{}",
            TENANT.0, job.generation.0, job.id.0
        ),
        job,
        attempt: 1,
        metadata: generation.metadata,
        retained_location: generation.cache_location,
        claim_until: 100,
        budget: budget(),
    }
}

#[tokio::test]
async fn mixed_generations_keep_old_reads_and_frozen_write_targets_when_config_is_removed() {
    let (mut service, mut legacy, _, _, auth) = hot_upload().await;
    let time = Time(Cell::new(60));
    // Only the already qualified legacy generation is evicted. No S3 safety
    // copy is deleted to manufacture a cold-provider receipt.
    evict(service.catalogue_mut(), &mut legacy, &time, auth.as_ref());
    legacy.assert_cold();
    let restore = request_restore(
        service.catalogue_mut(),
        "object",
        900,
        1000,
        50,
        60,
        auth.as_ref(),
    );
    let nntp_io = Io::new(2).await;
    let s3_io = Io::new(3).await;
    let mut nntp_upload = nntp_io.upload();
    nntp_upload.name = "new-nntp".into();
    nntp_upload.expected_revision = 0;
    let mut s3_upload = s3_io.upload();
    s3_upload.name = "new-s3".into();
    s3_upload.expected_revision = 0;
    let ProviderStorage {
        cache: mut nntp_io,
        nntp,
        ..
    } = write_storage(nntp_io, a::Backend::Nntp, WriteFault::None, auth.clone());
    let ProviderStorage {
        cache: mut s3_io,
        s3,
        ..
    } = write_storage(s3_io, a::Backend::S3, WriteFault::None, auth.clone());
    // Enrollment starts without an intent; stage_upload selects it once.
    nntp_io.provider_write = None;
    s3_io.provider_write = None;
    let mut storage = ProviderStorage {
        cache: MixedCache {
            generations: BTreeMap::from([(1, legacy), (2, nntp_io), (3, s3_io)]),
            recovery_refs: BTreeMap::from([
                (
                    1,
                    service
                        .catalogue()
                        .generation(TENANT, GENERATION)
                        .unwrap()
                        .metadata
                        .recovery_ref,
                ),
                (2, nntp_upload.metadata.recovery_ref.clone()),
                (3, s3_upload.metadata.recovery_ref.clone()),
            ]),
            new_write: Some(a::Backend::Nntp),
        },
        nntp,
        s3,
        control: Current {
            auth: auth.clone(),
            events: tokio::sync::watch::channel(None).0,
            deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
        },
    };
    let nntp_job = commit_job(
        ingest(
            service.catalogue_mut(),
            &mut storage,
            &nntp_upload,
            &budget(),
            &time,
            &Rules::default(),
            auth.as_ref(),
        )
        .await
        .unwrap(),
    );
    storage.cache.new_write = Some(a::Backend::S3);
    let s3_job = commit_job(
        ingest(
            service.catalogue_mut(),
            &mut storage,
            &s3_upload,
            &budget(),
            &time,
            &Rules::default(),
            auth.as_ref(),
        )
        .await
        .unwrap(),
    );
    let saved: Vec<_> = [2, 3]
        .into_iter()
        .map(|g| {
            serde_json::to_vec(
                storage.cache.generations[&g]
                    .provider_write
                    .as_ref()
                    .unwrap(),
            )
            .unwrap()
        })
        .collect();
    // Reconnect the fake checkpoints and remove only new-write configuration.
    // Existing routing/accounts remain readable; this is not provider activation.
    for (generation, bytes) in [2, 3].into_iter().zip(saved) {
        storage
            .cache
            .generations
            .get_mut(&generation)
            .unwrap()
            .provider_write = Some(serde_json::from_slice(&bytes).unwrap());
    }
    storage.cache.new_write = None;
    // Terminal assessor refusal retires RunJob notifications. Capture the
    // original work while those events still exist for later storage checks.
    let retained_reads = [
        work(service.catalogue(), nntp_job),
        work(service.catalogue(), s3_job),
    ];
    for job in [s3_job, nntp_job] {
        let event = job_event(service.catalogue(), job);
        assert_eq!(
            run_once(
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
            .await,
            Err(Failure::Io(IoError::RepairUnavailable))
        );
    }
    assert_eq!(storage.nntp.calls, ["begin", "part", "commit"]);
    assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
    let records: Vec<_> = [2, 3]
        .into_iter()
        .map(|g| {
            storage.cache.generations[&g]
                .provider_record
                .clone()
                .unwrap()
        })
        .collect();
    assert_eq!(records[0].identity.target.backend, a::Backend::Nntp);
    assert_eq!(records[1].identity.target.backend, a::Backend::S3);
    assert_eq!(records[0].identity.target.account, aid("nntp-account-v1"));
    assert_eq!(records[1].identity.target.account, aid("s3-account-v1"));
    assert_ne!(
        records[0].identity.cache_key(),
        records[1].identity.cache_key()
    );
    for work in &retained_reads {
        storage.retrieve(work).await.unwrap();
        let location = work.retained_location.as_ref().unwrap();
        let copy = storage.verify_completed(work, location).await.unwrap();
        assert_eq!(copy.identity, work.metadata.identity);
        let io = &storage.cache.generations[&work.job.generation.0];
        assert_eq!(io.copies[location], io.fixture.bytes());
        assert!(!io.order.contains(&"engine-post"));
        assert!(!io.order.contains(&"engine-retrieve"));
        assert_eq!(
            service.catalogue().job(TENANT, work.job.id).unwrap().state,
            JobState::FailedUnrecoverable
        );
        assert!(service
            .catalogue()
            .outbox(TENANT)
            .iter()
            .all(|event| event.id != work.event));
    }
    // The legacy cold job still traverses its original engine and publishes via
    // the ordinary catalogue fence, with both new-provider journals present.
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
    let old = &storage.cache.generations[&1];
    assert!(old.order.contains(&"engine-retrieve"));
    assert!(old.provider_record.is_none() && old.provider_write.is_none());
    assert_eq!(storage.nntp.inner.reads + storage.s3.inner.reads, 0);
    for (g, record) in [2, 3].into_iter().zip(&records) {
        assert_eq!(
            storage.cache.generations[&g].provider_record.as_ref(),
            Some(record)
        );
    }
    // Unknown tenant/generation/recovery inventory cannot become legacy I/O.
    let original = &retained_reads[0];
    for field in ["tenant", "generation", "recovery"] {
        let mut changed = original.clone();
        match field {
            "tenant" => changed.tenant = TenantId(999),
            "generation" => changed.job.generation = GenerationId(999),
            _ => changed.metadata.recovery_ref.push_str("-unknown"),
        }
        assert_eq!(storage.retrieve(&changed).await, Err(IoError::Integrity));
        assert_eq!(storage.post(&changed).await, Err(IoError::Integrity));
    }
    assert_eq!(storage.nntp.calls, ["begin", "part", "commit"]);
    assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
    let mut unconfigured = nntp_upload.clone();
    unconfigured.generation = GenerationId(4);
    assert_eq!(
        storage.stage_upload(&unconfigured, &budget(), 100).await,
        Err(IoError::RepairUnavailable)
    );
    evidence(
        "provider-mixed-inventory.json",
        serde_json::json!({
            "head_sha": std::env::var("QERITH_EVIDENCE_HEAD").ok(),
            "kind": "synthetic_mixed_legacy_and_frozen_provider_write_targets",
            "product_ingest_and_outbox_workers": true,
            "legacy_cold_restore_publication": true,
            "new_provider_safety_copies_retained": true,
            "new_provider_cold_restore_or_durable_qualification": false,
            "physical_or_production_support": false
        }),
    );
}
