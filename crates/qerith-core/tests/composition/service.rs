use super::*;
use qerith_core::{native as n, operations as o, service as s};

#[derive(Clone)]
struct Access(Rc<Auth>);
impl s::Access for Access {
    fn tenant(&self, scope: &o::Scope) -> Option<TenantId> {
        (!self.0.stale.get()).then_some(if scope.tenant.as_str() == "tenant" {
            TENANT
        } else {
            TenantId(2)
        })
    }
    fn permits(&self, scope: &o::Scope, name: &str, _: Action) -> bool {
        scope.tenant.as_str() == "tenant" && !self.0.denied.borrow().contains(name)
    }
    fn container(&self, scope: &o::Scope, parent: &str) -> bool {
        scope.tenant.as_str() == "tenant" && parent == "root"
    }
    fn admit(&self, _: &o::Scope) -> bool {
        !self.0.stale.get()
    }
    fn key_envelope(&self, scope: &o::Scope, key: &n::Opaque, envelope: &n::Opaque) -> bool {
        scope.tenant.as_str() == "tenant"
            && key.as_str() == "key_ref"
            && envelope.as_str() == "envelope_ref"
    }
}
fn id(value: &str) -> o::Opaque {
    o::Opaque::new(value).unwrap()
}
fn nid(value: &str) -> n::Opaque {
    value.to_owned().try_into().unwrap()
}
fn scope() -> o::Scope {
    o::Scope {
        tenant: id("tenant"),
        principal: id("principal"),
    }
}
fn limits() -> s::Limits {
    s::Limits {
        bytes: 4096,
        job_seconds: 1000,
        transfer_seconds: 200,
        attempts: 3,
        records: 4096,
    }
}
fn profile() -> n::Policy {
    n::Policy {
        profiles: vec![n::SupportedProfile {
            profile: n::Profile {
                format: nid("synthetic_C"),
                crypto: nid("unqualified_mock"),
                integrity: nid("sha256"),
            },
            checksum_hex_chars: 64,
        }],
        limits: n::Limits {
            object_bytes: 4096,
            transfer_bytes: 4096,
            page_entries: 100,
            job_seconds: 1000,
        },
    }
}
fn request(name: &str, session: Option<&n::Opaque>, action: n::Action) -> n::Request {
    n::Request {
        version: 1,
        scope: nid("tenant"),
        request_id: nid(name),
        session: session.cloned(),
        action,
    }
}
async fn native(
    service: &mut s::Service<Access>,
    request: &n::Request,
    io: &mut Io,
    time: &Time,
    rules: &Rules,
) -> n::ResponseBody {
    service
        .native_bytes(
            &scope(),
            &id("root"),
            &serde_json::to_vec(request).unwrap(),
            s::UploadWorker {
                storage: io,
                budget: &budget(),
                clock: time,
                policy: rules,
            },
        )
        .await
        .unwrap()
        .body
}
fn text(name: &str, value: &str) -> (String, o::Value) {
    (name.into(), o::Value::Text(value.into()))
}
fn target_fields(target: &n::Target) -> o::Fields {
    vec![
        text("reference", target.object.as_str()),
        text("generation", target.g.as_str()),
    ]
}
fn parity(
    service: &mut s::Service<Access>,
    scope: &o::Scope,
    op: o::Operation,
    fields: o::Fields,
) -> std::result::Result<o::Output, o::Failure> {
    // Each projection starts from the identical explicit reference checkpoint.
    let mut other = s::Service::reconnect(
        service.checkpoint(),
        service.access().clone(),
        service.limits().clone(),
        profile(),
        service.now(),
    )
    .unwrap();
    let arguments = fields
        .into_iter()
        .map(|(name, value)| {
            let value = match value {
                o::Value::Text(value) => serde_json::json!(value),
                o::Value::Number(value) => serde_json::json!(value),
                o::Value::Flag(value) => serde_json::json!(value),
            };
            (name, value)
        })
        .collect::<serde_json::Map<_, _>>();
    let bytes = serde_json::to_vec(&arguments).unwrap();
    let rest = o::rest_request(
        service,
        Some(scope),
        "POST",
        &format!("/v1/operations/{}", op.definition().name),
        &bytes,
    );
    let mcp = o::mcp_request(
        &mut other,
        Some(scope),
        o::McpSession::default(),
        o::TaskMode::Baseline,
        op.definition().name,
        &bytes,
    );
    assert_eq!(rest.outcome, mcp.outcome);
    assert_eq!(rest.outcome.is_err(), mcp.is_error);
    assert_eq!(service.allocations(), other.allocations());
    rest.outcome
}
fn evidence(name: &str, value: serde_json::Value) {
    if let Ok(directory) = std::env::var("QERITH_SERVICE_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(name),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    }
}

#[tokio::test]
async fn native_rest_mcp_golden_reconnect_and_cold_restore() {
    let auth = Rc::new(Auth::default());
    let mut service = s::Service::new(Access(auth.clone()), limits(), profile(), 10).unwrap();
    let mut io = Io::new(2).await;
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    let policy = profile();
    let capabilities = request(
        "negotiate",
        None,
        n::Action::Capabilities(n::Offer {
            versions: vec![1],
            profiles: vec![policy.profiles[0].profile.clone()],
            limits: policy.limits.clone(),
        }),
    );
    let n::ResponseBody::Capabilities(selection) =
        native(&mut service, &capabilities, &mut io, &time, &rules).await
    else {
        panic!("negotiation");
    };
    let intent = n::UploadIntent {
        object: nid("object"),
        precondition: n::Precondition::Absent,
        ciphertext: n::Ciphertext {
            c: nid("opaque_C"),
            length: io.identity().length,
            checksum_hex: nid(&io
                .identity()
                .sha256
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()),
            profile: policy.profiles[0].profile.clone(),
            key_ref: nid("key_ref"),
            envelope_ref: nid("envelope_ref"),
        },
        metadata: n::Metadata {
            content_type: "application/octet-stream".into(),
            content_encoding: Some("synthetic-opaque-C".into()),
            user: BTreeMap::from([("label".into(), "synthetic-not-AEAD".into())]),
        },
    };
    let initiation = request(
        "initiate",
        Some(&selection.session),
        n::Action::InitiateUpload(intent.clone()),
    );
    let first = native(&mut service, &initiation, &mut io, &time, &rules).await;
    let n::ResponseBody::Upload {
        upload,
        received_bytes: 0,
    } = &first
    else {
        panic!("initiation {first:?}");
    };
    let handle = id(upload.as_str());
    service.staged(&scope(), &handle, 0, 512).unwrap();
    assert!(service.staged(&scope(), &handle, 0, 1).is_err());
    let checkpoint = service.checkpoint();
    drop(service);
    let mut service =
        s::Service::reconnect(checkpoint, Access(auth.clone()), limits(), profile(), 10).unwrap();
    // Reconnect has no subscriber/socket state, and retains scoped issuance history.
    assert_eq!(
        native(&mut service, &initiation, &mut io, &time, &rules).await,
        first
    );
    let action = n::UploadAction {
        upload: upload.clone(),
        intent: intent.clone(),
    };
    assert_eq!(
        native(
            &mut service,
            &request(
                "resume",
                Some(&selection.session),
                n::Action::ResumeUpload(action.clone())
            ),
            &mut io,
            &time,
            &rules
        )
        .await,
        n::ResponseBody::Upload {
            upload: upload.clone(),
            received_bytes: 512
        }
    );
    service
        .staged(&scope(), &handle, 512, io.identity().length)
        .unwrap();
    let verified = CompleteCopy {
        identity: io.identity(),
        checksums: vec![],
        location: "trusted-staged-C".into(),
        receipt: "full bytes/checksum verified in fixture".into(),
    };
    service.verify_staged(&scope(), &handle, &verified).unwrap();
    let commit = request(
        "commit",
        Some(&selection.session),
        n::Action::CommitUpload(action.clone()),
    );
    let committed = native(&mut service, &commit, &mut io, &time, &rules).await;
    let n::ResponseBody::Committed(object) = &committed else {
        panic!("commit {committed:?}");
    };
    assert_eq!(object.ciphertext, intent.ciphertext);
    assert_eq!(object.metadata, intent.metadata);
    assert_eq!(
        native(&mut service, &commit, &mut io, &time, &rules).await,
        committed
    );
    let before = service.allocations();
    let aborted = native(
        &mut service,
        &request(
            "abort_after_commit",
            Some(&selection.session),
            n::Action::AbortUpload(action),
        ),
        &mut io,
        &time,
        &rules,
    )
    .await;
    assert_eq!(
        aborted,
        n::ResponseBody::Aborted(n::CancelOutcome::AlreadyCommitted)
    );
    assert_eq!(service.allocations(), before);
    let stat = parity(
        &mut service,
        &scope(),
        o::Operation::Stat,
        target_fields(&object.target),
    )
    .unwrap();
    assert!(matches!(
        stat,
        o::Output::Stat(o::Entry {
            available: false,
            ..
        })
    ));
    let mut download = target_fields(&object.target);
    download.push(text("identity", "cold_read"));
    let before = service.allocations();
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::AuthorizeDownload,
        download
    )
    .is_err());
    assert_eq!(
        service.allocations(),
        before,
        "cold denial allocates nothing"
    );
    // Existing composition worker, not a transport-specific archive engine.
    let archive = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Archive => Some(job.id),
            _ => None,
        })
        .unwrap();
    run(
        service.catalogue_mut(),
        &mut io,
        archive,
        &time,
        &rules,
        auth.as_ref(),
    )
    .await
    .unwrap();
    let candidate = service
        .catalogue()
        .candidate(
            TENANT,
            GenerationId(2),
            DeletionKind::DeliveryCache,
            10,
            11,
            auth.as_ref(),
        )
        .unwrap();
    let event = service
        .catalogue_mut()
        .finalize_deletion(candidate, 11, auth.as_ref())
        .unwrap();
    let dispatch = service
        .catalogue_mut()
        .dispatch_deletion(TENANT, event, 11, auth.as_ref())
        .unwrap();
    let DeletionTarget::StorageVersion(location) = dispatch.target else {
        panic!("immutable copy");
    };
    assert!(io.copies.remove(&location).is_some());
    service
        .catalogue_mut()
        .acknowledge_deletion(TENANT, event)
        .unwrap();
    io.assert_cold();
    time.0.set(11);
    service.set_now(11).unwrap();
    let copy = parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        vec![
            text("source", "object"),
            text("source_generation", object.target.g.as_str()),
            text("reference", "copy"),
            ("if_absent".into(), o::Value::Flag(true)),
            text("identity", "copy_once"),
        ],
    )
    .unwrap();
    assert!(matches!(
        copy,
        o::Output::Job(o::Job {
            effects: o::Effects::Committed,
            ..
        })
    ));
    let page = parity(
        &mut service,
        &scope(),
        o::Operation::Browse,
        vec![
            text("parent", "root"),
            ("limit".into(), o::Value::Number(1)),
        ],
    )
    .unwrap();
    let o::Output::Page {
        entries,
        cursor: Some(cursor),
    } = page
    else {
        panic!("paginated");
    };
    assert_eq!(entries.len(), 1);
    let continuation = vec![
        text("parent", "root"),
        text("cursor", cursor.as_str()),
        ("limit".into(), o::Value::Number(1)),
    ];
    let next = parity(
        &mut service,
        &scope(),
        o::Operation::Browse,
        continuation.clone(),
    )
    .unwrap();
    assert_eq!(
        next,
        parity(&mut service, &scope(), o::Operation::Browse, continuation).unwrap()
    );
    let restore = request(
        "restore",
        Some(&selection.session),
        n::Action::Restore(n::Restore {
            target: object.target.clone(),
            max_bytes: 4096,
            max_seconds: 50,
        }),
    );
    let n::ResponseBody::Restore(job) =
        native(&mut service, &restore, &mut io, &time, &rules).await
    else {
        panic!("restore");
    };
    let copy_target = n::Target {
        object: nid("copy"),
        g: object.target.g.clone(),
    };
    let mut restore_copy = target_fields(&copy_target);
    restore_copy.push(text("identity", "copy_restore"));
    restore_copy.push(("availability_seconds".into(), o::Value::Number(50)));
    let o::Output::Job(copy_job) =
        parity(&mut service, &scope(), o::Operation::Restore, restore_copy).unwrap()
    else {
        panic!("copy restore");
    };
    assert!(matches!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", copy_job.handle.as_str()),
                text("identity", "cancel_copy")
            ]
        )
        .unwrap(),
        o::Output::Cancel {
            outcome: o::CancelOutcome::StoppedBeforeCommit,
            ..
        }
    ));
    // Drop all transport subscribers and restart the explicit model while work
    // remains queued. The worker/outbox survives and publishes only live demand.
    let mut service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        11,
    )
    .unwrap();
    let restore_id = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
            _ => None,
        })
        .unwrap();
    run(
        service.catalogue_mut(),
        &mut io,
        restore_id,
        &time,
        &rules,
        auth.as_ref(),
    )
    .await
    .unwrap();
    let result = parity(
        &mut service,
        &scope(),
        o::Operation::Result,
        vec![text("job", job.job.as_str())],
    )
    .unwrap();
    assert!(matches!(
        result,
        o::Output::Result {
            job: o::Job {
                state: o::JobState::Succeeded,
                ..
            },
            ..
        }
    ));
    assert!(matches!(
        native(
            &mut service,
            &request(
                "status",
                Some(&selection.session),
                n::Action::Status {
                    job: job.job.clone()
                }
            ),
            &mut io,
            &time,
            &rules
        )
        .await,
        n::ResponseBody::Status(n::JobStatus {
            state: n::JobState::Succeeded,
            ..
        })
    ));
    let mut fields = target_fields(&object.target);
    fields.push(text("identity", "download"));
    let o::Output::Download(transfer) = parity(
        &mut service,
        &scope(),
        o::Operation::AuthorizeDownload,
        fields,
    )
    .unwrap() else {
        panic!("download");
    };
    let (_, pin) = service.redeem(&scope(), &transfer.handle).unwrap();
    let bytes = io
        .deliver(service.catalogue(), pin, 11, auth.as_ref())
        .unwrap();
    assert_eq!(bytes, io.fixture.bytes());
    let delivered_digest: [u8; 32] = Sha256::digest(bytes).into();
    assert_eq!(delivered_digest, io.identity().sha256);
    let foreign = o::Scope {
        tenant: id("other"),
        principal: id("principal"),
    };
    assert!(service.redeem(&foreign, &transfer.handle).is_err());
    evidence(
        "service-positive.json",
        serde_json::json!({"claim":"transport/invariants only", "not_qualified":["AEAD/OPRF", "browser delivery trust", "real providers/backbones", "public hosting"], "bytes":bytes.len(), "sha256":intent.ciphertext.checksum_hex.as_str(), "metadata":object.metadata, "trace":io.order, "authority":["authenticated scope", "exact generation", "live grants", "full C verification", "catalogue publication", "serving pin redemption"], "restart":"explicit non-durable reference checkpoint", "subscriber_disconnect":"no effect on persisted outbox"}),
    );
    auth.denied.borrow_mut().insert("object".into());
    let before = service.allocations();
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Stat,
        target_fields(&object.target)
    )
    .is_err());
    assert!(service.redeem(&scope(), &transfer.handle).is_err());
    assert_eq!(service.allocations(), before);
    auth.denied.borrow_mut().clear();
    service
        .catalogue_mut()
        .set_moderation(TENANT, GenerationId(2), 1, true)
        .unwrap();
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Stat,
        target_fields(&object.target)
    )
    .is_err());
    assert!(service.redeem(&scope(), &transfer.handle).is_err());
}

