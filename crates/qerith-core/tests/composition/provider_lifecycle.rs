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
