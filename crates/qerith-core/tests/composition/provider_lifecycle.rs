use super::*;

pub(super) fn work(service: &s::Service<Access>, restore: JobId) -> Work {
    let job = service.catalogue().job(TENANT, restore).unwrap();
    let generation = service
        .catalogue()
        .generation(TENANT, job.generation)
        .unwrap();
    Work {
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
    }
}

#[tokio::test]
async fn provider_journal_and_record_must_agree_before_restore_or_legacy_io() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for fault in [
            "missing-verified",
            "missing-prepared",
            "missing-begin",
            "missing-aborted",
            "unverified-record",
            "aborted-record",
            "intent",
            "saved-version",
            "record-version",
            "backend",
            "account",
            "locator",
            "envelope",
            "part",
        ] {
            let (mut service, mut io, _, _, auth) = hot_upload().await;
            let time = Time(Cell::new(60));
            // Setup eviction remains synthetic NNTP proof, never S3 authority.
            evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
            let original = record(&io, backend);
            let mut journal = WriteJournal {
                intent: original.intent(),
                phase: WritePhase::Verified {
                    record: original.clone(),
                },
            };
            let mut current = Some(original);
            let mut expected = IoError::Integrity;
            match fault {
                "missing-verified" => current = None,
                "missing-prepared" | "missing-begin" | "missing-aborted" => {
                    current = None;
                    journal.phase = match fault {
                        "missing-prepared" => WritePhase::Prepared,
                        "missing-begin" => WritePhase::BeginPending,
                        _ => WritePhase::Aborted { session: None },
                    };
                    expected = IoError::RepairUnavailable;
                }
                "unverified-record" => journal.phase = WritePhase::Prepared,
                "aborted-record" => journal.phase = WritePhase::Aborted { session: None },
                "intent" => journal.intent.operation = aid("different-operation"),
                "saved-version" => {
                    let WritePhase::Verified { record } = &mut journal.phase else {
                        unreachable!()
                    };
                    record.identity.version = aid("different-version");
                }
                "record-version" => current.as_mut().unwrap().identity.version = aid("2"),
                "backend" => {
                    current.as_mut().unwrap().identity.target.backend =
                        if backend == a::Backend::Nntp {
                            a::Backend::S3
                        } else {
                            a::Backend::Nntp
                        };
                }
                "account" => current.as_mut().unwrap().identity.target.account = aid("other"),
                "locator" => current.as_mut().unwrap().identity.target.locator = aid("other"),
                "envelope" => {
                    current
                        .as_mut()
                        .unwrap()
                        .identity
                        .target
                        .encryption
                        .envelope = aid("other");
                }
                "part" => current.as_mut().unwrap().parts[0].reference = aid("other-part"),
                _ => unreachable!(),
            }
            // Explicit serialized reference checkpoints, not a durable restart.
            io.provider_write =
                Some(serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap());
            io.provider_record = current;
            let mut storage = bridge(io, backend, auth.clone(), Fault::None);
            let restore = request_restore(
                service.catalogue_mut(),
                "object",
                905,
                1000,
                50,
                60,
                auth.as_ref(),
            );
            let work = work(&service, restore);
            let order = storage.cache.order.clone();
            let attempts = storage.cache.attempts.clone();
            let copies = storage.cache.copies.clone();
            let journal = storage.cache.provider_write.clone();
            let record = storage.cache.provider_record.clone();
            assert_eq!(
                storage.retrieve(&work).await,
                Err(expected.clone()),
                "{backend:?}/{fault}"
            );
            assert_eq!(storage.complete_restore(&work).await, Err(expected.clone()));
            assert_eq!(
                storage.verify_completed(&work, "untrusted").await,
                Err(expected.clone())
            );
            assert_eq!(
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
                .await,
                Err(Failure::Io(expected)),
                "{backend:?}/{fault}",
            );
            assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
            assert_eq!(storage.cache.order, order);
            assert_eq!(storage.cache.attempts, attempts);
            assert_eq!(storage.cache.copies, copies);
            assert_eq!(storage.cache.provider_write, journal);
            assert_eq!(storage.cache.provider_record, record);
            assert!(storage.cache.provider_keys.is_empty());
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.completed.is_empty());
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
        }
    }
}

