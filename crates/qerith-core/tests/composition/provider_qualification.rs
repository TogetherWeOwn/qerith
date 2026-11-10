use super::*;
use qerith_core::catalogue::S3VerificationEvidence;

#[path = "provider_s3_upload.rs"]
mod s3_upload;

// These references assert synthetic software qualification only. No media keys,
// supplier durability or authenticated plaintext are present in this fake.
struct S3Qualification(u8);
impl Qualifier for S3Qualification {
    fn qualify(
        &self,
        _: &Work,
        _: &[Reconstruction; 2],
        _: u64,
    ) -> qerith_core::catalogue::Result<Qualification> {
        panic!("S3 must never manufacture NNTP backbones")
    }
    fn qualify_s3(
        &self,
        work: &Work,
        record: &a::ObjectRecord,
        now: u64,
    ) -> std::result::Result<S3VerificationEvidence, IoError> {
        let mut proof = evidence(record.clone(), work.metadata.recovery_ref.clone(), now);
        match self.0 {
            0 => {}
            1 => proof.record.identity.target.account = aid("different-account"),
            2 => proof.record.identity.version = aid("different-version"),
            3 => proof.record.identity.target.encryption.envelope = aid("different-envelope"),
            4 => proof.record.identity.target.tenant = aid("different-tenant"),
            5 => proof.record.identity.target.generation = aid("different-generation"),
            6 => proof.record.identity.target.backend = a::Backend::Nntp,
            7 => proof.recovery_ref.push_str("-different"),
            8 => proof.verified_at = now + 1,
            9 => proof.valid_until = now,
            10 => proof.readability_ref.clear(),
            11 => proof.durability_ref.clear(),
            12 => proof.provenance_ref.clear(),
            13 => proof.verifier_version.clear(),
            14 => return Err(IoError::Retryable), // Synthetic assessor temporarily unavailable.
            _ => unreachable!(),
        }
        Ok(proof)
    }
}
fn evidence(record: a::ObjectRecord, recovery_ref: String, now: u64) -> S3VerificationEvidence {
    S3VerificationEvidence {
        record,
        recovery_ref,
        verified_at: now,
        valid_until: now + 100,
        verifier_version: "MOCK software only".into(),
        provenance_ref: "MOCK exact-version observation".into(),
        readability_ref: "MOCK no cryptographic readability claim".into(),
        durability_ref: "MOCK no supplier durability claim".into(),
    }
}
async fn qualified_attempt(
    c: &mut MemoryCatalogue,
    storage: &mut WriteStorage,
    job: JobId,
    auth: &Auth,
    time: &Time,
    case: u8,
) -> RunResult<()> {
    let event = job_event(c, job);
    run_once(
        c,
        storage,
        TENANT,
        event,
        &budget(),
        time,
        &Rules::default(),
        &S3Qualification(case),
        auth,
    )
    .await
}
fn proof(c: &MemoryCatalogue, storage: &WriteStorage, now: u64) -> S3VerificationEvidence {
    evidence(
        storage.cache.provider_record.clone().unwrap(),
        c.generation(TENANT, GENERATION)
            .unwrap()
            .metadata
            .recovery_ref,
        now,
    )
}