async fn pending_upload() -> (s::Service<Access>, Io, o::Transfer, o::Job, Rc<Auth>) {
    let auth = Rc::new(Auth::default());
    let mut service = s::Service::new(Access(auth.clone()), limits(), profile(), 10).unwrap();
    let io = Io::new(1).await;
    let intent = n::UploadIntent {
        object: nid("object"),
        precondition: n::Precondition::Absent,
        ciphertext: n::Ciphertext {
            c: nid("opaque_C"),
            length: io.identity().length,
            checksum_hex: nid(&io
                .identity()
                .sha256
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()),
            profile: profile().profiles[0].profile.clone(),
            key_ref: nid("key_ref"),
            envelope_ref: nid("envelope_ref"),
        },
        metadata: n::Metadata {
            content_type: "application/octet-stream".into(),
            content_encoding: None,
            user: BTreeMap::new(),
        },
    };
    service
        .bind_upload(&scope(), id("init"), id("root"), intent)
        .unwrap();
    let o::Output::Upload { transfer, job } = parity(
        &mut service,
        &scope(),
        o::Operation::InitiateUpload,
        vec![
            text("reference", "object"),
            text("identity", "init"),
            ("max_bytes".into(), o::Value::Number(io.identity().length)),
            ("if_absent".into(), o::Value::Flag(true)),
        ],
    )
    .unwrap() else {
        panic!("upload");
    };
    (service, io, transfer, job, auth)
}
fn commit_fields(transfer: &o::Transfer) -> o::Fields {
    vec![
        text("reference", transfer.target.reference.as_str()),
        text("generation", transfer.target.generation.as_str()),
        text("transfer", transfer.handle.as_str()),
        text("identity", "commit"),
    ]
}
fn fully_stage(service: &mut s::Service<Access>, io: &Io, transfer: &o::Transfer) {
    service
        .staged(&scope(), &transfer.handle, 0, io.identity().length)
        .unwrap();
    service
        .verify_staged(
            &scope(),
            &transfer.handle,
            &CompleteCopy {
                identity: io.identity(),
                checksums: vec![],
                location: "trusted-full-stage".into(),
                receipt: "full C verified".into(),
            },
        )
        .unwrap();
}

