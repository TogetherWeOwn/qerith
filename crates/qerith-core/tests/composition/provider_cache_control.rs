use super::*;
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

#[tokio::test]
async fn provider_cache_ready_completion_rechecks_current_authority() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, _, _, auth) = hot_upload().await;
        let time = Time(Cell::new(60));
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
        let work = lifecycle::work(&service, restore);
        storage.retrieve(&work).await.unwrap();
        storage.cache.revoke_at_complete = Some((auth.clone(), "object:Restore".into()));
        assert_eq!(
            storage.complete_restore(&work).await,
            Err(IoError::Uncertain)
        );
        assert_eq!(storage.cache.copies.len(), 1);
        assert_eq!(storage.cache.completed.len(), 1);
        assert!(service
            .catalogue()
            .generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .is_none());
    }
}

#[tokio::test]
async fn stalled_provider_cache_calls_wake_without_publication_or_completion_loss() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for phase in ["reconcile", "begin", "complete", "verify"] {
            for stop in [
                a::Failure::Denied,
                a::Failure::Cancelled,
                a::Failure::Deadline,
            ] {
                let (mut service, mut io, _, _, auth) = hot_upload().await;
                let time = Time(Cell::new(60));
                // This setup is unchanged synthetic NNTP eviction, not S3 proof.
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
                let work = lifecycle::work(&service, restore);
                let completed = if phase == "verify" {
                    storage.retrieve(&work).await.unwrap();
                    Some(storage.complete_restore(&work).await.unwrap())
                } else {
                    None
                };
                storage.cache.provider_cache_stall = Some(phase);
                tokio::time::pause();
                let events = storage.control.events.clone();
                let rules = Rules::default();
                let limits = budget();
                let result;
                {
                    let run = async {
                        if let Some(copy) = &completed {
                            storage
                                .verify_completed(&work, &copy.location)
                                .await
                                .map(|_| ())
                                .map_err(Failure::Io)
                        } else {
                            run_once(
                                service.catalogue_mut(),
                                &mut storage,
                                TENANT,
                                work.event,
                                &limits,
                                &time,
                                &rules,
                                &MockQualification,
                                auth.as_ref(),
                            )
                            .await
                        }
                    };
                    let mut run = std::pin::pin!(run);
                    let wakes = Arc::new(Wakes::default());
                    let waker = wakes.clone().into();
                    let mut cx = Context::from_waker(&waker);
                    assert!(run.as_mut().poll(&mut cx).is_pending(), "{phase}");
                    assert_eq!(wakes.0.load(Ordering::SeqCst), 0);
                    match stop {
                        a::Failure::Denied => {
                            auth.denied.borrow_mut().insert("object:Restore".into());
                            events.send_replace(None);
                        }
                        a::Failure::Cancelled => {
                            events.send_replace(Some(stop));
                        }
                        a::Failure::Deadline => tokio::time::advance(Duration::from_secs(31)).await,
                        _ => unreachable!(),
                    }
                    assert!(wakes.0.load(Ordering::SeqCst) > 0, "{phase}/{stop:?}");
                    result = tokio::time::timeout(Duration::from_secs(1), run)
                        .await
                        .expect("cache stall must be interrupted");
                }
                assert_eq!(
                    result,
                    Err(Failure::Io(if phase == "complete" {
                        IoError::Uncertain
                    } else {
                        IoError::Cancelled
                    }))
                );
                let reads = usize::from(matches!(phase, "complete" | "verify"));
                assert_eq!(storage.nntp.reads + storage.s3.reads, reads);
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
                if reads == 1 {
                    // Completion happened before the lost acknowledgement; never
                    // delete it, or refetch after reauthorization/reconciliation.
                    assert_eq!(storage.cache.copies.len(), 1);
                    assert_eq!(storage.cache.completed.len(), 1);
                    let copies = storage.cache.copies.clone();
                    let inventory = storage.cache.completed.clone();
                    storage.cache.provider_cache_stall = None;
                    events.send_replace(None);
                    auth.denied.borrow_mut().remove("object:Restore");
                    storage.control.deadline =
                        tokio::time::Instant::now() + Duration::from_secs(30);
                    storage.nntp.fault = Fault::Missing;
                    storage.s3.fault = Fault::Missing;
                    time.0.set(61);
                    if phase == "complete" {
                        let waiting = service.catalogue().job(TENANT, restore).unwrap();
                        assert_eq!(waiting.state, JobState::RetryWait { not_before: 62 });
                        assert_eq!(
                            run_once(
                                service.catalogue_mut(),
                                &mut storage,
                                TENANT,
                                work.event,
                                &limits,
                                &time,
                                &rules,
                                &MockQualification,
                                auth.as_ref(),
                            )
                            .await,
                            Err(Failure::Catalogue(Error::Conflict))
                        );
                        assert_eq!(service.catalogue().job(TENANT, restore).unwrap(), waiting);
                        assert_eq!(storage.nntp.reads + storage.s3.reads, 1);
                        assert_eq!(storage.cache.copies, copies);
                        assert_eq!(storage.cache.completed, inventory);
                        time.0.set(62);
                    }
                    run_once(
                        service.catalogue_mut(),
                        &mut storage,
                        TENANT,
                        work.event,
                        &limits,
                        &time,
                        &rules,
                        &MockQualification,
                        auth.as_ref(),
                    )
                    .await
                    .unwrap();
                    assert_eq!(storage.nntp.reads + storage.s3.reads, 1);
                    assert_eq!(storage.cache.copies, copies);
                    assert_eq!(storage.cache.completed, inventory);
                    assert_eq!(
                        service.catalogue().job(TENANT, restore).unwrap().state,
                        JobState::Complete
                    );
                } else {
                    assert!(storage.cache.copies.is_empty());
                    assert!(storage.cache.completed.is_empty());
                }
                tokio::time::resume();
            }
        }
    }
}
