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

// Exercise the storage boundary with generated empty ciphertext. This does not
// qualify an empty media container or authorize eviction of an S3 safety copy.
async fn empty_restore(
    backend: a::Backend,
    fault: Fault,
) -> (ProviderStorage<Io, Provider, Provider, Current>, Work) {
    let (mut service, mut io, _, _, auth) = hot_upload().await;
    let time = Time(Cell::new(60));
    evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
    let restore = request_restore(
        service.catalogue_mut(),
        "object",
        980,
        1000,
        50,
        60,
        auth.as_ref(),
    );
    let mut work = work(&service, restore);
    io.fixture = FixtureC::committed(io.fixture.key(), Vec::new());
    work.metadata.identity = io.identity();
    work.metadata.checksums.clear();
    io.provider_record = Some(record(&io, backend));
    (bridge(io, backend, auth, fault), work)
}

#[tokio::test]
async fn empty_provider_restore_requires_exact_stat_but_warm_reuse_does_not() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut storage, work) = empty_restore(backend, Fault::None).await;
        storage.retrieve(&work).await.unwrap();
        assert_eq!(storage.nntp.stats, usize::from(backend == a::Backend::Nntp));
        assert_eq!(storage.s3.stats, usize::from(backend == a::Backend::S3));
        assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
        let copy = storage.complete_restore(&work).await.unwrap();
        assert_eq!(copy.identity, work.metadata.identity);
        assert!(storage.cache.copies[&copy.location].is_empty());
        let completed = storage.cache.completed.clone();
        // A verified completion is independent of subsequent provider availability.
        storage.nntp.fault = Fault::Missing;
        storage.s3.fault = Fault::Missing;
        storage.retrieve(&work).await.unwrap();
        assert_eq!(storage.nntp.stats + storage.s3.stats, 1);
        assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
        assert_eq!(storage.cache.completed, completed);
        assert_eq!(storage.complete_restore(&work).await.unwrap(), copy);
    }
}

#[tokio::test]
async fn empty_provider_restore_refuses_missing_changed_or_revoked_stat_before_staging() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for (fault, expected) in [
            (Fault::Missing, IoError::RepairUnavailable),
            (Fault::Corrupt, IoError::Integrity),
            (Fault::Revoke, IoError::Cancelled),
        ] {
            let (mut storage, work) = empty_restore(backend, fault).await;
            let original = storage.cache.provider_record.clone();
            assert_eq!(storage.retrieve(&work).await, Err(expected));
            assert_eq!(storage.nntp.stats + storage.s3.stats, 1);
            assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.provider_keys.is_empty());
            assert!(storage.cache.completed.is_empty());
            assert!(storage.cache.copies.is_empty());
            assert_eq!(storage.cache.provider_record, original);
        }
    }
}

#[tokio::test]
async fn empty_provider_stat_is_interrupted_by_current_control() {
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
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut storage, work) = empty_restore(backend, Fault::UncontrolledStall).await;
        let events = storage.control.events.clone();
        let wakes = Arc::new(Wakes::default());
        let waker = std::task::Waker::from(wakes.clone());
        let mut cx = Context::from_waker(&waker);
        {
            let mut retrieve = std::pin::pin!(storage.retrieve(&work));
            assert!(retrieve.as_mut().poll(&mut cx).is_pending());
            let before = wakes.0.load(Ordering::SeqCst);
            events.send_replace(Some(a::Failure::Cancelled));
            assert!(wakes.0.load(Ordering::SeqCst) > before);
            assert_eq!(
                retrieve.as_mut().poll(&mut cx),
                Poll::Ready(Err(IoError::Cancelled))
            );
        }
        assert_eq!(storage.nntp.stats + storage.s3.stats, 1);
        assert_eq!(storage.nntp.reads + storage.s3.reads, 0);
        assert!(storage.cache.pending.is_empty());
        assert!(storage.cache.provider_keys.is_empty());
        assert!(storage.cache.completed.is_empty());
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
async fn provider_retained_verified_journal_still_cleans_exact_restore_attempt_allocation() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
        evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
        // A retained Verified journal from the original archive write resolves
        // for this generation's restore work; it must not suppress cleanup of
        // a distinct restore attempt allocation.
        let stored = record(&io, backend);
        io.provider_write = Some(WriteJournal {
            intent: stored.intent(),
            phase: WritePhase::Verified {
                record: stored.clone(),
            },
        });
        let mut storage = bridge(io, backend, auth.clone(), Fault::None);
        let restore = request_restore(
            service.catalogue_mut(),
            "object",
            913,
            1000,
            50,
            60,
            auth.as_ref(),
        );
        let work = work(&service, restore);
        storage.retrieve(&work).await.unwrap();
        let completed = storage.complete_restore(&work).await.unwrap();
        let saved_completed = storage.cache.completed.clone();
        let saved_keys = storage.cache.provider_keys.clone();
        let saved_copies = storage.cache.copies.clone();

        let mut losing = work.clone();
        losing.attempt = 2;
        let mut other = work.clone();
        other.attempt = 3;
        storage.cache.pending.insert(allocation(&losing), vec![1]);
        storage.cache.pending.insert(allocation(&other), vec![2]);
        storage.cleanup_incomplete(&losing).await.unwrap();
        assert!(!storage.cache.pending.contains_key(&allocation(&losing)));
        assert_eq!(storage.cache.pending[&allocation(&other)], vec![2]);
        assert_eq!(storage.cache.completed, saved_completed);
        assert_eq!(storage.cache.provider_keys, saved_keys);
        assert_eq!(storage.cache.copies, saved_copies);
        // Cleanup is cache-local: no remote abort/delete is issued.
        assert_eq!(
            storage.nntp.reads + storage.s3.reads,
            1,
            "only the restore read reached the provider"
        );
        assert_eq!(storage.nntp.stats + storage.s3.stats, 0);
        storage.cleanup_incomplete(&other).await.unwrap();
        assert!(storage.cache.pending.is_empty());

        // Write work with the same retained journal still preserves safety
        // bytes; cleanup never discards an interrupted write's allocation.
        let mut archive_work = work.clone();
        archive_work.job.kind = JobKind::Archive;
        storage
            .cache
            .pending
            .insert(allocation(&archive_work), vec![3]);
        storage.cleanup_incomplete(&archive_work).await.unwrap();
        assert_eq!(storage.cache.pending[&allocation(&archive_work)], vec![3]);
        assert_eq!(storage.cache.completed, saved_completed);
        assert_eq!(storage.cache.copies, saved_copies);
        assert_eq!(
            completed.location,
            saved_copies.keys().next().unwrap().clone()
        );
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