#[tokio::test]
async fn retry_reconnect_preserves_intent_and_uncertain_cancel_never_rolls_back() {
    let (mut service, mut io, transfer, job, auth) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    io.inject = Injection::PartialUpload;
    let failed = service
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
    assert_eq!(failed.effects, o::Effects::Unknown);
    assert!(!failed.retryable());
    let mut service =
        s::Service::reconnect(service.checkpoint(), Access(auth), limits(), profile(), 12).unwrap();
    time.0.set(12);
    io.inject = Injection::None;
    // Stable initiation metadata must not change with retry/reconnect time.
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &time,
                &rules
            )
            .await
            .unwrap()
            .state,
        o::JobState::Succeeded
    );
    assert!(matches!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "after_commit")
            ]
        )
        .unwrap(),
        o::Output::Cancel {
            outcome: o::CancelOutcome::AlreadyCommitted,
            ..
        }
    ));

    let (mut service, mut io, transfer, job, _) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    let time = Time(Cell::new(10));
    io.inject = Injection::PartialUpload;
    for _ in 0..limits().attempts {
        assert!(service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &time,
                &rules
            )
            .await
            .is_err());
    }
    let calls = io.order.len();
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &time,
                &rules
            )
            .await
            .unwrap_err()
            .code,
        o::ErrorCode::QuotaExceeded
    );
    assert_eq!(io.order.len(), calls, "attempt cap must precede I/O");
    let o::Output::Cancel { job, outcome } = parity(
        &mut service,
        &scope(),
        o::Operation::Cancel,
        vec![
            text("job", job.handle.as_str()),
            text("identity", "uncertain_cancel"),
        ],
    )
    .unwrap() else {
        panic!("cancel");
    };
    assert_eq!(outcome, o::CancelOutcome::Requested);
    assert_eq!(job.effects, o::Effects::Unknown);
    assert_eq!(job.state, o::JobState::CancelRequested);
    assert!(service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &time,
            &rules
        )
        .await
        .is_err());
    assert_eq!(io.order.len(), calls);
}

