use super::*;
use s::Access as _;

#[tokio::test]
async fn committed_native_reply_survives_session_expiry_at_worker_entry() {
    let mut service =
        s::Service::new(Access(Rc::new(Auth::default())), limits(), profile(), 10).unwrap();
    let mut io = Io::new(2).await;
    let selection = negotiate(&mut service, &mut io).await;
    service.set_now(1000).unwrap();
    let intent = upload_intent(&io);
    let n::ResponseBody::Upload { upload, .. } = native(
        &mut service,
        &request(
            "late_upload",
            Some(&selection.session),
            n::Action::InitiateUpload(intent.clone()),
        ),
        &mut io,
        &Time(Cell::new(1000)),
        &Rules::default(),
    )
    .await
    else {
        panic!("upload");
    };
    let (transfer, _) = service.resume(&scope(), &id(upload.as_str())).unwrap();
    fully_stage(&mut service, &io, &transfer);
    let mut commit = request(
        "late_commit",
        Some(&selection.session),
        n::Action::CommitUpload(n::UploadAction { upload, intent }),
    );
    assert!(matches!(
        native(
            &mut service,
            &commit,
            &mut io,
            &Time(Cell::new(1010)),
            &Rules::default()
        )
        .await,
        n::ResponseBody::Error(_)
    ));
    let policy = profile();
    let n::ResponseBody::Capabilities(refreshed) = native(
        &mut service,
        &request(
            "refreshed_session",
            None,
            n::Action::Capabilities(n::Offer {
                versions: vec![1],
                profiles: vec![policy.profiles[0].profile.clone()],
                limits: policy.limits,
            }),
        ),
        &mut io,
        &Time(Cell::new(1010)),
        &Rules::default(),
    )
    .await
    else {
        panic!("session");
    };
    commit.session = Some(refreshed.session);
    let calls = io.order.len();
    assert!(matches!(
        native(
            &mut service,
            &commit,
            &mut io,
            &Time(Cell::new(1010)),
            &Rules::default()
        )
        .await,
        n::ResponseBody::Committed(_)
    ));
    assert_eq!(
        io.order.len(),
        calls,
        "accepted commit reconciles without new I/O"
    );
}

struct BoundaryAccess {
    inner: Access,
    copy_checks: Cell<usize>,
    revoke: &'static str,
}
impl s::Access for BoundaryAccess {
    fn tenant(&self, scope: &o::Scope) -> Option<TenantId> {
        self.inner.tenant(scope)
    }
    fn permits(&self, scope: &o::Scope, reference: &str, action: Action) -> bool {
        // The third compatibility check is in apply, immediately before Link.
        if reference == "object" && action == Action::Read && self.copy_checks.get() >= 3 {
            self.inner.0.denied.borrow_mut().insert(self.revoke.into());
        }
        self.inner.permits(scope, reference, action)
    }
    fn container(&self, scope: &o::Scope, parent: &str) -> bool {
        self.inner.container(scope, parent)
    }
    fn admit(&self, scope: &o::Scope) -> bool {
        self.inner.admit(scope)
    }
    fn key_envelope(&self, scope: &o::Scope, key: &n::Opaque, envelope: &n::Opaque) -> bool {
        self.inner.key_envelope(scope, key, envelope)
    }
    fn copy_compatible(
        &self,
        scope: &o::Scope,
        source: &n::Object,
        destination: &o::Opaque,
    ) -> bool {
        self.copy_checks.set(self.copy_checks.get() + 1);
        self.inner.copy_compatible(scope, source, destination)
    }
}

