#![cfg(feature = "native-tls")]

#[path = "archive_parity/fixture.rs"]
mod fixture;
#[path = "archive_clients/storage.rs"]
#[allow(dead_code)]
mod storage;
#[allow(dead_code)]
mod support;

use fixture::*;
use qerith_core::{catalogue::*, composition::*, native as n, operations as o};

#[tokio::test]
async fn empty_spool_post_exact_eviction_and_three_adapter_restore_states() {
    let mut f = Fixture::archived().await;
    f.stat(false).await;
    f.download(false).await;
    f.evict();
    let job = f.restore(&scope(0), "restore").await;
    f.status(&scope(0), &job, o::JobState::Queued).await;
    f.download(false).await;

    // A real worker claim exposes Running, not a fabricated transport state.
    let physical = f.physical();
    f.service
        .catalogue_mut()
        .claim(TENANT, physical, 11, 12)
        .unwrap();
    f.status(&scope(0), &job, o::JobState::Running).await;
    f.stat(false).await;
    f.download(false).await;
    f.set_now(13);
    f.run().await.unwrap();
    assert_eq!(f.io.inner.cold_retrievals, 1);
    f.status(&scope(0), &job, o::JobState::Succeeded).await;
    f.stat(true).await;
    f.download(true).await;
    f.result(&scope(0), &job, true);

    // Expired logical availability cannot be rescued by physical cache presence.
    f.set_now(63);
    assert_eq!(f.io.inner.delivery.len(), 1);
    f.stat(false).await;
    f.download(false).await;
    f.status(&scope(0), &job, o::JobState::Succeeded).await;
}

#[tokio::test]
async fn twenty_scoped_subscribers_coalesce_cancel_one_and_reconnect() {
    let mut f = Fixture::archived().await;
    f.evict();
    let mut jobs = Vec::new();
    for subscriber in 0..20 {
        jobs.push(
            f.restore(&scope(subscriber), &format!("restore_{subscriber}"))
                .await,
        );
    }
    assert_eq!(f.service.catalogue().outbox(TENANT).len(), 1);
    assert_eq!(
        f.service
            .catalogue()
            .job(TENANT, f.physical())
            .unwrap()
            .checkpoint,
        0
    );
    let handles: std::collections::BTreeSet<_> = jobs.iter().map(|j| j.handle.clone()).collect();
    assert_eq!(handles.len(), 20, "logical handles remain principal-scoped");
    f.cancel(&scope(0), &jobs[0], "cancel_one").await;
    f.status(&scope(0), &jobs[0], o::JobState::Cancelled).await;
    for (subscriber, job) in jobs.iter().enumerate().skip(1) {
        f.status(&scope(subscriber), job, o::JobState::Queued).await;
    }
    assert!(f.io.inner.delivery.is_empty());
    // Drop the service and all adapter instances; retain only the explicit model
    // and live trusted ports. This is not database durability or a socket test.
    f.reconnect();
    let replay = f.restore(&scope(1), "restore_1").await;
    assert_eq!(
        replay.handle, jobs[1].handle,
        "lost response does not add demand"
    );
    assert_eq!(f.service.catalogue().outbox(TENANT).len(), 1);
    f.run().await.unwrap();
    assert_eq!(f.io.inner.cold_retrievals, 1);
    assert!(f.service.catalogue().outbox(TENANT).is_empty());
    f.status(&scope(0), &jobs[0], o::JobState::Cancelled).await;
    for (subscriber, job) in jobs.iter().enumerate().skip(1) {
        f.status(&scope(subscriber), job, o::JobState::Succeeded)
            .await;
    }
    f.download(true).await;
    f.denied_status(&scope(1), &jobs[2]).await;
    let foreign = o::Scope {
        tenant: id("other"),
        ..scope(1)
    };
    f.denied_status(&foreign, &jobs[1]).await;
}

#[tokio::test]
async fn last_cancel_avoids_physical_work_across_adapters() {
    let mut f = Fixture::archived().await;
    f.evict();
    let first = f.restore(&scope(0), "first").await;
    let second = f.restore(&scope(1), "second").await;
    f.cancel(&scope(0), &first, "cancel_first").await;
    f.cancel(&scope(1), &second, "cancel_last").await;
    let trace = f.io.inner.trace.0.clone();
    assert_eq!(f.run().await, Err(Failure::Io(IoError::Cancelled)));
    assert_eq!(f.io.inner.trace.0, trace);
    assert_eq!(f.io.inner.cold_retrievals, 0);
    f.io.inner.assert_empty();
    assert!(f.service.catalogue().outbox(TENANT).is_empty());
    f.status(&scope(0), &first, o::JobState::Cancelled).await;
    f.status(&scope(1), &second, o::JobState::Cancelled).await;
    f.download(false).await;
}

