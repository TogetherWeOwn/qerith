use super::*;

#[tokio::test]
async fn worker_revocation_sanitizes_denial_but_retains_internal_cleanup() {
    for revoked in ["object:Write", "key_ref", "root"] {
        let (mut service, mut io, transfer, job, auth) = pending_upload().await;
        fully_stage(&mut service, &io, &transfer);
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&transfer),
        )
        .unwrap();
        io.revoke_at_upload = Some((auth.clone(), revoked.into()));
        let failure = service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &Time(Cell::new(10)),
                &Rules::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(failure, o::Failure::new(o::ErrorCode::Denied));
        let calls = io.order.len();
        let outbox = service.catalogue().outbox(TENANT);
        auth.denied.borrow_mut().clear();
        service =
            s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), 10)
                .unwrap();
        let o::Output::Cancel { outcome, job } = parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "revoked_worker_cancel"),
            ],
        )
        .unwrap() else {
            panic!("cancel");
        };
        assert_eq!(outcome, o::CancelOutcome::Requested);
        assert_eq!(job.effects, o::Effects::Unknown);
        assert_eq!(io.order.len(), calls);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
    }
}

#[tokio::test]
async fn obsolete_committed_jobs_retain_effects_without_bypassing_live_authority() {
    let (mut service, mut io, original, job, auth) = hot_upload().await;
    let mut intent = upload_intent(&io);
    intent.precondition = n::Precondition::Matches(nid(original.target.generation.as_str()));
    service
        .bind_upload(&scope(), id("successor"), id("root"), intent)
        .unwrap();
    let o::Output::Upload { transfer, .. } = parity(
        &mut service,
        &scope(),
        o::Operation::InitiateUpload,
        vec![
            text("reference", "object"),
            text("generation", original.target.generation.as_str()),
            text("identity", "successor"),
            ("max_bytes".into(), o::Value::Number(io.identity().length)),
        ],
    )
    .unwrap() else {
        panic!("upload");
    };
    fully_stage(&mut service, &io, &transfer);
    let mut fields = commit_fields(&transfer);
    fields.retain(|(name, _)| name != "identity");
    fields.push(text("identity", "successor_commit"));
    parity(&mut service, &scope(), o::Operation::CommitUpload, fields).unwrap();
    service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap();
    service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    let calls = io.order.len();
    let outbox = service.catalogue().outbox(TENANT);
    let allocations = service.allocations();
    for operation in [o::Operation::Status, o::Operation::Result] {
        assert_rejection_parity(
            &mut service,
            operation,
            vec![text("job", job.handle.as_str())],
            o::ErrorCode::PreconditionFailed,
            o::Effects::Committed,
        );
    }
    let failure = service
        .finish_upload(
            &scope(),
            &original.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        failure,
        o::Failure {
            code: o::ErrorCode::PreconditionFailed,
            effects: o::Effects::Committed
        }
    );
    auth.denied.borrow_mut().insert("object:Read".into());
    assert_rejection_parity(
        &mut service,
        o::Operation::Status,
        vec![text("job", job.handle.as_str())],
        o::ErrorCode::Denied,
        o::Effects::None,
    );
    auth.denied.borrow_mut().insert("object:Write".into());
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &original.handle,
                &mut io,
                &budget(),
                &Time(Cell::new(10)),
                &Rules::default()
            )
            .await
            .unwrap_err(),
        o::Failure::new(o::ErrorCode::Denied)
    );
    assert_eq!(io.order.len(), calls);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
    assert_eq!(service.allocations(), allocations);
}

#[tokio::test]
async fn restore_cancel_revocation_precedes_record_admission_and_effect_projection() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let o::Output::Job(job) = parity(
        &mut service,
        &scope(),
        o::Operation::Restore,
        vec![
            text("reference", "object"),
            text("generation", upload.target.generation.as_str()),
            text("identity", "cancel_grant_restore"),
            ("availability_seconds".into(), o::Value::Number(50)),
        ],
    )
    .unwrap() else {
        panic!("restore");
    };
    auth.denied.borrow_mut().insert("object:Restore".into());
    let mut bounded = limits();
    bounded.records = 1;
    service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        bounded,
        profile(),
        10,
    )
    .unwrap();
    let fields = vec![
        text("job", job.handle.as_str()),
        text("identity", "cancel_grant"),
    ];
    assert_rejection_parity(
        &mut service,
        o::Operation::Cancel,
        fields.clone(),
        o::ErrorCode::Denied,
        o::Effects::None,
    );
    auth.denied.borrow_mut().clear();
    assert_rejection_parity(
        &mut service,
        o::Operation::Cancel,
        fields,
        o::ErrorCode::QuotaExceeded,
        o::Effects::Accepted,
    );
    assert!(!io.order.is_empty());
}