#[tokio::test]
async fn copy_effect_authority_rechecks_each_extra_grant_after_preflight() {
    let (service, _, upload, _, auth) = hot_upload().await;
    for revoke in ["root", "key_ref", "envelope_ref", "copy_context"] {
        auth.denied.borrow_mut().clear();
        let mut candidate = s::Service::reconnect(
            service.checkpoint(),
            BoundaryAccess {
                inner: Access(auth.clone()),
                copy_checks: Cell::new(0),
                revoke,
            },
            limits(),
            profile(),
            10,
        )
        .unwrap();
        let before = candidate.allocations();
        let outbox = candidate.catalogue().outbox(TENANT);
        let result = o::dispatch(
            &mut candidate,
            Some(&scope()),
            o::VERSION,
            o::Operation::Copy,
            copy_fields(&upload.target, "copy", "effect_copy"),
        );
        assert_eq!(result.unwrap_err().code, o::ErrorCode::Denied, "{revoke}");
        assert!(
            auth.denied.borrow().contains(revoke),
            "revocation must occur at Link authorization"
        );
        assert_eq!(candidate.allocations(), before);
        assert_eq!(candidate.catalogue().outbox(TENANT), outbox);
        assert!(candidate
            .catalogue()
            .lookup(TENANT, "copy", 10, auth.as_ref())
            .is_err());
    }
}

#[tokio::test]
async fn native_restore_budget_is_a_deadline_not_only_an_availability_lease() {
    let (mut service, mut io, upload, _, _) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let req = request(
        "short_restore",
        Some(&selection.session),
        n::Action::Restore(n::Restore {
            target: n::Target {
                object: nid("object"),
                g: nid(upload.target.generation.as_str()),
            },
            max_bytes: 4096,
            max_seconds: 7,
        }),
    );
    let n::ResponseBody::Restore(job) = native(
        &mut service,
        &req,
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await
    else {
        panic!("restore");
    };
    let stored = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job),
            _ => None,
        })
        .unwrap();
    assert_eq!(stored.deadline, 17);
    service.set_now(17).unwrap();
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Result,
        vec![text("job", job.job.as_str())]
    )
    .is_err());
}

#[tokio::test]
async fn write_only_destination_can_stage_verify_resume_and_commit_acceptance() {
    let (mut service, io, transfer, _, auth) = pending_upload().await;
    auth.denied.borrow_mut().insert("object:Read".into());
    fully_stage(&mut service, &io, &transfer);
    service.resume(&scope(), &transfer.handle).unwrap();
    parity(
        &mut service,
        &scope(),
        o::Operation::CommitUpload,
        commit_fields(&transfer),
    )
    .unwrap();
}

#[tokio::test]
async fn browse_successor_retries_reuse_capacity_and_direct_execute_checks_cursor() {
    use o::OperationPort;
    let (mut service, _, upload, _, _) = hot_upload().await;
    for (destination, identity) in [("copy_a", "page_a"), ("copy_b", "page_b")] {
        parity(
            &mut service,
            &scope(),
            o::Operation::Copy,
            copy_fields(&upload.target, destination, identity),
        )
        .unwrap();
    }
    let fields = vec![
        text("parent", "root"),
        ("limit".into(), o::Value::Number(1)),
    ];
    let o::Output::Page {
        cursor: Some(cursor),
        ..
    } = parity(&mut service, &scope(), o::Operation::Browse, fields.clone()).unwrap()
    else {
        panic!("page");
    };
    let mut next = fields;
    next.push(text("cursor", cursor.as_str()));
    let page = parity(&mut service, &scope(), o::Operation::Browse, next.clone()).unwrap();
    for _ in 0..10 {
        assert_eq!(
            parity(&mut service, &scope(), o::Operation::Browse, next.clone()).unwrap(),
            page
        );
    }
    let req = o::Operation::Browse.definition().validate(next).unwrap();
    service.set_now(210).unwrap();
    assert_eq!(
        service
            .execute(&scope(), &req, Some(&cursor))
            .unwrap_err()
            .code,
        o::ErrorCode::InvalidCursor
    );
}

#[tokio::test]
async fn uncertain_effects_survive_fresh_commit_deadline_result_and_worker_exit() {
    let (mut service, mut io, transfer, job, _) = pending_upload().await;
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
    let mut fresh = commit_fields(&transfer);
    fresh.retain(|(k, _)| k != "identity");
    fresh.push(text("identity", "fresh_commit"));
    let o::Output::Job(accepted) =
        parity(&mut service, &scope(), o::Operation::CommitUpload, fresh).unwrap()
    else {
        panic!("commit");
    };
    assert_eq!(accepted.effects, o::Effects::Unknown);
    service.set_now(1010).unwrap();
    let failure = parity(
        &mut service,
        &scope(),
        o::Operation::Result,
        vec![text("job", job.handle.as_str())],
    )
    .unwrap_err();
    assert_eq!(failure.effects, o::Effects::Unknown);
    assert!(!failure.retryable());
    assert!(failure.reconciliation_required());
    let calls = io.order.len();
    let failure = service
        .finish_upload(
            &scope(),
            &transfer.handle,
            &mut io,
            &budget(),
            &Time(Cell::new(1010)),
            &Rules::default(),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.effects, o::Effects::Unknown);
    assert_eq!(io.order.len(), calls);
}