#[tokio::test]
async fn staged_handles_expiry_stale_generation_and_delete_have_shared_gates() {
    let (mut service, mut io, transfer, job, auth) = pending_upload().await;
    let principal = o::Scope {
        principal: id("other_principal"),
        ..scope()
    };
    assert!(service.resume(&principal, &transfer.handle).is_err());
    assert!(service.staged(&principal, &transfer.handle, 0, 1).is_err());
    assert!(parity(
        &mut service,
        &principal,
        o::Operation::CommitUpload,
        commit_fields(&transfer)
    )
    .is_err());
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer)
    )
    .is_err());
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    let time = Time(Cell::new(10));
    let rules = Rules::default();
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
        .unwrap();
    let stale = n::Target {
        object: nid("object"),
        g: nid("g_999"),
    };
    let before = service.allocations();
    for operation in [
        o::Operation::Stat,
        o::Operation::Restore,
        o::Operation::AuthorizeDownload,
        o::Operation::Delete,
    ] {
        let mut fields = target_fields(&stale);
        if operation != o::Operation::Stat {
            fields.push(text("identity", "stale"));
        }
        if operation == o::Operation::Restore {
            fields.push(("availability_seconds".into(), o::Value::Number(50)));
        }
        assert_eq!(
            parity(&mut service, &scope(), operation, fields)
                .unwrap_err()
                .code,
            o::ErrorCode::PreconditionFailed
        );
        assert_eq!(service.allocations(), before);
    }
    let mut fields = commit_fields(&transfer);
    fields.retain(|(name, _)| name != "transfer");
    let deleted = parity(&mut service, &scope(), o::Operation::Delete, fields).unwrap();
    let o::Output::Job(deleted) = deleted else {
        panic!("deleted");
    };
    assert_eq!(deleted.effects, o::Effects::Committed);
    assert_eq!(
        deleted.progress.total(),
        None,
        "unknown does not mean zero or 100 percent"
    );
    assert!(service
        .catalogue()
        .lookup(TENANT, "object", 10, auth.as_ref())
        .is_err());
    assert!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Status,
            vec![text("job", job.handle.as_str())]
        )
        .is_err(),
        "deleted upload target cannot disclose stale job metadata"
    );
    assert!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Status,
            vec![text("job", deleted.handle.as_str())]
        )
        .is_ok(),
        "delete result is retained independently of the tombstoned target"
    );

    let (mut service, _, transfer, job, _) = pending_upload().await;
    service.set_now(transfer.expires_at).unwrap();
    assert!(service.resume(&scope(), &transfer.handle).is_err());
    assert!(service.staged(&scope(), &transfer.handle, 0, 1).is_err());
    service.set_now(1010).unwrap();
    assert!(matches!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Status,
            vec![text("job", job.handle.as_str())]
        )
        .unwrap(),
        o::Output::Job(o::Job {
            state: o::JobState::Failed,
            ..
        })
    ));
}