#[tokio::test]
async fn restore_conflict_and_policy_rejections_use_live_bound_job_effects() {
    for completed in [false, true] {
        let (mut service, mut io, upload, _, auth) = hot_upload().await;
        let fields = vec![
            text("reference", "object"),
            text("generation", upload.target.generation.as_str()),
            text("identity", "live_restore"),
            ("availability_seconds".into(), o::Value::Number(50)),
        ];
        let o::Output::Job(job) = parity(
            &mut service,
            &scope(),
            o::Operation::Restore,
            fields.clone(),
        )
        .unwrap() else {
            panic!("restore");
        };
        if completed {
            let physical = service
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .rev()
                .find_map(|event| match event.effect {
                    Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
                    _ => None,
                })
                .unwrap();
            run(
                service.catalogue_mut(),
                &mut io,
                physical,
                &Time(Cell::new(10)),
                &Rules::default(),
                auth.as_ref(),
            )
            .await
            .unwrap();
        }
        let effects = if completed {
            o::Effects::Committed
        } else {
            o::Effects::Accepted
        };
        let mut changed = fields.clone();
        changed.retain(|(name, _)| name != "availability_seconds");
        changed.push(("availability_seconds".into(), o::Value::Number(51)));
        service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            limits(),
            profile(),
            10,
        )
        .unwrap();
        assert_rejection_parity(
            &mut service,
            o::Operation::Restore,
            changed.clone(),
            o::ErrorCode::Conflict,
            effects,
        );
        // An identity conflict must not disclose its old binding after that grant is lost.
        auth.denied.borrow_mut().insert("object:Restore".into());
        assert_rejection_parity(
            &mut service,
            o::Operation::Restore,
            changed,
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        auth.denied.borrow_mut().clear();
        let calls = io.order.len();
        let mut bounded = limits();
        bounded.bytes = 1024;
        service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            bounded,
            profile(),
            10,
        )
        .unwrap();
        assert_rejection_parity(
            &mut service,
            o::Operation::Restore,
            fields,
            o::ErrorCode::QuotaExceeded,
            effects,
        );
        let mut bounded = limits();
        bounded.records = 1;
        service = s::Service::reconnect(service.checkpoint(), Access(auth), bounded, profile(), 10)
            .unwrap();
        assert_rejection_parity(
            &mut service,
            o::Operation::Status,
            vec![text("job", job.handle.as_str())],
            o::ErrorCode::QuotaExceeded,
            effects,
        );
        assert_eq!(io.order.len(), calls);
    }
}

#[tokio::test]
async fn pre_io_worker_rejection_preserves_prior_evidence_and_only_real_cleanup() {
    for uncertain in [false, true] {
        for policy_denial in [false, true] {
            let (mut service, mut io, transfer, job, auth) = pending_upload().await;
            fully_stage(&mut service, &io, &transfer);
            parity(
                &mut service,
                &scope(),
                o::Operation::CommitUpload,
                commit_fields(&transfer),
            )
            .unwrap();
            if uncertain {
                io.inject = Injection::PartialUpload;
                service
                    .finish_upload(
                        &scope(),
                        &transfer.handle,
                        &mut io,
                        &budget(),
                        &Time(Cell::new(10)),
                        &Rules::default(),
                    )
                    .await
                    .unwrap_err();
            }
            let calls = io.order.len();
            let outbox = service.catalogue().outbox(TENANT);
            let allocations = service.allocations();
            let rules = Rules::default();
            rules.deny.set(policy_denial);
            let bound = if policy_denial {
                budget()
            } else {
                Budget::new(1024, 1, 3, 10).unwrap()
            };
            let failure = service
                .finish_upload(
                    &scope(),
                    &transfer.handle,
                    &mut io,
                    &bound,
                    &Time(Cell::new(10)),
                    &rules,
                )
                .await
                .unwrap_err();
            let effects = if uncertain {
                o::Effects::Unknown
            } else {
                o::Effects::Accepted
            };
            assert_eq!(failure.effects, effects);
            assert!(failure.reconciliation_required());
            assert!(!failure.retryable());
            assert_eq!(io.order.len(), calls);
            assert_eq!(service.catalogue().outbox(TENANT), outbox);
            assert_eq!(service.allocations(), allocations);
            service =
                s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), 10)
                    .unwrap();
            let o::Output::Cancel { outcome, job } = parity(
                &mut service,
                &scope(),
                o::Operation::Cancel,
                vec![
                    text("job", job.handle.as_str()),
                    text("identity", "pre_io_cancel"),
                ],
            )
            .unwrap() else {
                panic!("cancel");
            };
            assert_eq!(
                outcome,
                if uncertain {
                    o::CancelOutcome::Requested
                } else {
                    o::CancelOutcome::StoppedBeforeCommit
                }
            );
            assert_eq!(
                job.effects,
                if uncertain { effects } else { o::Effects::None }
            );
            assert_eq!(io.order.len(), calls);
        }
    }
}