#[tokio::test]
async fn provider_verified_journal_restores_exact_record_with_write_revoked() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        let record = record(&io, backend);
        let journal = WriteJournal {
            intent: record.intent(),
            phase: WritePhase::Verified {
                record: record.clone(),
            },
        };
        io.provider_write =
            Some(serde_json::from_slice(&serde_json::to_vec(&journal).unwrap()).unwrap());
        io.provider_record = Some(record);
        let mut storage = bridge(io, backend, auth.clone(), Fault::None);
        auth.denied.borrow_mut().insert("object:Write".into());
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            906,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let work = work(&service, restore);
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
        assert_eq!(storage.nntp.reads, usize::from(backend == a::Backend::Nntp));
        assert_eq!(storage.s3.reads, usize::from(backend == a::Backend::S3));
        assert_eq!(storage.cache.provider_write, Some(journal));
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
            service.catalogue().job(TENANT, restore).unwrap().state,
            JobState::Complete
        );
    }
}

#[tokio::test]
async fn provider_cache_acknowledgement_rechecks_immutable_record_before_returning_receipt() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for checkpoint in ["complete", "verify"] {
            let (mut service, mut io, _, _, auth) = hot_upload().await;
            let time = Time(Cell::new(60));
            // Synthetic prior NNTP proof only; no S3 safety-copy eviction permit.
            evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
            let original = record(&io, backend);
            io.provider_record = Some(original.clone());
            let mut storage = bridge(io, backend, auth.clone(), Fault::None);
            let restore = request_restore(
                service.catalogue_mut(),
                "object",
                907,
                1000,
                50,
                60,
                auth.as_ref(),
            );
            let work = work(&service, restore);
            if checkpoint == "complete" {
                storage.cache.provider_record_change = Some(checkpoint);
                assert_eq!(
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
                    .await,
                    Err(Failure::Io(IoError::Uncertain)),
                    "{backend:?}/{checkpoint}"
                );
            } else {
                storage.retrieve(&work).await.unwrap();
                let copy = storage.complete_restore(&work).await.unwrap();
                storage.cache.provider_record_change = Some(checkpoint);
                assert_eq!(
                    storage.verify_completed(&work, &copy.location).await,
                    Err(IoError::Integrity),
                    "{backend:?}/{checkpoint}"
                );
            }
            assert_ne!(storage.cache.provider_record.as_ref(), Some(&original));
            assert_ne!(
                service.catalogue().job(TENANT, restore).unwrap().state,
                JobState::Complete
            );
            assert!(service
                .catalogue()
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location
                .is_none());
            assert_eq!(storage.cache.completed.len(), 1);
            assert_eq!(storage.cache.copies.len(), 1);
            let location = storage.cache.completed[&inventory(&work)].clone();
            assert_eq!(
                storage.cache.copies[&location],
                storage.cache.fixture.bytes()
            );
            let copies = storage.cache.copies.clone();
            let completed = storage.cache.completed.clone();
            let keys = storage.cache.provider_keys.clone();

            // Repair only the fake inventory to its original identity. Reconcile
            // the existing completion, never refetch, replace or delete its bytes.
            storage.cache.provider_record = Some(original);
            storage.cache.provider_record_change = None;
            storage.retrieve(&work).await.unwrap();
            let copy = storage.complete_restore(&work).await.unwrap();
            assert_eq!(copy.location, location);
            assert_eq!(
                storage.verify_completed(&work, &location).await.unwrap(),
                copy
            );
            assert_eq!(storage.nntp.reads + storage.s3.reads, 1);
            assert_eq!(storage.cache.copies, copies);
            assert_eq!(storage.cache.completed, completed);
            assert_eq!(storage.cache.provider_keys, keys);
            assert!(storage.cache.pending.is_empty());
        }
    }
}

