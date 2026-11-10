use super::*;

fn work(c: &MemoryCatalogue, job: JobId) -> Work {
    let job = c.job(TENANT, job).unwrap();
    let generation = c.generation(TENANT, job.generation).unwrap();
    Work {
        tenant: TENANT,
        event: job_event(c, job.id),
        attempt: job.checkpoint + 1,
        inventory_ref: job.checkpoint_ref.clone().unwrap_or_else(|| {
            format!(
                "composition-v1/{}/{}/{}",
                TENANT.0, job.generation.0, job.id.0
            )
        }),
        job,
        metadata: generation.metadata,
        retained_location: generation.cache_location,
        claim_until: 100,
        budget: budget(),
    }
}

#[tokio::test]
async fn provider_explicit_abort_before_begin_is_terminal_without_provider_effects() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
        let work = work(&c, job);
        assert_eq!(
            storage.abort_write(&work).await,
            Ok(a::AbortOutcome::IncompleteRemoved)
        );
        reconnect(&mut storage);
        assert_eq!(
            storage.abort_write(&work).await,
            Ok(a::AbortOutcome::IncompleteRemoved)
        );
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Cancelled))
        );
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::Aborted { session: None }
        ));
        assert!(writer(&storage, backend).calls.is_empty());
        assert!(storage.cache.provider_record.is_none());
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_explicit_abort_ready_session_distinguishes_s3_removal_from_nntp_irreversibility()
{
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
        multipart(&mut storage);
        checkpoint_first_part(&mut c, &mut storage, job, &auth, &time).await;
        auth.denied.borrow_mut().clear();
        let work = work(&c, job);
        let original = storage.cache.provider_write.clone().unwrap();
        // Rejected current authority cannot even advance the local checkpoint.
        auth.denied.borrow_mut().insert("object:Write".into());
        assert_eq!(storage.abort_write(&work).await, Err(IoError::Cancelled));
        assert_eq!(storage.cache.provider_write.as_ref(), Some(&original));
        assert_eq!(writer(&storage, backend).calls, ["begin", "part"]);
        auth.denied.borrow_mut().clear();
        assert_eq!(
            storage.abort_write(&work).await,
            Ok(if backend == a::Backend::S3 {
                a::AbortOutcome::IncompleteRemoved
            } else {
                a::AbortOutcome::Irreversible
            })
        );
        assert_eq!(writer(&storage, backend).calls, ["begin", "part", "abort"]);
        reconnect(&mut storage);
        time.0.set(13);
        let expected = if backend == a::Backend::S3 {
            assert!(matches!(
                storage.cache.provider_write.as_ref().unwrap().phase,
                WritePhase::Aborted { session: Some(_) }
            ));
            assert!(writer(&storage, backend).session.is_none());
            assert_eq!(
                storage.abort_write(&work).await,
                Ok(a::AbortOutcome::IncompleteRemoved)
            );
            IoError::Cancelled
        } else {
            assert!(matches!(
                storage.cache.provider_write.as_ref().unwrap().phase,
                WritePhase::AbortPending { .. }
            ));
            assert_eq!(storage.abort_write(&work).await, Err(IoError::Uncertain));
            IoError::Uncertain
        };
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(expected))
        );
        assert_eq!(writer(&storage, backend).calls, ["begin", "part", "abort"]);
        assert!(storage.cache.provider_record.is_none());
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_explicit_abort_uncertain_effects_requires_settlement_and_never_deletes_committed()
{
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for fault in [WriteFault::Begin, WriteFault::Part, WriteFault::Commit] {
            let (mut c, mut storage, job, auth, time) = staged(backend, fault).await;
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            let work = work(&c, job);
            let original = storage.cache.provider_write.clone().unwrap();
            let result = storage.abort_write(&work).await;
            if matches!(fault, WriteFault::Commit) {
                assert_eq!(result, Ok(a::AbortOutcome::Irreversible));
                assert!(matches!(
                    storage.cache.provider_write.as_ref().unwrap().phase,
                    WritePhase::Verified { .. }
                ));
                assert!(storage.cache.provider_record.is_some());
                // Repeated abort of a verified record does not invoke the provider.
                let calls = writer(&storage, backend).calls.clone();
                assert_eq!(
                    storage.abort_write(&work).await,
                    Ok(a::AbortOutcome::Irreversible)
                );
                assert_eq!(writer(&storage, backend).calls, calls);
            } else {
                assert_eq!(result, Err(IoError::Uncertain));
                if matches!(fault, WriteFault::Begin) {
                    assert_eq!(storage.cache.provider_write.as_ref(), Some(&original));
                }
                if matches!(fault, WriteFault::Part) {
                    assert!(matches!(
                        storage.cache.provider_write.as_ref().unwrap().phase,
                        WritePhase::AbortRequested { .. }
                    ));
                    reconnect(&mut storage);
                    let calls = writer(&storage, backend).calls.clone();
                    time.0.set(13);
                    assert_eq!(
                        attempt(&mut c, &mut storage, job, &auth, &time).await,
                        Err(Failure::Io(IoError::Uncertain))
                    );
                    assert_eq!(writer(&storage, backend).calls, calls);
                    writer_mut(&mut storage, backend).settled_absent = true;
                    assert_eq!(
                        storage.abort_write(&work).await,
                        Ok(if backend == a::Backend::S3 {
                            a::AbortOutcome::IncompleteRemoved
                        } else {
                            a::AbortOutcome::Irreversible
                        })
                    );
                }
            }
            assert_retained(&c, &storage, job, backend);
        }
    }
}