#[tokio::test]
async fn native_committed_receipt_survives_read_revocation_during_storage_and_reconnect() {
    let (mut service, mut io, transfer, _, auth) = pending_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    fully_stage(&mut service, &io, &transfer);
    io.revoke_at_upload = Some((auth.clone(), "object:Read".into()));
    let commit = request(
        "read_revoked_commit",
        Some(&selection.session),
        n::Action::CommitUpload(n::UploadAction {
            upload: nid(transfer.handle.as_str()),
            intent: upload_intent(&io),
        }),
    );
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    assert!(matches!(
        native(&mut service, &commit, &mut io, &time, &rules).await,
        n::ResponseBody::Error(_)
    ));
    assert!(service.catalogue().outbox(TENANT).iter().any(
        |event| matches!(event.effect, Effect::RunJob(ref job) if job.kind == JobKind::Archive)
    ));
    let calls = io.order.len();
    let outbox = service.catalogue().outbox(TENANT);
    let allocations = service.allocations();
    // Delivery remains denied, even though the actual commit receipt is retained.
    assert!(matches!(
        native(&mut service, &commit, &mut io, &time, &rules).await,
        n::ResponseBody::Error(_)
    ));
    auth.denied.borrow_mut().clear();
    let reconciled = native(&mut service, &commit, &mut io, &time, &rules).await;
    assert!(matches!(reconciled, n::ResponseBody::Committed(_)));
    let mut service =
        s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), 10).unwrap();
    assert_eq!(
        native(&mut service, &commit, &mut io, &time, &rules).await,
        reconciled
    );
    assert_eq!(io.order.len(), calls);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
    assert_eq!(service.allocations(), allocations);
}

#[tokio::test]
async fn pending_result_retains_unknown_effects_before_deadline_on_all_domain_projections() {
    let (mut service, mut io, transfer, job, auth) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    io.inject = Injection::PartialUpload;
    service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap_err();
    let calls = io.order.len();
    let mut service =
        s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), 10).unwrap();
    let fields = vec![text("job", job.handle.as_str())];
    let direct = o::dispatch(
        &mut service,
        Some(&scope()),
        o::VERSION,
        o::Operation::Result,
        fields.clone(),
    )
    .unwrap_err();
    let projected = parity(&mut service, &scope(), o::Operation::Result, fields).unwrap_err();
    assert_eq!(direct, projected);
    assert_eq!(direct.code, o::ErrorCode::NotReady);
    assert_eq!(direct.effects, o::Effects::Unknown);
    assert!(direct.reconciliation_required());
    assert!(!direct.retryable());
    assert_eq!(io.order.len(), calls);
}