#[tokio::test]
async fn committed_upload_and_copy_results_replays_obey_current_moderation() {
    let (mut service, mut io, transfer, job, _) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    let time = Time(Cell::new(10));
    let rules = Rules::default();
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
        .unwrap();
    let fields = vec![
        text("source", "object"),
        text("source_generation", transfer.target.generation.as_str()),
        text("reference", "copy"),
        ("if_absent".into(), o::Value::Flag(true)),
        text("identity", "copy_once"),
    ];
    let copied = parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap();
    let o::Output::Job(copy_job) = &copied else {
        panic!("copy");
    };
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap(),
        copied
    );
    let generation = GenerationId(
        transfer
            .target
            .generation
            .as_str()
            .strip_prefix("g_")
            .unwrap()
            .parse()
            .unwrap(),
    );
    service
        .catalogue_mut()
        .set_moderation(TENANT, generation, 1, true)
        .unwrap();
    let before = service.allocations();
    for handle in [&job.handle, &copy_job.handle] {
        for operation in [o::Operation::Status, o::Operation::Result] {
            assert!(parity(
                &mut service,
                &scope(),
                operation,
                vec![text("job", handle.as_str())]
            )
            .is_err());
        }
    }
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer)
    )
    .is_err());
    assert!(parity(&mut service, &scope(), o::Operation::Copy, fields).is_err());
    assert_eq!(service.allocations(), before);
}