#[tokio::test]
async fn provider_lost_revoked_or_interrupted_abort_retains_pending_journal_without_replay() {
    for fault in [
        WriteFault::AbortLost,
        WriteFault::AbortRevoke,
        WriteFault::AbortStall,
    ] {
        let backend = a::Backend::S3;
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
        multipart(&mut storage);
        checkpoint_first_part(&mut c, &mut storage, job, &auth, &time).await;
        auth.denied.borrow_mut().clear();
        writer_mut(&mut storage, backend).fault = fault;
        let work = work(&c, job);
        let events = storage.control.events.clone();
        let result = if matches!(fault, WriteFault::AbortStall) {
            let mut future = Box::pin(storage.abort_write(&work));
            assert!(std::future::poll_fn(|cx| {
                std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx))
            })
            .await
            .is_pending());
            events.send_replace(Some(a::Failure::Cancelled));
            future.await
        } else {
            storage.abort_write(&work).await
        };
        assert_eq!(result, Err(IoError::Uncertain));
        let pending = storage.cache.provider_write.clone().unwrap();
        assert!(matches!(pending.phase, WritePhase::AbortPending { .. }));
        reconnect(&mut storage);
        events.send_replace(None);
        auth.denied.borrow_mut().clear();
        assert_eq!(storage.abort_write(&work).await, Err(IoError::Uncertain));
        time.0.set(13);
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Uncertain))
        );
        assert_eq!(storage.cache.provider_write.as_ref(), Some(&pending));
        assert_eq!(writer(&storage, backend).calls, ["begin", "part", "abort"]);
        assert!(storage.cache.provider_record.is_none());
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_abort_checks_scope_session_and_durable_terminal_acknowledgement() {
    let backend = a::Backend::S3;
    let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
    multipart(&mut storage);
    checkpoint_first_part(&mut c, &mut storage, job, &auth, &time).await;
    auth.denied.borrow_mut().clear();
    let work = work(&c, job);
    let original = storage.cache.provider_write.clone().unwrap();
    let mut foreign = work.clone();
    foreign.tenant = TenantId(2);
    assert_eq!(storage.abort_write(&foreign).await, Err(IoError::Integrity));
    for phase in 0..3 {
        let mut session = writer(&storage, backend).session.clone().unwrap();
        session.intent.target.account = aid("foreign-account");
        storage.cache.provider_write.as_mut().unwrap().phase = match phase {
            0 => WritePhase::AbortRequested { session },
            1 => WritePhase::AbortPending { session },
            _ => WritePhase::Aborted {
                session: Some(session),
            },
        };
        assert_eq!(storage.abort_write(&work).await, Err(IoError::Integrity));
    }
    storage.cache.provider_write = None;
    assert_eq!(
        storage.abort_write(&work).await,
        Err(IoError::RepairUnavailable)
    );
    assert_eq!(writer(&storage, backend).calls, ["begin", "part"]);
    storage.cache.provider_write = Some(original);
    storage.cache.inject = Injection::Uncertain;
    assert_eq!(storage.abort_write(&work).await, Err(IoError::Uncertain));
    assert!(matches!(
        storage.cache.provider_write.as_ref().unwrap().phase,
        WritePhase::AbortPending { .. }
    ));
    assert!(writer(&storage, backend).session.is_none());
    storage.cache.inject = Injection::None;
    reconnect(&mut storage);
    assert_eq!(storage.abort_write(&work).await, Err(IoError::Uncertain));
    assert_eq!(writer(&storage, backend).calls, ["begin", "part", "abort"]);
    assert_retained(&c, &storage, job, backend);
}