#[tokio::test]
async fn service_rest_mcp_upload_commit_reaches_selected_provider_and_retained_delivery() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for mcp in [false, true] {
            let (mut service, io, transfer, _, auth) = pending_upload().await;
            fully_stage(&mut service, &io, &transfer);
            let arguments = serde_json::to_vec(&serde_json::json!({
                "reference": transfer.target.reference.as_str(),
                "generation": transfer.target.generation.as_str(),
                "transfer": transfer.handle.as_str(),
                "identity": "provider_service_commit",
            }))
            .unwrap();
            let outcome = if mcp {
                let response = o::mcp_request(
                    &mut service,
                    Some(&scope()),
                    o::McpSession::default(),
                    o::TaskMode::Baseline,
                    o::Operation::CommitUpload.definition().name,
                    &arguments,
                );
                assert!(!response.is_error);
                response.outcome
            } else {
                o::rest_request(
                    &mut service,
                    Some(&scope()),
                    "POST",
                    &format!(
                        "/v1/operations/{}",
                        o::Operation::CommitUpload.definition().name
                    ),
                    &arguments,
                )
                .outcome
            };
            assert!(matches!(outcome.unwrap(), o::Output::Job(_)));
            let mut storage = write_storage(io, backend, WriteFault::Qualify, auth.clone());
            let time = Time(Cell::new(10));
            let result = service
                .finish_upload(
                    &scope(),
                    &transfer.handle,
                    &mut storage,
                    &budget(),
                    &time,
                    &Rules::default(),
                )
                .await
                .unwrap();
            assert_eq!(result.state, o::JobState::Succeeded);
            assert_eq!(result.effects, o::Effects::Committed);
            assert!(storage.nntp.calls.is_empty());
            assert!(
                storage.s3.calls.is_empty(),
                "commit only stages common cache"
            );
            let archive = service
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .find_map(|event| match event.effect {
                    Effect::RunJob(job) if job.kind == JobKind::Archive => Some(job.id),
                    _ => None,
                })
                .unwrap();
            let result = qualified_attempt(
                service.catalogue_mut(),
                &mut storage,
                archive,
                &auth,
                &time,
                0,
            )
            .await;
            assert_eq!(writer(&storage, backend).calls, ["begin", "part", "commit"]);
            let record = storage.cache.provider_record.as_ref().unwrap();
            assert_eq!(record.identity.target.backend, backend);
            assert_eq!(record.identity.target.encryption.key_epoch, aid("key_ref"));
            assert_eq!(
                record.identity.target.encryption.envelope,
                aid("envelope_ref")
            );
            if backend == a::Backend::Nntp {
                assert_eq!(result, Err(Failure::Io(IoError::RepairUnavailable)));
                assert_retained(service.catalogue(), &storage, archive, backend);
                continue;
            }
            result.unwrap();
            assert_eq!(
                service.catalogue().job(TENANT, archive).unwrap().state,
                JobState::Complete
            );
            let mut service = s::Service::reconnect(
                service.checkpoint(),
                Access(auth.clone()),
                limits(),
                profile(),
                10,
            )
            .unwrap();
            auth.denied.borrow_mut().insert("object:Write".into());
            let mut fields = vec![
                text("reference", transfer.target.reference.as_str()),
                text("generation", transfer.target.generation.as_str()),
                text("identity", "provider_service_restore"),
                ("availability_seconds".into(), o::Value::Number(50)),
            ];
            parity(
                &mut service,
                &scope(),
                o::Operation::Restore,
                fields.clone(),
            )
            .unwrap();
            let restore = service
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .rev()
                .find_map(|event| match event.effect {
                    Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
                    _ => None,
                })
                .unwrap();
            qualified_attempt(
                service.catalogue_mut(),
                &mut storage,
                restore,
                &auth,
                &time,
                0,
            )
            .await
            .unwrap();
            fields.pop();
            fields[2] = text("identity", "provider_service_download");
            let o::Output::Download(download) = parity(
                &mut service,
                &scope(),
                o::Operation::AuthorizeDownload,
                fields,
            )
            .unwrap() else {
                panic!("download");
            };
            assert_eq!(
                service
                    .read_download(
                        &scope(),
                        &download.handle,
                        &mut ReadCache(&storage.cache),
                        &time,
                    )
                    .unwrap(),
                storage.cache.fixture.bytes()
            );
            assert_eq!(
                storage.s3.inner.reads, 1,
                "qualification only, no warm refetch"
            );
            assert!(storage.nntp.calls.is_empty());
            assert_eq!(storage.nntp.inner.reads, 0);
            assert_eq!(storage.cache.copies.len(), 1);
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.trace.0.is_empty());
        }
    }
}