#[tokio::test]
async fn catalogue_and_service_identities_interleave_without_losing_reconciliation() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    // Infrastructure callers may supply identities beyond either local sequence.
    let operation = OperationId(5);
    let mutation = Mutation::BeginUpload {
        name: "infrastructure".into(),
        expected_revision: 0,
        generation: GenerationId(100_001),
        metadata: io.upload().metadata,
        archive_deadline: 1000,
    };
    let original = service
        .catalogue_mut()
        .transact(TENANT, operation, mutation, 10, auth.as_ref())
        .unwrap();
    let mut service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    let o::Output::Job(copy) = parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&upload.target, "copy", "interleaved_copy"),
    )
    .unwrap() else {
        panic!("copy");
    };
    let mut download = vec![
        text("reference", "object"),
        text("generation", upload.target.generation.as_str()),
        text("identity", "interleaved_download"),
    ];
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::AuthorizeDownload,
        std::mem::take(&mut download)
    )
    .is_ok());
    make_available(&mut service, &mut io, &copy.target, auth.as_ref()).await;
    let mut intent = upload_intent(&io);
    intent.object = nid("new_object");
    service
        .bind_upload(&scope(), id("interleaved_init"), id("root"), intent)
        .unwrap();
    let o::Output::Upload { transfer, .. } = parity(
        &mut service,
        &scope(),
        o::Operation::InitiateUpload,
        vec![
            text("reference", "new_object"),
            text("identity", "interleaved_init"),
            ("if_absent".into(), o::Value::Flag(true)),
            ("max_bytes".into(), o::Value::Number(io.identity().length)),
        ],
    )
    .unwrap() else {
        panic!("upload");
    };
    fully_stage(&mut service, &io, &transfer);
    let mut fields = commit_fields(&transfer);
    fields.retain(|(name, _)| name != "identity");
    fields.push(text("identity", "interleaved_commit"));
    parity(&mut service, &scope(), o::Operation::CommitUpload, fields).unwrap();
    service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap();
    let stored = service
        .catalogue()
        .lookup(TENANT, "new_object", 10, auth.as_ref())
        .unwrap();
    assert!(stored.generation.0 > 100_001);
    let service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    assert_eq!(
        service
            .catalogue()
            .reconcile(TENANT, operation, auth.as_ref())
            .unwrap(),
        Reconciliation::Applied(original)
    );
}

#[tokio::test]
async fn write_only_existing_targets_support_replace_copy_and_delete_without_read_disclosure() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    auth.denied.borrow_mut().insert("object:Read".into());
    let mut intent = upload_intent(&io);
    intent.precondition = n::Precondition::Matches(nid(upload.target.generation.as_str()));
    let initiation = request(
        "write_only_replace",
        Some(&selection.session),
        n::Action::InitiateUpload(intent.clone()),
    );
    let n::ResponseBody::Upload { upload: handle, .. } = native(
        &mut service,
        &initiation,
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await
    else {
        panic!("write-only replacement");
    };
    let (transfer, _) = service.resume(&scope(), &id(handle.as_str())).unwrap();
    fully_stage(&mut service, &io, &transfer);
    let mut fields = commit_fields(&transfer);
    fields.retain(|(name, _)| name != "identity");
    fields.push(text("identity", "write_only_commit"));
    parity(&mut service, &scope(), o::Operation::CommitUpload, fields).unwrap();
    let committed = service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap();
    let calls = io.order.len();
    let outbox = service.catalogue().outbox(TENANT);
    let allocations = service.allocations();
    for reconnect in [false, true] {
        if reconnect {
            service = s::Service::reconnect(
                service.checkpoint(),
                Access(auth.clone()),
                limits(),
                profile(),
                10,
            )
            .unwrap();
        }
        assert_eq!(
            service
                .finish_upload(
                    &scope(),
                    &transfer.handle,
                    &mut io,
                    &budget(),
                    &Time(Cell::new(10)),
                    &Rules::default(),
                )
                .await
                .unwrap(),
            committed
        );
        for operation in [o::Operation::Status, o::Operation::Result] {
            let failure = parity(
                &mut service,
                &scope(),
                operation,
                vec![text("job", committed.handle.as_str())],
            )
            .unwrap_err();
            assert_eq!(failure, o::Failure::new(o::ErrorCode::Denied));
        }
    }
    assert_eq!(io.order.len(), calls);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
    assert_eq!(service.allocations(), allocations);
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Stat,
        vec![
            text("reference", "object"),
            text("generation", transfer.target.generation.as_str())
        ]
    )
    .is_err());
    let stale = vec![
        text("reference", "object"),
        text("generation", upload.target.generation.as_str()),
        text("identity", "stale_delete"),
    ];
    let before = service.allocations();
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Delete, stale)
            .unwrap_err()
            .code,
        o::ErrorCode::PreconditionFailed
    );
    assert_eq!(service.allocations(), before);
    parity(
        &mut service,
        &scope(),
        o::Operation::Delete,
        vec![
            text("reference", "object"),
            text("generation", transfer.target.generation.as_str()),
            text("identity", "write_only_delete"),
        ],
    )
    .unwrap();

    let (mut service, _, source, _, auth) = hot_upload().await;
    let o::Output::Job(first) = parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&source.target, "copy", "first_copy"),
    )
    .unwrap() else {
        panic!("copy");
    };
    auth.denied.borrow_mut().insert("copy:Read".into());
    let mut fields = copy_fields(&source.target, "copy", "write_only_copy");
    fields.retain(|(name, _)| name != "if_absent");
    fields.push(text("generation", first.target.generation.as_str()));
    let o::Output::Job(replaced) =
        parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap()
    else {
        panic!("replace copy");
    };
    assert_ne!(replaced.target.generation, first.target.generation);
    fields.retain(|(name, _)| name != "identity");
    fields.push(text("identity", "stale_copy"));
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Copy, fields)
            .unwrap_err()
            .code,
        o::ErrorCode::PreconditionFailed
    );
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Stat,
        vec![
            text("reference", "copy"),
            text("generation", replaced.target.generation.as_str())
        ]
    )
    .is_err());
}