#[tokio::test]
async fn native_initiation_replay_rechecks_retained_parent_not_caller_substitute() {
    let auth = Rc::new(Auth::default());
    let mut service = s::Service::new(Access(auth.clone()), limits(), profile(), 10).unwrap();
    let mut io = Io::new(2).await;
    let selection = negotiate(&mut service, &mut io).await;
    let req = request(
        "parent_replay",
        Some(&selection.session),
        n::Action::InitiateUpload(upload_intent(&io)),
    );
    let issued = native(
        &mut service,
        &req,
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await;
    assert!(matches!(issued, n::ResponseBody::Upload { .. }));
    let before = service.allocations();
    auth.denied.borrow_mut().insert("root".into());
    assert_eq!(
        native(
            &mut service,
            &req,
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default()
        )
        .await,
        n::ResponseBody::Error(n::ErrorCode::NotAuthorized)
    );
    auth.denied.borrow_mut().clear();
    let response = service
        .native_call(
            &scope(),
            &id("other_parent"),
            &req,
            s::UploadWorker {
                storage: &mut io,
                budget: &budget(),
                clock: &Time(Cell::new(10)),
                policy: &Rules::default(),
            },
        )
        .await;
    assert_eq!(
        response.body,
        n::ResponseBody::Error(n::ErrorCode::ReplayConflict)
    );
    assert_eq!(service.allocations(), before);
}

#[tokio::test]
async fn restore_replay_rechecks_restore_action_and_cancel_does_not_need_write() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let target = n::Target {
        object: nid("object"),
        g: nid(upload.target.generation.as_str()),
    };
    let req = request(
        "restore_action",
        Some(&selection.session),
        n::Action::Restore(n::Restore {
            target: target.clone(),
            max_bytes: 4096,
            max_seconds: 20,
        }),
    );
    let issued = native(
        &mut service,
        &req,
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await;
    let n::ResponseBody::Restore(native_job) = issued else {
        panic!("restore");
    };
    let mut fields = target_fields(&target);
    fields.extend([
        text("identity", "rest_restore_action"),
        ("availability_seconds".into(), o::Value::Number(20)),
    ]);
    let accepted = parity(
        &mut service,
        &scope(),
        o::Operation::Restore,
        fields.clone(),
    )
    .unwrap();
    auth.denied.borrow_mut().insert("object:Restore".into());
    assert_eq!(
        native(
            &mut service,
            &req,
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default()
        )
        .await,
        n::ResponseBody::Error(n::ErrorCode::NotAuthorized)
    );
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Restore, fields)
            .unwrap_err()
            .code,
        o::ErrorCode::Denied
    );
    auth.denied.borrow_mut().clear();
    auth.denied.borrow_mut().insert("object:Write".into());
    let o::Output::Job(job) = accepted else {
        panic!("restore");
    };
    assert!(matches!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "cancel_read_restore")
            ]
        )
        .unwrap(),
        o::Output::Cancel {
            outcome: o::CancelOutcome::StoppedBeforeCommit,
            ..
        }
    ));
    assert!(matches!(
        native(
            &mut service,
            &request(
                "native_cancel_restore",
                Some(&selection.session),
                n::Action::Cancel {
                    job: native_job.job
                }
            ),
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default()
        )
        .await,
        n::ResponseBody::Cancel(_)
    ));
}