#[tokio::test]
async fn bounded_admission_allows_exact_replay_and_reserves_actual_record_delta() {
    let (service, io, transfer, job, auth) = pending_upload().await;
    let mut bounded = limits();
    bounded.records = 4;
    let mut service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        bounded,
        profile(),
        10,
    )
    .unwrap();
    let initiation = vec![
        text("reference", "object"),
        text("identity", "init"),
        ("max_bytes".into(), o::Value::Number(io.identity().length)),
        ("if_absent".into(), o::Value::Flag(true)),
    ];
    let replay = parity(
        &mut service,
        &scope(),
        o::Operation::InitiateUpload,
        initiation.clone(),
    )
    .unwrap();
    assert_eq!(
        replay,
        o::Output::Upload {
            transfer: transfer.clone(),
            job: job.clone()
        }
    );
    fully_stage(&mut service, &io, &transfer);
    // Three existing records leave room for exactly one commit replay record.
    let committed = parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    assert_eq!(
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&transfer)
        )
        .unwrap(),
        committed
    );
    assert_eq!(
        parity(
            &mut service,
            &scope(),
            o::Operation::InitiateUpload,
            initiation.clone()
        )
        .unwrap(),
        replay
    );
    let mut changed = commit_fields(&transfer);
    changed.push(("unexpected".into(), o::Value::Flag(true)));
    assert!(parity(&mut service, &scope(), o::Operation::CommitUpload, changed).is_err());
    assert_eq!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "no_capacity")
            ]
        )
        .unwrap_err()
        .code,
        o::ErrorCode::QuotaExceeded
    );
    auth.denied.borrow_mut().insert("object".into());
    assert_eq!(
        parity(
            &mut service,
            &scope(),
            o::Operation::InitiateUpload,
            initiation
        )
        .unwrap_err()
        .code,
        o::ErrorCode::Denied,
        "capacity-free replay must still recheck authority"
    );
}