#[tokio::test]
async fn restore_retry_wait_never_projects_running_back_to_queued_after_reconnect() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let n::ResponseBody::Restore(accepted) = native(
        &mut service,
        &request(
            "retry_restore",
            Some(&selection.session),
            n::Action::Restore(n::Restore {
                target: n::Target {
                    object: nid("object"),
                    g: nid(upload.target.generation.as_str()),
                },
                max_bytes: 4096,
                max_seconds: 50,
            }),
        ),
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await
    else {
        panic!("restore");
    };
    let physical = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .rev()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
            _ => None,
        })
        .unwrap();
    let fence = service
        .catalogue_mut()
        .claim(TENANT, physical, 10, 12)
        .unwrap();
    let n::ResponseBody::Status(running) = native(
        &mut service,
        &request(
            "running_status",
            Some(&selection.session),
            n::Action::Status {
                job: accepted.job.clone(),
            },
        ),
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await
    else {
        panic!("running");
    };
    assert_eq!(running.state, n::JobState::Running);
    let mut service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        11,
    )
    .unwrap();
    service
        .catalogue_mut()
        .transition(
            TENANT,
            fence,
            Transition::Retry { not_before: 13 },
            11,
            auth.as_ref(),
        )
        .unwrap();
    let n::ResponseBody::Status(retry) = native(
        &mut service,
        &request(
            "retry_status",
            Some(&selection.session),
            n::Action::Status {
                job: accepted.job.clone(),
            },
        ),
        &mut io,
        &Time(Cell::new(11)),
        &Rules::default(),
    )
    .await
    else {
        panic!("retry");
    };
    assert_eq!(retry.state, n::JobState::Running);
    n::validate_status_transition(&running, &retry).unwrap();
    let o::Output::Job(job) = parity(
        &mut service,
        &scope(),
        o::Operation::Status,
        vec![text("job", accepted.job.as_str())],
    )
    .unwrap() else {
        panic!("status");
    };
    assert_eq!(job.state, o::JobState::Running);
}