#[tokio::test]
async fn shared_restore_reports_only_the_published_subscription() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let o::Output::Job(copy) = parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&upload.target, "copy", "mixed_copy"),
    )
    .unwrap() else {
        panic!("copy");
    };
    let mut jobs = Vec::new();
    for target in [&upload.target, &copy.target] {
        let o::Output::Job(job) = parity(
            &mut service,
            &scope(),
            o::Operation::Restore,
            vec![
                text("reference", target.reference.as_str()),
                text("generation", target.generation.as_str()),
                text("identity", &format!("mixed_{}", target.reference.as_str())),
                ("availability_seconds".into(), o::Value::Number(30)),
            ],
        )
        .unwrap() else {
            panic!("restore");
        };
        jobs.push(job);
    }
    let physical = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
            _ => None,
        })
        .unwrap();
    auth.denied.borrow_mut().insert("copy:Restore".into());
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
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::Result,
        vec![text("job", jobs[0].handle.as_str())]
    )
    .is_ok());
    assert_eq!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Result,
            vec![text("job", jobs[1].handle.as_str())]
        )
        .unwrap_err()
        .code,
        o::ErrorCode::Unavailable
    );
    auth.denied.borrow_mut().clear();
    assert!(
        parity(
            &mut service,
            &scope(),
            o::Operation::Result,
            vec![text("job", jobs[1].handle.as_str())]
        )
        .is_err(),
        "later grant cannot invent past publication"
    );
    assert_eq!(
        service
            .catalogue()
            .lookup(TENANT, "copy", 10, auth.as_ref())
            .unwrap()
            .availability_until,
        None
    );
}

#[tokio::test]
async fn copy_reconciliation_survives_source_expiry_and_tombstone_but_rechecks_grants() {
    let (mut service, _, upload, _, auth) = hot_upload().await;
    let fields = copy_fields(&upload.target, "copy", "historical_copy");
    let accepted = parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap();
    service.set_now(60).unwrap();
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap(),
        accepted
    );
    parity(
        &mut service,
        &scope(),
        o::Operation::Delete,
        vec![
            text("reference", "object"),
            text("generation", upload.target.generation.as_str()),
            text("identity", "source_tombstone"),
        ],
    )
    .unwrap();
    assert_eq!(
        parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).unwrap(),
        accepted
    );
    for grant in ["root", "key_ref", "copy_context", "copy"] {
        auth.denied.borrow_mut().insert(grant.into());
        assert!(parity(&mut service, &scope(), o::Operation::Copy, fields.clone()).is_err());
        auth.denied.borrow_mut().clear();
    }
}

#[tokio::test]
async fn copied_destination_accepts_same_ciphertext_upload_as_new_storage_generation() {
    for change_c in [false, true] {
        let (mut service, mut io, upload, _, auth) = hot_upload().await;
        let selection = negotiate(&mut service, &mut io).await;
        let o::Output::Job(copy) = parity(
            &mut service,
            &scope(),
            o::Operation::Copy,
            copy_fields(&upload.target, "copy", "replace_copy"),
        )
        .unwrap() else {
            panic!("copy");
        };
        let mut intent = upload_intent(&io);
        intent.object = nid("copy");
        intent.precondition = n::Precondition::Matches(nid(copy.target.generation.as_str()));
        if change_c {
            intent.ciphertext.c = nid("new_C");
        }
        service
            .bind_upload(&scope(), id("replacement"), id("root"), intent.clone())
            .unwrap();
        let o::Output::Upload { transfer, .. } = parity(
            &mut service,
            &scope(),
            o::Operation::InitiateUpload,
            vec![
                text("reference", "copy"),
                text("generation", copy.target.generation.as_str()),
                text("identity", "replacement"),
                ("max_bytes".into(), o::Value::Number(io.identity().length)),
            ],
        )
        .unwrap() else {
            panic!("upload");
        };
        fully_stage(&mut service, &io, &transfer);
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&transfer),
        )
        .unwrap();
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
            .lookup(TENANT, "copy", 10, auth.as_ref())
            .unwrap();
        let source = service
            .catalogue()
            .lookup(TENANT, "object", 10, auth.as_ref())
            .unwrap();
        assert_ne!(stored.generation, source.generation);
        assert_ne!(stored.metadata.validator, source.metadata.validator);
        let target = n::Target {
            object: nid("copy"),
            g: nid(transfer.target.generation.as_str()),
        };
        let n::ResponseBody::Stat(object) = native(
            &mut service,
            &request(
                "replacement_stat",
                Some(&selection.session),
                n::Action::Stat(target),
            ),
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await
        else {
            panic!("stat");
        };
        assert_eq!(object.ciphertext, intent.ciphertext);
        assert!(parity(
            &mut service,
            &scope(),
            o::Operation::Stat,
            vec![
                text("reference", "copy"),
                text("generation", copy.target.generation.as_str())
            ]
        )
        .is_err());
        assert!(parity(
            &mut service,
            &scope(),
            o::Operation::Stat,
            vec![
                text("reference", "copy"),
                text("generation", upload.target.generation.as_str())
            ]
        )
        .is_err());
    }
}