#[tokio::test]
async fn provider_completed_cache_reconciles_without_refetch_and_cleanup_is_attempt_local() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        // Prior eviction remains synthetic NNTP qualification, not S3 proof.
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        io.provider_record = Some(record(&io, backend));
        let mut storage = bridge(io, backend, auth.clone(), Fault::None);
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            903,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let work = work(&service, restore);
        storage.retrieve(&work).await.unwrap();
        let completed = storage.complete_restore(&work).await.unwrap();
        let saved_inventory = storage.cache.completed.clone();
        let saved_keys = storage.cache.provider_keys.clone();
        let saved_copies = storage.cache.copies.clone();
        assert!(service
            .catalogue()
            .generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .is_none());

        // A different worker's incomplete allocation can be cleaned without
        // removing a completed winner or another attempt's invisible bytes.
        let mut losing = work.clone();
        losing.attempt = 2;
        let mut other = work.clone();
        other.attempt = 3;
        storage.cache.pending.insert(allocation(&losing), vec![1]);
        storage.cache.pending.insert(allocation(&other), vec![2]);
        storage.cleanup_incomplete(&losing).await.unwrap();
        assert!(!storage.cache.pending.contains_key(&allocation(&losing)));
        assert_eq!(storage.cache.pending[&allocation(&other)], vec![2]);
        assert_eq!(storage.cache.completed, saved_inventory);
        assert_eq!(storage.cache.provider_keys, saved_keys);
        assert_eq!(storage.cache.copies, saved_copies);
        storage.cleanup_incomplete(&other).await.unwrap();

        // Reconnect only the explicitly serializable provider record. This is
        // reference inventory recovery, not a durable process/physical restart.
        storage.cache.provider_record = Some(
            serde_json::from_slice(
                &serde_json::to_vec(storage.cache.provider_record.as_ref().unwrap()).unwrap(),
            )
            .unwrap(),
        );
        storage.nntp.fault = Fault::Missing;
        storage.s3.fault = Fault::Missing;
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
        assert_eq!(storage.nntp.reads + storage.s3.reads, 1);
        assert_eq!(storage.cache.completed, saved_inventory);
        assert_eq!(storage.cache.provider_keys, saved_keys);
        assert_eq!(storage.cache.copies, saved_copies);
        assert!(storage.cache.pending.is_empty());
        assert_eq!(
            service.catalogue().job(TENANT, restore).unwrap().state,
            JobState::Complete
        );
        assert_eq!(
            service
                .catalogue()
                .generation(TENANT, GENERATION)
                .unwrap()
                .cache_location,
            Some(completed.location)
        );
    }
}

#[tokio::test]
async fn provider_recorded_cache_failure_never_heals_or_crosses_immutable_identity() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for fault in [
            "missing",
            "corrupt",
            "backend",
            "account",
            "locator",
            "version",
            "format",
            "mode",
            "key_epoch",
            "envelope",
        ] {
            let (mut service, mut io, _, _, auth) = hot_upload().await;
            let time = Time(Cell::new(60));
            evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
            io.provider_record = Some(record(&io, backend));
            let mut storage = bridge(io, backend, auth.clone(), Fault::None);
            let restore = request_restore(
                service.catalogue_mut(),
                "object",
                904,
                1000,
                50,
                60,
                auth.as_ref(),
            );
            let work = work(&service, restore);
            storage.retrieve(&work).await.unwrap();
            let completed = storage.complete_restore(&work).await.unwrap();
            let saved_inventory = storage.cache.completed.clone();
            let saved_keys = storage.cache.provider_keys.clone();
            let saved_record = storage.cache.provider_record.as_mut().unwrap();
            match fault {
                "missing" => {
                    storage.cache.copies.remove(&completed.location);
                }
                "corrupt" => storage.cache.copies.get_mut(&completed.location).unwrap()[0] ^= 1,
                "backend" => {
                    saved_record.identity.target.backend = if backend == a::Backend::Nntp {
                        a::Backend::S3
                    } else {
                        a::Backend::Nntp
                    };
                }
                "account" => saved_record.identity.target.account = aid("different-account"),
                "locator" => saved_record.identity.target.locator = aid("different-locator"),
                "version" => saved_record.identity.version = aid("2"),
                "format" => {
                    saved_record.identity.target.encryption.format = aid("different-format")
                }
                "mode" => saved_record.identity.target.encryption.mode = 1,
                "key_epoch" => {
                    saved_record.identity.target.encryption.key_epoch = aid("different-epoch");
                }
                "envelope" => {
                    saved_record.identity.target.encryption.envelope = aid("different-envelope");
                }
                _ => unreachable!(),
            }
            let damaged_copies = storage.cache.copies.clone();
            assert_eq!(
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
                .await,
                Err(Failure::Io(IoError::Integrity)),
                "{backend:?}/{fault}"
            );
            assert_eq!(storage.nntp.reads + storage.s3.reads, 1);
            assert_eq!(storage.cache.completed, saved_inventory);
            assert_eq!(storage.cache.provider_keys, saved_keys);
            assert_eq!(storage.cache.copies, damaged_copies);
            assert!(storage.cache.pending.is_empty());
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
        }
    }
}