#[tokio::test]
async fn tightened_byte_limit_preserves_uncertain_upload_effects_and_cleanup_after_reconnect() {
    let (mut service, mut io, transfer, job, auth) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    io.inject = Injection::PartialUpload;
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &time,
                &rules,
            )
            .await
            .unwrap_err()
            .effects,
        o::Effects::Unknown
    );
    let mut small = limits();
    small.bytes = 1024;
    let mut service =
        s::Service::reconnect(service.checkpoint(), Access(auth), small, profile(), 10).unwrap();
    let before = service.allocations();
    let outbox = service.catalogue().outbox(TENANT);
    let calls = io.order.len();
    let mut fresh = commit_fields(&transfer);
    fresh.retain(|(name, _)| name != "identity");
    fresh.push(text("identity", "limited_uncertain_commit"));
    let direct = o::dispatch(
        &mut service,
        Some(&scope()),
        o::VERSION,
        o::Operation::CommitUpload,
        fresh.clone(),
    )
    .unwrap_err();
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::CommitUpload, fresh).unwrap_err(),
        direct
    );
    let worker = service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &time,
            &rules,
        )
        .await
        .unwrap_err();
    for failure in [direct, worker] {
        assert_eq!(failure.code, o::ErrorCode::QuotaExceeded);
        assert_eq!(failure.effects, o::Effects::Unknown);
        assert!(!failure.retryable());
        assert!(failure.reconciliation_required());
    }
    assert_eq!(service.allocations(), before);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
    assert_eq!(io.order.len(), calls);
    let o::Output::Cancel { outcome, job } = parity(
        &mut service,
        &scope(),
        o::Operation::Cancel,
        vec![
            text("job", job.handle.as_str()),
            text("identity", "limited_uncertain_cancel"),
        ],
    )
    .unwrap() else {
        panic!("cancel");
    };
    assert_eq!(outcome, o::CancelOutcome::Requested);
    assert_eq!(job.state, o::JobState::CancelRequested);
    assert_eq!(job.effects, o::Effects::Unknown);
    assert_eq!(io.order.len(), calls);
}

fn assert_rejection_parity(
    service: &mut s::Service<Access>,
    operation: o::Operation,
    fields: o::Fields,
    code: o::ErrorCode,
    effects: o::Effects,
) {
    let allocations = service.allocations();
    let outbox = service.catalogue().outbox(TENANT);
    let direct = o::dispatch(
        service,
        Some(&scope()),
        o::VERSION,
        operation,
        fields.clone(),
    )
    .unwrap_err();
    assert_eq!(
        parity(service, &scope(), operation, fields).unwrap_err(),
        direct
    );
    assert_eq!(direct, o::Failure { code, effects });
    assert_eq!(
        direct.reconciliation_required(),
        effects != o::Effects::None
    );
    assert!(!direct.retryable());
    assert_eq!(service.allocations(), allocations);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
}