#[tokio::test]
async fn service_upload_key_revocation_prevents_provider_staging_and_outbox_commit() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, io, transfer, _, auth) = pending_upload().await;
        fully_stage(&mut service, &io, &transfer);
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&transfer),
        )
        .unwrap();
        let mut storage = write_storage(io, backend, WriteFault::Qualify, auth.clone());
        let journal = storage.cache.provider_write.clone();
        let allocations = service.allocations();
        let outbox = service.catalogue().outbox(TENANT);
        auth.denied.borrow_mut().insert("key_ref".into());
        let error = service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut storage,
                &budget(),
                &Time(Cell::new(10)),
                &Rules::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, o::ErrorCode::Denied);
        assert_eq!(service.allocations(), allocations);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
        assert_eq!(storage.cache.provider_write, journal);
        assert!(storage.cache.provider_record.is_none());
        assert!(storage.cache.copies.is_empty());
        assert!(storage.cache.order.is_empty());
        assert!(storage.nntp.calls.is_empty());
        assert!(storage.s3.calls.is_empty());
    }
}

#[tokio::test]
async fn s3_qualified_product_archive_completes_without_nntp_evidence_or_eviction() {
    let (mut c, mut storage, job, auth, time) = staged(a::Backend::S3, WriteFault::Qualify).await;
    qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0)
        .await
        .unwrap();
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
    assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
    assert_eq!(storage.s3.inner.reads, 1);
    assert!(storage.nntp.calls.is_empty());
    assert_eq!(storage.nntp.inner.reads, 0);
    let location = c
        .generation(TENANT, GENERATION)
        .unwrap()
        .cache_location
        .unwrap();
    assert_eq!(
        storage.cache.copies[&location],
        storage.cache.fixture.bytes()
    );
    assert!(storage.cache.trace.0.is_empty());
    assert!(!storage.cache.order.contains(&"engine-verify-pair"));
    let before = c.generation(TENANT, GENERATION).unwrap();
    for kind in [
        DeletionKind::DeliveryCache,
        DeletionKind::UnreferencedGeneration,
    ] {
        assert_eq!(
            c.candidate(TENANT, GENERATION, kind, 10, 10, auth.as_ref()),
            Err(Error::Invalid)
        );
        assert_eq!(
            c.candidate(TENANT, GENERATION, kind, 10, 11, auth.as_ref()),
            Err(Error::Unsafe)
        );
        assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    }
    let p = proof(&c, &storage, 10);
    let before = c.generation(TENANT, GENERATION).unwrap();
    c.record_s3_verification(TENANT, GENERATION, p.clone(), 10)
        .unwrap();
    assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    let changed = S3VerificationEvidence {
        verified_at: 11,
        ..p.clone()
    };
    c.record_s3_verification(TENANT, GENERATION, changed, 11)
        .unwrap();
    let mut changed = p;
    changed.verified_at = 12;
    changed.record.identity.version = aid("another-version");
    let before = c.generation(TENANT, GENERATION).unwrap();
    assert_eq!(
        c.record_s3_verification(TENANT, GENERATION, changed, 12),
        Err(Error::Conflict)
    );
    assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    let metadata = &before.metadata;
    assert_eq!(
        c.record_verification(
            TENANT,
            VerificationEvidence {
                generation: GENERATION,
                backbone: BackboneId(1),
                reconstructed: metadata.identity.clone(),
                verified_at: 12,
                valid_until: 100,
                verifier_version: "MOCK".into(),
                provenance_ref: "MOCK".into(),
                readability_ref: "MOCK".into(),
            },
            IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "MOCK".into(),
                decision_ref: "MOCK".into(),
                valid_until: 100,
            },
            12,
        ),
        Err(Error::Unsafe)
    );
}

