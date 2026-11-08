use super::*;

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