#[tokio::test]
async fn authorized_upload_rejections_preserve_uncertain_effects_across_policy_and_state_fences() {
    for case in ["records", "revision", "expiry", "deadline", "cancel"] {
        let (mut service, mut io, transfer, job, auth) = pending_upload().await;
        fully_stage(&mut service, &io, &transfer);
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&transfer),
        )
        .unwrap();
        io.inject = Injection::PartialUpload;
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &Time(Cell::new(10)),
                &Rules::default(),
            )
            .await
            .unwrap_err();
        let mut bounded = limits();
        let mut now = 10;
        let expected = match case {
            "records" => {
                bounded.records = 1;
                o::ErrorCode::QuotaExceeded
            }
            "revision" => {
                service
                    .bind_upload(&scope(), id("second_init"), id("root"), upload_intent(&io))
                    .unwrap();
                let o::Output::Upload {
                    transfer: second, ..
                } = parity(
                    &mut service,
                    &scope(),
                    o::Operation::InitiateUpload,
                    vec![
                        text("reference", "object"),
                        text("identity", "second_init"),
                        ("if_absent".into(), o::Value::Flag(true)),
                        ("max_bytes".into(), o::Value::Number(io.identity().length)),
                    ],
                )
                .unwrap()
                else {
                    panic!("second upload");
                };
                fully_stage(&mut service, &io, &second);
                let mut fields = commit_fields(&second);
                fields.retain(|(name, _)| name != "identity");
                fields.push(text("identity", "second_commit"));
                parity(&mut service, &scope(), o::Operation::CommitUpload, fields).unwrap();
                io.inject = Injection::None;
                service
                    .finish_upload(
                        &scope(),
                        &second.handle,
                        &mut io,
                        &budget(),
                        &Time(Cell::new(10)),
                        &Rules::default(),
                    )
                    .await
                    .unwrap();
                o::ErrorCode::PreconditionFailed
            }
            "expiry" => {
                now = 211;
                o::ErrorCode::Conflict
            }
            "deadline" => {
                now = 1011;
                o::ErrorCode::Conflict
            }
            "cancel" => {
                parity(
                    &mut service,
                    &scope(),
                    o::Operation::Cancel,
                    vec![
                        text("job", job.handle.as_str()),
                        text("identity", "before_rejection_cancel"),
                    ],
                )
                .unwrap();
                o::ErrorCode::Conflict
            }
            _ => unreachable!(),
        };
        service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            bounded,
            profile(),
            now,
        )
        .unwrap();
        let calls = io.order.len();
        let mut fields = commit_fields(&transfer);
        fields.retain(|(name, _)| name != "identity");
        fields.push(text("identity", "fresh_uncertain_commit"));
        assert_rejection_parity(
            &mut service,
            o::Operation::CommitUpload,
            fields.clone(),
            expected,
            o::Effects::Unknown,
        );
        // The retained obligation is not disclosed through revoked, missing or foreign handles.
        auth.denied.borrow_mut().insert("key_ref".into());
        assert_rejection_parity(
            &mut service,
            o::Operation::CommitUpload,
            fields.clone(),
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        auth.denied.borrow_mut().clear();
        let mut foreign = scope();
        foreign.principal = id("other_principal");
        assert_eq!(
            parity(
                &mut service,
                &foreign,
                o::Operation::CommitUpload,
                fields.clone()
            )
            .unwrap_err(),
            o::Failure::new(o::ErrorCode::Denied),
        );
        fields.retain(|(name, _)| name != "transfer");
        fields.push(text("transfer", "missing_upload"));
        assert_rejection_parity(
            &mut service,
            o::Operation::CommitUpload,
            fields,
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        // Restore capacity/time policy, not state, to inspect cleanup-aware cancellation.
        service =
            s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), now)
                .unwrap();
        let o::Output::Cancel { outcome, job } = parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "after_rejection_cancel"),
            ],
        )
        .unwrap() else {
            panic!("cancel");
        };
        if case == "deadline" {
            assert_eq!(outcome, o::CancelOutcome::AlreadyTerminal);
            assert_eq!(job.state, o::JobState::Failed);
        } else {
            assert_eq!(outcome, o::CancelOutcome::Requested);
            assert_eq!(job.state, o::JobState::CancelRequested);
        }
        assert_eq!(job.effects, o::Effects::Unknown);
        assert_eq!(io.order.len(), calls);
    }
}

struct ReentryClock(bool);
impl Clock for ReentryClock {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        if self.0 {
            Err(Error::Invalid)
        } else {
            Ok(9)
        }
    }
}

#[tokio::test]
async fn authorized_worker_clock_failures_preserve_uncertain_effects_without_io() {
    let (mut service, mut io, transfer, _, auth) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    io.inject = Injection::PartialUpload;
    service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        .unwrap_err();
    service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    let calls = io.order.len();
    let allocations = service.allocations();
    let outbox = service.catalogue().outbox(TENANT);
    for fails in [true, false] {
        let failure = service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &ReentryClock(fails),
                &Rules::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            failure,
            o::Failure {
                code: o::ErrorCode::Unavailable,
                effects: o::Effects::Unknown
            }
        );
        assert!(failure.reconciliation_required());
        assert!(!failure.retryable());
    }
    auth.denied.borrow_mut().insert("key_ref".into());
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &ReentryClock(true),
                &Rules::default(),
            )
            .await
            .unwrap_err(),
        o::Failure::new(o::ErrorCode::Denied)
    );
    assert_eq!(io.order.len(), calls);
    assert_eq!(service.allocations(), allocations);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
}

#[tokio::test]
async fn restore_replay_policy_rejection_retains_accepted_effects_for_queued_and_running_jobs() {
    for running in [false, true] {
        let (mut service, io, upload, _, auth) = hot_upload().await;
        let fields = vec![
            text("reference", "object"),
            text("generation", upload.target.generation.as_str()),
            text("identity", "policy_restore_replay"),
            ("availability_seconds".into(), o::Value::Number(50)),
        ];
        let o::Output::Job(job) = parity(
            &mut service,
            &scope(),
            o::Operation::Restore,
            fields.clone(),
        )
        .unwrap() else {
            panic!("restore");
        };
        assert_eq!(job.effects, o::Effects::Accepted);
        if running {
            let physical = service
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .rev()
                .find_map(|event| match event.effect {
                    Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
                    _ => None,
                })
                .unwrap();
            service
                .catalogue_mut()
                .claim(TENANT, physical, 10, 12)
                .unwrap();
        }
        let mut bounded = limits();
        bounded.bytes = 1024;
        service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            bounded,
            profile(),
            10,
        )
        .unwrap();
        let calls = io.order.len();
        assert_rejection_parity(
            &mut service,
            o::Operation::Restore,
            fields.clone(),
            o::ErrorCode::QuotaExceeded,
            o::Effects::Accepted,
        );
        auth.denied.borrow_mut().insert("object:Restore".into());
        assert_rejection_parity(
            &mut service,
            o::Operation::Restore,
            fields,
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        assert_eq!(io.order.len(), calls);
    }
}