#[tokio::test]
async fn s3_qualified_upload_reuses_retained_provider_bound_copy_for_a_new_restore_job() {
    let (mut c, mut storage, job, auth, time) = staged(a::Backend::S3, WriteFault::Qualify).await;
    qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0)
        .await
        .unwrap();
    let record = storage.cache.provider_record.clone().unwrap();
    let location = c
        .generation(TENANT, GENERATION)
        .unwrap()
        .cache_location
        .unwrap();
    assert_eq!(
        storage.cache.provider_retained.get(&location),
        Some(&record.identity.cache_key())
    );
    reconnect(&mut storage);
    storage.cache.provider_retained =
        serde_json::from_slice(&serde_json::to_vec(&storage.cache.provider_retained).unwrap())
            .unwrap();
    auth.denied.borrow_mut().insert("object:Write".into());
    // Upload operations already own 100/101; restore and pin need fresh IDs.
    let restore = request_restore(&mut c, "object", 1900, 50, 20, 10, auth.as_ref());
    assert_ne!(restore, job);
    qualified_attempt(&mut c, &mut storage, restore, &auth, &time, 0)
        .await
        .unwrap();
    assert_eq!(c.job(TENANT, restore).unwrap().state, JobState::Complete);
    assert_eq!(
        c.generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .as_ref(),
        Some(&location)
    );
    assert!(super::super::super::pin(&mut c, "object", 1901, 10, auth.as_ref()).is_ok());
    assert_eq!(storage.cache.copies.len(), 1);
    assert_eq!(
        storage.cache.copies[&location],
        storage.cache.fixture.bytes()
    );
    assert!(storage.cache.pending.is_empty());
    assert!(
        storage.cache.provider_keys.is_empty(),
        "no new restore allocation"
    );
    assert_eq!(
        storage.s3.inner.reads, 1,
        "qualification only; no restore refetch"
    );
    assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
    assert!(storage.nntp.calls.is_empty());
    assert_eq!(storage.nntp.inner.reads, 0);
    assert!(storage.cache.trace.0.is_empty());
}

#[tokio::test]
async fn s3_retained_binding_or_bytes_failure_prevents_qualification_and_warm_restore() {
    for completed in [false, true] {
        for fault in 0..4 {
            let (mut c, mut storage, job, auth, time) =
                staged(a::Backend::S3, WriteFault::Qualify).await;
            if completed {
                qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0)
                    .await
                    .unwrap();
            } else {
                assert_eq!(
                    qualified_attempt(&mut c, &mut storage, job, &auth, &time, 14).await,
                    Err(Failure::Io(IoError::Retryable))
                );
                time.0.set(13);
            }
            let location = c
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .unwrap();
            let record = storage.cache.provider_record.clone();
            match fault {
                0 => {
                    storage.cache.provider_retained.remove(&location);
                }
                1 => {
                    storage
                        .cache
                        .provider_retained
                        .insert(location.clone(), [0; 32]);
                }
                2 => {
                    storage.cache.copies.get_mut(&location).unwrap()[0] ^= 1;
                }
                3 => {
                    storage.cache.copies.remove(&location);
                }
                _ => unreachable!(),
            }
            let copies = storage.cache.copies.clone();
            let target_job = if completed {
                request_restore(&mut c, "object", 1900, 50, 20, 10, auth.as_ref())
            } else {
                job
            };
            assert_eq!(
                qualified_attempt(&mut c, &mut storage, target_job, &auth, &time, 0).await,
                Err(Failure::Io(IoError::Integrity)),
                "completed={completed}, fault={fault}"
            );
            assert_ne!(c.job(TENANT, target_job).unwrap().state, JobState::Complete);
            assert_eq!(
                c.generation(TENANT, GENERATION)
                    .unwrap()
                    .cache_location
                    .as_ref(),
                Some(&location)
            );
            assert_eq!(
                storage.cache.copies, copies,
                "never replace or remove retained bytes"
            );
            assert_eq!(storage.cache.provider_record, record);
            assert_eq!(
                storage.s3.inner.reads, 1,
                "no refetch to heal a recorded copy"
            );
            assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
            assert!(storage.nntp.calls.is_empty());
            assert_eq!(storage.nntp.inner.reads, 0);
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.trace.0.is_empty());
        }
    }
}