#[tokio::test]
async fn native_uncertain_cancel_returns_cleanup_required_and_replays() {
    let (mut service, mut io, transfer, job, _) = pending_upload().await;
    fully_stage(&mut service, &io, &transfer);
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    io.inject = Injection::PartialUpload;
    assert_eq!(
        service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &time,
                &rules
            )
            .await
            .unwrap_err()
            .effects,
        o::Effects::Unknown
    );
    let calls = io.order.len();
    let policy = profile();
    let negotiate = request(
        "cancel_session",
        None,
        n::Action::Capabilities(n::Offer {
            versions: vec![1],
            profiles: vec![policy.profiles[0].profile.clone()],
            limits: policy.limits,
        }),
    );
    let n::ResponseBody::Capabilities(selection) =
        native(&mut service, &negotiate, &mut io, &time, &rules).await
    else {
        panic!("session");
    };
    let cancel = request(
        "native_cleanup_cancel",
        Some(&selection.session),
        n::Action::Cancel {
            job: nid(job.handle.as_str()),
        },
    );
    for _ in 0..2 {
        assert_eq!(
            native(&mut service, &cancel, &mut io, &time, &rules).await,
            n::ResponseBody::Cancel(n::CancelOutcome::CleanupRequired)
        );
    }
    assert!(service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &time,
            &rules
        )
        .await
        .is_err());
    assert_eq!(
        io.order.len(),
        calls,
        "cancel and replay never restart storage"
    );
    assert!(service
        .catalogue()
        .lookup(TENANT, "object", 10, service.access().0.as_ref())
        .is_err());
}

#[tokio::test]
async fn negative_authority_profile_and_lifetime_controls_allocate_nothing() {
    let auth = Rc::new(Auth::default());
    let mut service = s::Service::new(Access(auth.clone()), limits(), profile(), 10).unwrap();
    let mut io = Io::new(2).await;
    let time = Time(Cell::new(10));
    let rules = Rules::default();
    let policy = profile();
    let mut unsupported = policy.profiles[0].profile.clone();
    unsupported.crypto = nid("not_supported");
    let unsupported = request(
        "unsupported",
        None,
        n::Action::Capabilities(n::Offer {
            versions: vec![1],
            profiles: vec![unsupported],
            limits: policy.limits,
        }),
    );
    assert_eq!(
        native(&mut service, &unsupported, &mut io, &time, &rules).await,
        n::ResponseBody::Error(n::ErrorCode::UnsupportedProfile)
    );
    assert_eq!(service.allocations(), (0, 0, 0));
    let foreign = o::Scope {
        tenant: id("other"),
        principal: id("principal"),
    };
    for op in [
        o::Operation::Stat,
        o::Operation::AuthorizeDownload,
        o::Operation::Restore,
        o::Operation::Delete,
    ] {
        let mut fields = vec![text("reference", "object"), text("generation", "g_2")];
        if op != o::Operation::Stat {
            fields.push(text("identity", "denied"));
        }
        if op == o::Operation::Restore {
            fields.push(("availability_seconds".into(), o::Value::Number(50)));
        }
        assert_eq!(
            parity(&mut service, &foreign, op, fields).unwrap_err().code,
            o::ErrorCode::Denied
        );
        assert_eq!(service.allocations(), (0, 0, 0));
    }
    assert!(service.set_now(9).is_err());
    let snapshot = service.checkpoint();
    assert!(s::Service::reconnect(snapshot, Access(auth), limits(), profile(), 9).is_err());
    assert!(io.order.is_empty(), "no storage invocation");
    evidence(
        "service-negative.json",
        serde_json::json!({"cases":["unsupported-profile", "foreign-tenant-stat", "foreign-download", "foreign-restore", "foreign-delete", "clock-rollback"], "rest_mcp":"identical domain errors and allocation counts", "allocations":[0,0,0], "storage_calls":0, "authority":"rejected before allocation/disclosure"}),
    );
}