#[tokio::test]
async fn failed_and_deadline_expired_restore_never_authorize_reads() {
    for expired in [false, true] {
        let mut f = Fixture::archived().await;
        f.evict();
        let job = f.restore(&scope(0), "restore").await;
        if expired {
            f.set_now(61);
        } else {
            f.io.inner.fail = true;
        }
        assert!(f.run().await.is_err());
        assert_eq!(
            f.service
                .catalogue()
                .job(TENANT, f.physical())
                .unwrap()
                .state,
            if expired {
                JobState::Expired
            } else {
                JobState::FailedUnrecoverable
            }
        );
        f.status(&scope(0), &job, o::JobState::Failed).await;
        f.result(&scope(0), &job, false);
        f.stat(false).await;
        f.download(false).await;
        f.io.inner.assert_empty();
        assert_eq!(f.io.inner.cold_retrievals, 0);
    }
}

#[tokio::test]
async fn lost_publication_reuses_verified_completion_without_second_cold_fetch() {
    let mut f = Fixture::archived().await;
    f.evict();
    let job = f.restore(&scope(0), "restore").await;
    let physical = f.physical();
    let event = f.event(physical);
    let fence = f
        .service
        .catalogue_mut()
        .claim(TENANT, physical, 11, 12)
        .unwrap();
    f.service
        .catalogue_mut()
        .transition(
            TENANT,
            fence.clone(),
            Transition::Checkpoint {
                expected: 0,
                next: 1,
                inventory_ref: "lost-publication".into(),
            },
            11,
            &f.auth,
        )
        .unwrap();
    let work = Work {
        tenant: TENANT,
        event,
        job: f.service.catalogue().job(TENANT, physical).unwrap(),
        metadata: f
            .service
            .catalogue()
            .generation(TENANT, f.generation())
            .unwrap()
            .metadata,
        retained_location: None,
        inventory_ref: "lost-publication".into(),
        attempt: 1,
        claim_until: 12,
        budget: budget(),
    };
    f.io.retrieve(&work).await.unwrap();
    let complete = f.io.complete_restore(&work).await.unwrap();
    let location = complete.location.clone();
    assert_eq!(f.io.inner.cold_retrievals, 1);
    f.stat(false).await;
    f.download(false).await;
    f.set_now(13);
    f.reconnect();
    assert_eq!(
        f.service.catalogue_mut().transition(
            TENANT,
            fence,
            Transition::PublishRestore { copy: complete },
            13,
            &f.auth
        ),
        Err(Error::Fenced)
    );
    f.run().await.unwrap();
    assert_eq!(f.io.inner.cold_retrievals, 1);
    assert_eq!(
        f.io.inner.delivery.keys().collect::<Vec<_>>(),
        vec![&location]
    );
    f.status(&scope(0), &job, o::JobState::Succeeded).await;
    f.download(true).await;
}

#[tokio::test]
async fn current_tenant_revocation_removal_and_moderation_gate_all_projections() {
    for drift in ["tenant", "revoked", "removed", "moderated"] {
        let mut f = Fixture::archived().await;
        f.evict();
        let job = f.restore(&scope(0), "restore").await;
        f.run().await.unwrap();
        let transfer = f.download(true).await.unwrap();
        let mut caller = scope(0);
        match drift {
            "tenant" => caller.tenant = id("other"),
            "revoked" => {
                f.auth.denied.borrow_mut().insert("object".into());
            }
            "removed" => {
                f.service
                    .catalogue_mut()
                    .transact(
                        TENANT,
                        OperationId(99999),
                        Mutation::Tombstone {
                            name: "object".into(),
                            expected_revision: 1,
                        },
                        11,
                        &f.auth,
                    )
                    .unwrap();
            }
            "moderated" => {
                let generation = f.generation();
                f.service
                    .catalogue_mut()
                    .set_moderation(TENANT, generation, 1, true)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before = f.service.allocations();
        let outbox = f.service.catalogue().outbox(TENANT);
        f.denied_status(&caller, &job).await;
        for (operation, action, fields) in [
            (
                o::Operation::Stat,
                n::Action::Stat(f.target()),
                f.target_fields(),
            ),
            (
                o::Operation::AuthorizeDownload,
                n::Action::Download(n::Download {
                    target: f.target(),
                    range: None,
                    max_bytes: BYTES as u64,
                }),
                f.download_fields("denied_download"),
            ),
            (
                o::Operation::Restore,
                n::Action::Restore(n::Restore {
                    target: f.target(),
                    max_bytes: BYTES as u64,
                    max_seconds: 50,
                }),
                f.restore_fields("denied_restore"),
            ),
        ] {
            assert!(f.parity(&caller, operation, fields.clone()).is_err());
            let body = f.native_snapshot(&caller, "denied", action).await;
            assert!(
                matches!(body, n::ResponseBody::Error(_)),
                "{drift}: {body:?}"
            );
        }
        assert!(f.service.redeem(&caller, &transfer.handle).is_err());
        assert_eq!(f.service.allocations(), before);
        assert_eq!(f.service.catalogue().outbox(TENANT), outbox);
    }
}