#[tokio::test]
async fn native_copy_delete_jobs_fail_explicitly_without_upload_projection() {
    let (mut service, mut io, upload, _, _) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let o::Output::Job(copy) = parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&upload.target, "copy", "native_copy_job"),
    )
    .unwrap() else {
        panic!("copy");
    };
    let o::Output::Job(delete) = parity(
        &mut service,
        &scope(),
        o::Operation::Delete,
        vec![
            text("reference", "object"),
            text("generation", upload.target.generation.as_str()),
            text("identity", "native_delete_job"),
        ],
    )
    .unwrap() else {
        panic!("delete");
    };
    for job in [copy, delete] {
        for action in [
            n::Action::Status {
                job: nid(job.handle.as_str()),
            },
            n::Action::Cancel {
                job: nid(job.handle.as_str()),
            },
        ] {
            assert_eq!(
                native(
                    &mut service,
                    &request(
                        &format!(
                            "job_{}_{}",
                            job.handle.as_str(),
                            if matches!(action, n::Action::Status { .. }) {
                                "status"
                            } else {
                                "cancel"
                            }
                        ),
                        Some(&selection.session),
                        action
                    ),
                    &mut io,
                    &Time(Cell::new(10)),
                    &Rules::default()
                )
                .await,
                n::ResponseBody::Error(n::ErrorCode::UnsupportedProfile)
            );
        }
    }
}

#[tokio::test]
async fn native_punctuation_identities_preserve_request_object_and_replay() {
    let auth = Rc::new(Auth::default());
    let mut service = s::Service::new(Access(auth), limits(), profile(), 10).unwrap();
    let mut io = Io::new(2).await;
    let selection = negotiate(&mut service, &mut io).await;
    let mut intent = upload_intent(&io);
    intent.object = nid("object.part:1");
    let req = request(
        "upload:1",
        Some(&selection.session),
        n::Action::InitiateUpload(intent),
    );
    let issued = native(
        &mut service,
        &req,
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await;
    assert!(
        matches!(issued, n::ResponseBody::Upload { .. }),
        "{issued:?}"
    );
    assert_eq!(
        native(
            &mut service,
            &req,
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default()
        )
        .await,
        issued
    );
}

#[tokio::test]
async fn native_capabilities_reserve_two_records_and_replay_without_capacity() {
    for records in [1, 2, 3] {
        let mut bounded = limits();
        bounded.records = records;
        let mut service =
            s::Service::new(Access(Rc::new(Auth::default())), bounded, profile(), 10).unwrap();
        let mut io = Io::new(2).await;
        let policy = profile();
        let req = request(
            "caps_once",
            None,
            n::Action::Capabilities(n::Offer {
                versions: vec![1],
                profiles: vec![policy.profiles[0].profile.clone()],
                limits: policy.limits,
            }),
        );
        let issued = native(
            &mut service,
            &req,
            &mut io,
            &Time(Cell::new(10)),
            &Rules::default(),
        )
        .await;
        if records == 1 {
            assert_eq!(issued, n::ResponseBody::Error(n::ErrorCode::LimitExceeded));
        } else {
            assert!(matches!(issued, n::ResponseBody::Capabilities(_)));
            assert_eq!(
                native(
                    &mut service,
                    &req,
                    &mut io,
                    &Time(Cell::new(10)),
                    &Rules::default()
                )
                .await,
                issued
            );
            let mut another = req.clone();
            another.request_id = nid("caps_again");
            assert_eq!(
                native(
                    &mut service,
                    &another,
                    &mut io,
                    &Time(Cell::new(10)),
                    &Rules::default()
                )
                .await,
                n::ResponseBody::Error(n::ErrorCode::LimitExceeded)
            );
        }
    }
}