#[tokio::test]
async fn s3_qualification_retained_check_interrupts_on_either_authority_revocation() {
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll, Wake};

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

    for denied in ["object:Write", "object:Restore"] {
        let (mut c, mut storage, job, auth, time) =
            staged(a::Backend::S3, WriteFault::Qualify).await;
        assert_eq!(
            qualified_attempt(&mut c, &mut storage, job, &auth, &time, 14).await,
            Err(Failure::Io(IoError::Retryable))
        );
        let journal = storage.cache.provider_write.clone();
        let record = storage.cache.provider_record.clone();
        let copies = storage.cache.copies.clone();
        let bindings = storage.cache.provider_retained.clone();
        time.0.set(13);
        storage.cache.provider_cache_stall = Some("verify");
        let events = storage.control.events.clone();
        {
            let run = qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0);
            let mut run = std::pin::pin!(run);
            let wakes = Arc::new(Wakes::default());
            let waker = wakes.clone().into();
            let mut cx = Context::from_waker(&waker);
            assert!(run.as_mut().poll(&mut cx).is_pending());
            assert_eq!(wakes.0.load(Ordering::SeqCst), 0);
            auth.denied.borrow_mut().insert(denied.into());
            events.send_replace(None);
            assert!(wakes.0.load(Ordering::SeqCst) > 0);
            // No timeout/deadline may rescue a missed Write-revocation wake.
            assert_eq!(
                run.as_mut().poll(&mut cx),
                Poll::Ready(Err(Failure::Io(IoError::Cancelled))),
                "{denied}"
            );
        }
        assert_retained(&c, &storage, job, a::Backend::S3);
        assert_eq!(storage.cache.provider_write, journal);
        assert_eq!(storage.cache.provider_record, record);
        assert_eq!(storage.cache.copies, copies);
        assert_eq!(storage.cache.provider_retained, bindings);
        assert_eq!(storage.s3.inner.reads, 1, "no new remote observation");
        assert!(storage.cache.pending.is_empty());
        assert!(storage.cache.provider_keys.is_empty());
        assert_eq!(
            c.job(TENANT, job).unwrap().state,
            JobState::RetryWait { not_before: 15 }
        );

        reconnect(&mut storage);
        auth.denied.borrow_mut().remove(denied);
        events.send_replace(None);
        storage.cache.provider_cache_stall = None;
        time.0.set(15);
        qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0)
            .await
            .unwrap();
        assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
        assert_eq!(storage.cache.provider_write, journal);
        assert_eq!(storage.cache.provider_record, record);
        assert_eq!(storage.cache.copies, copies);
        assert_eq!(storage.cache.provider_retained, bindings);
        assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
        assert_eq!(
            storage.s3.inner.reads, 2,
            "qualification retried, not upload"
        );
        assert_eq!(storage.nntp.inner.reads, 0);
        assert!(storage.nntp.calls.is_empty());
        assert!(storage.cache.trace.0.is_empty());
    }
}

#[tokio::test]
async fn s3_qualification_rejects_mismatched_or_incomplete_evidence_without_losing_safety() {
    for case in 1..=13 {
        let (mut c, mut storage, job, auth, time) =
            staged(a::Backend::S3, WriteFault::Qualify).await;
        assert_eq!(
            qualified_attempt(&mut c, &mut storage, job, &auth, &time, case).await,
            Err(Failure::Catalogue(Error::Unsafe)),
            "case {case}"
        );
        assert_retained(&c, &storage, job, a::Backend::S3);
        assert_eq!(storage.s3.inner.reads, 1);
        // No invalid proof reached the catalogue: valid evidence can still bind it.
        let p = proof(&c, &storage, 10);
        c.record_s3_verification(TENANT, GENERATION, p, 10).unwrap();
    }
}

#[tokio::test]
async fn s3_observation_alone_and_bad_readback_never_complete_the_product_archive() {
    let (mut c, mut storage, job, auth, time) = staged(a::Backend::S3, WriteFault::Qualify).await;
    assert_eq!(
        attempt(&mut c, &mut storage, job, &auth, &time).await,
        Err(Failure::Io(IoError::RepairUnavailable))
    );
    assert_retained(&c, &storage, job, a::Backend::S3);
    for fault in [
        Fault::Corrupt,
        Fault::Oversized,
        Fault::Overrun,
        Fault::Short,
        Fault::IgnoreLimit,
    ] {
        let (mut c, mut storage, job, auth, time) =
            staged(a::Backend::S3, WriteFault::Qualify).await;
        storage.s3.inner.fault = fault;
        assert_eq!(
            qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0).await,
            Err(Failure::Io(IoError::Integrity))
        );
        assert_retained(&c, &storage, job, a::Backend::S3);
    }
}