#[tokio::test]
async fn tightened_byte_limit_blocks_retained_upload_and_existing_restore_download_before_effects()
{
    for submitted in [false, true] {
        let (mut service, mut io, transfer, _, auth) = pending_upload().await;
        let selection = negotiate(&mut service, &mut io).await;
        fully_stage(&mut service, &io, &transfer);
        if submitted {
            parity(
                &mut service,
                &scope(),
                o::Operation::CommitUpload,
                commit_fields(&transfer),
            )
            .unwrap();
        }
        let mut small = limits();
        small.bytes = 1024;
        let mut service =
            s::Service::reconnect(service.checkpoint(), Access(auth), small, profile(), 10)
                .unwrap();
        let before = service.allocations();
        let outbox = service.catalogue().outbox(TENANT);
        assert_eq!(
            parity(
                &mut service,
                &scope(),
                o::Operation::CommitUpload,
                commit_fields(&transfer)
            )
            .unwrap_err()
            .code,
            o::ErrorCode::QuotaExceeded
        );
        assert_eq!(
            native(
                &mut service,
                &request(
                    "oversized_commit",
                    Some(&selection.session),
                    n::Action::CommitUpload(n::UploadAction {
                        upload: nid(transfer.handle.as_str()),
                        intent: upload_intent(&io)
                    })
                ),
                &mut io,
                &Time(Cell::new(10)),
                &Rules::default()
            )
            .await,
            n::ResponseBody::Error(n::ErrorCode::LimitExceeded)
        );
        assert_eq!(
            service
                .finish_upload(
                    &scope(),
                    &transfer.handle,
                    &mut io,
                    &budget(),
                    &Time(Cell::new(10)),
                    &Rules::default()
                )
                .await
                .unwrap_err()
                .code,
            o::ErrorCode::QuotaExceeded
        );
        assert_eq!(service.allocations(), before);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
        assert!(io.order.is_empty());
    }
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let mut small = limits();
    small.bytes = 1024;
    let mut service =
        s::Service::reconnect(service.checkpoint(), Access(auth), small, profile(), 10).unwrap();
    let before = service.allocations();
    let outbox = service.catalogue().outbox(TENANT);
    let calls = io.order.len();
    let target = n::Target {
        object: nid("object"),
        g: nid(upload.target.generation.as_str()),
    };
    for operation in [o::Operation::Restore, o::Operation::AuthorizeDownload] {
        let mut fields = target_fields(&target);
        fields.push(text("identity", "oversized_existing"));
        if operation == o::Operation::Restore {
            fields.push(("availability_seconds".into(), o::Value::Number(50)));
        }
        assert_eq!(
            parity(&mut service, &scope(), operation, fields)
                .unwrap_err()
                .code,
            o::ErrorCode::QuotaExceeded
        );
    }
    for (name, action) in [
        (
            "oversized_restore",
            n::Action::Restore(n::Restore {
                target: target.clone(),
                max_bytes: 4096,
                max_seconds: 50,
            }),
        ),
        (
            "oversized_download",
            n::Action::Download(n::Download {
                target,
                range: None,
                max_bytes: 4096,
            }),
        ),
    ] {
        assert_eq!(
            native(
                &mut service,
                &request(name, Some(&selection.session), action),
                &mut io,
                &Time(Cell::new(10)),
                &Rules::default()
            )
            .await,
            n::ResponseBody::Error(n::ErrorCode::LimitExceeded)
        );
    }
    assert_eq!(service.allocations(), before);
    assert_eq!(service.catalogue().outbox(TENANT), outbox);
    assert_eq!(io.order.len(), calls);
}
