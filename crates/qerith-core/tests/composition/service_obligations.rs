use super::*;

fn reject(
    service: &mut s::Service<Access>,
    caller: &o::Scope,
    operation: o::Operation,
    fields: o::Fields,
    code: o::ErrorCode,
    effects: o::Effects,
) {
    let allocations = service.allocations();
    let outbox = service.catalogue().outbox(TENANT);
    let direct =
        o::dispatch(service, Some(caller), o::VERSION, operation, fields.clone()).unwrap_err();
    assert_eq!(
        parity(service, caller, operation, fields).unwrap_err(),
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
async fn identity_conflicts_retain_original_upload_not_replacement_handle() {
    for accepted in [false, true] {
        let (mut service, mut io, original, original_job, auth) = pending_upload().await;
        fully_stage(&mut service, &io, &original);
        parity(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            commit_fields(&original),
        )
        .unwrap();
        io.inject = Injection::PartialUpload;
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
                .unwrap_err()
                .effects,
            o::Effects::Unknown
        );
        io.inject = Injection::None;
        let mut intent = upload_intent(&io);
        intent.object = nid("object_b");
        service
            .bind_upload(&scope(), id("init_b"), id("root"), intent.clone())
            .unwrap();
        let o::Output::Upload {
            transfer: replacement,
            job: replacement_job,
        } = parity(
            &mut service,
            &scope(),
            o::Operation::InitiateUpload,
            vec![
                text("reference", "object_b"),
                text("identity", "init_b"),
                ("if_absent".into(), o::Value::Flag(true)),
                ("max_bytes".into(), o::Value::Number(io.identity().length)),
            ],
        )
        .unwrap()
        else {
            panic!("replacement");
        };
        fully_stage(&mut service, &io, &replacement);
        if accepted {
            let mut fields = commit_fields(&replacement);
            fields.retain(|(name, _)| name != "identity");
            fields.push(text("identity", "commit_b"));
            parity(&mut service, &scope(), o::Operation::CommitUpload, fields).unwrap();
        }
        let selection = negotiate(&mut service, &mut io).await;
        let allocations = service.allocations();
        let outbox = service.catalogue().outbox(TENANT);
        let calls = io.order.len();
        let fields = commit_fields(&replacement);
        reject(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            fields.clone(),
            o::ErrorCode::Conflict,
            o::Effects::Unknown,
        );
        let native_commit = request(
            "commit",
            Some(&selection.session),
            n::Action::CommitUpload(n::UploadAction {
                upload: nid(replacement.handle.as_str()),
                intent,
            }),
        );
        assert_eq!(
            native(
                &mut service,
                &native_commit,
                &mut io,
                &Time(Cell::new(10)),
                &Rules::default()
            )
            .await,
            n::ResponseBody::Error(n::ErrorCode::ReplayConflict)
        );
        for (job, expected) in [
            (&original_job, o::Effects::Unknown),
            (
                &replacement_job,
                if accepted {
                    o::Effects::Accepted
                } else {
                    o::Effects::None
                },
            ),
        ] {
            let o::Output::Job(live) = parity(
                &mut service,
                &scope(),
                o::Operation::Status,
                vec![text("job", job.handle.as_str())],
            )
            .unwrap() else {
                panic!("status");
            };
            assert_eq!(live.effects, expected);
        }
        // B remains fully authorized; losing A's grant must not select B's effects.
        auth.denied.borrow_mut().insert("object:Write".into());
        reject(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            fields.clone(),
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        assert_eq!(
            native(
                &mut service,
                &native_commit,
                &mut io,
                &Time(Cell::new(10)),
                &Rules::default()
            )
            .await,
            n::ResponseBody::Error(n::ErrorCode::NotAuthorized)
        );
        auth.denied.borrow_mut().clear();
        for caller in [
            o::Scope {
                principal: id("foreign"),
                ..scope()
            },
            o::Scope {
                tenant: id("foreign"),
                ..scope()
            },
        ] {
            reject(
                &mut service,
                &caller,
                o::Operation::CommitUpload,
                fields.clone(),
                o::ErrorCode::Denied,
                o::Effects::None,
            );
        }
        let mut foreign = fields;
        foreign.retain(|(name, _)| name != "transfer");
        foreign.push(text("transfer", "unowned"));
        reject(
            &mut service,
            &scope(),
            o::Operation::CommitUpload,
            foreign,
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        assert_eq!(io.order.len(), calls);
        assert_eq!(service.allocations(), allocations);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
    }
    evidence(
        "service-original-upload-obligation.json",
        serde_json::json!({
            "original":"Unknown", "replacement":["None", "Accepted"],
            "conflict":"Unknown", "revoked_or_foreign":"Denied/None",
            "paths":["domain", "REST", "MCP", "native"], "new_rejection_effects":0
        }),
    );
}

#[tokio::test]
async fn copy_changed_inputs_keep_committed_original_and_recheck_original_grants() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    parity(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&upload.target, "copy_a", "copy_identity"),
    )
    .unwrap();
    let calls = io.order.len();
    let fields = copy_fields(&upload.target, "copy_b", "copy_identity");
    reject(
        &mut service,
        &scope(),
        o::Operation::Copy,
        fields.clone(),
        o::ErrorCode::Conflict,
        o::Effects::Committed,
    );
    let until = service
        .catalogue()
        .lookup(TENANT, "object", 10, auth.as_ref())
        .unwrap()
        .availability_until
        .unwrap();
    service.set_now(until).unwrap();
    // Lease expiry must not replace an authorized bound-identity conflict.
    reject(
        &mut service,
        &scope(),
        o::Operation::Copy,
        fields.clone(),
        o::ErrorCode::Conflict,
        o::Effects::Committed,
    );
    // A fresh identity still needs an available source and has no prior effects.
    reject(
        &mut service,
        &scope(),
        o::Operation::Copy,
        copy_fields(&upload.target, "copy_b", "fresh_copy"),
        o::ErrorCode::NotAvailable,
        o::Effects::None,
    );
    for revoked in [
        "copy_b:Write",
        "object:Read",
        "copy_a:Write",
        "root",
        "key_ref",
        "envelope_ref",
        "copy_context",
    ] {
        auth.denied.borrow_mut().insert(revoked.into());
        reject(
            &mut service,
            &scope(),
            o::Operation::Copy,
            fields.clone(),
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        auth.denied.borrow_mut().clear();
    }
    assert!(service
        .catalogue()
        .lookup(TENANT, "copy_b", 10, auth.as_ref())
        .is_err());
    assert_eq!(io.order.len(), calls);
}

struct InnerClock {
    reads: Cell<usize>,
    fail_at: usize,
}
impl Clock for InnerClock {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        let read = self.reads.get() + 1;
        self.reads.set(read);
        if read == self.fail_at {
            Err(Error::Unavailable)
        } else {
            Ok(10)
        }
    }
}

#[tokio::test]
async fn inner_clock_unavailable_retains_unknown_and_cleanup_without_masking_revocation() {
    for fail_at in [2, 3] {
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
        io.inject = Injection::None;
        let baseline = service.checkpoint();
        let calls = io.order.len();
        let allocations = service.allocations();
        let outbox = service.catalogue().outbox(TENANT);
        let clock = InnerClock {
            reads: Cell::new(0),
            fail_at,
        };
        let failure = service
            .finish_upload(
                &scope(),
                &transfer.handle,
                &mut io,
                &budget(),
                &clock,
                &Rules::default(),
            )
            .await
            .unwrap_err();
        assert_eq!(clock.reads.get(), fail_at);
        assert_eq!(
            failure,
            o::Failure {
                code: o::ErrorCode::Unavailable,
                effects: o::Effects::Unknown
            }
        );
        assert!(failure.reconciliation_required());
        assert!(!failure.retryable());
        assert_eq!(io.order.len(), calls + if fail_at == 3 { 2 } else { 0 });
        assert_eq!(service.allocations(), allocations);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
        let o::Output::Cancel {
            job: cancelled,
            outcome,
        } = parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "clock_cleanup"),
            ],
        )
        .unwrap()
        else {
            panic!("cancel");
        };
        assert_eq!(outcome, o::CancelOutcome::Requested);
        assert_eq!(cancelled.effects, o::Effects::Unknown);
        // Revocation at the catalogue's final commit remains an opaque denial,
        // even though stage_upload has completed a physical copy.
        service =
            s::Service::reconnect(baseline, Access(auth.clone()), limits(), profile(), 10).unwrap();
        io.revoke_at_upload = Some((auth.clone(), "object:Write".into()));
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
                .unwrap_err(),
            o::Failure::new(o::ErrorCode::Denied)
        );
        let calls = io.order.len();
        reject(
            &mut service,
            &scope(),
            o::Operation::Status,
            vec![text("job", job.handle.as_str())],
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        let clock = InnerClock {
            reads: Cell::new(0),
            fail_at,
        };
        assert_eq!(
            service
                .finish_upload(
                    &scope(),
                    &transfer.handle,
                    &mut io,
                    &budget(),
                    &clock,
                    &Rules::default()
                )
                .await
                .unwrap_err(),
            o::Failure::new(o::ErrorCode::Denied)
        );
        assert_eq!(clock.reads.get(), 0);
        assert_eq!(io.order.len(), calls);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
        auth.denied.borrow_mut().clear();
        let o::Output::Cancel { outcome, job, .. } = parity(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            vec![
                text("job", job.handle.as_str()),
                text("identity", "revoked_clock_cleanup"),
            ],
        )
        .unwrap() else {
            panic!("cancel");
        };
        assert_eq!(outcome, o::CancelOutcome::Requested);
        assert_eq!(job.effects, o::Effects::Unknown);
    }
    evidence(
        "service-inner-clock-obligation.json",
        serde_json::json!({
            "outer_read":"success", "unavailable_reads":[2,3],
            "failure":"Unavailable/Unknown", "cleanup":"Requested/Unknown",
            "revocation":"Denied/None", "new_unauthorized_effects":0
        }),
    );
}

#[tokio::test]
async fn cancel_write_only_upload_rechecks_write_without_requiring_read() {
    for path in ["domain", "REST_MCP", "native"] {
        for revoked in [false, true] {
            let auth = Rc::new(Auth::default());
            auth.denied.borrow_mut().insert("object:Read".into());
            let mut service =
                s::Service::new(Access(auth.clone()), limits(), profile(), 10).unwrap();
            let mut io = Io::new(1).await;
            service
                .bind_upload(&scope(), id("init"), id("root"), upload_intent(&io))
                .unwrap();
            let o::Output::Upload { job, .. } = parity(
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
                panic!("write-only upload");
            };
            let selection = negotiate(&mut service, &mut io).await;
            let status = vec![text("job", job.handle.as_str())];
            assert_eq!(
                parity(&mut service, &scope(), o::Operation::Status, status.clone()).unwrap(),
                o::Output::Job(job.clone())
            );
            let fields = vec![
                text("job", job.handle.as_str()),
                text("identity", "write_only_cancel"),
            ];
            let allocations = service.allocations();
            let outbox = service.catalogue().outbox(TENANT);
            let calls = io.order.len();
            if revoked {
                auth.denied.borrow_mut().insert("object:Write".into());
            }
            if path == "native" {
                assert_eq!(
                    native(
                        &mut service,
                        &request(
                            "write_only_cancel",
                            Some(&selection.session),
                            n::Action::Cancel {
                                job: nid(job.handle.as_str()),
                            },
                        ),
                        &mut io,
                        &Time(Cell::new(10)),
                        &Rules::default(),
                    )
                    .await,
                    if revoked {
                        n::ResponseBody::Error(n::ErrorCode::NotAuthorized)
                    } else {
                        n::ResponseBody::Cancel(n::CancelOutcome::CancelledBeforeCommit)
                    }
                );
            } else {
                let result = if path == "domain" {
                    o::dispatch(
                        &mut service,
                        Some(&scope()),
                        o::VERSION,
                        o::Operation::Cancel,
                        fields,
                    )
                } else {
                    parity(&mut service, &scope(), o::Operation::Cancel, fields)
                };
                if revoked {
                    let failure = result.unwrap_err();
                    assert_eq!(
                        failure,
                        o::Failure {
                            code: o::ErrorCode::Denied,
                            effects: o::Effects::None,
                        }
                    );
                    assert!(!failure.reconciliation_required());
                } else {
                    let o::Output::Cancel { outcome, job } = result.unwrap() else {
                        panic!("write-only cancel");
                    };
                    assert_eq!(outcome, o::CancelOutcome::StoppedBeforeCommit);
                    assert_eq!(job.state, o::JobState::Cancelled);
                    assert_eq!(job.effects, o::Effects::None);
                }
            }
            auth.denied.borrow_mut().remove("object:Write");
            let o::Output::Job(after) =
                parity(&mut service, &scope(), o::Operation::Status, status).unwrap()
            else {
                panic!("status");
            };
            if revoked {
                assert_eq!(after, job);
            } else {
                assert_eq!(after.state, o::JobState::Cancelled);
                assert_eq!(after.effects, o::Effects::None);
            }
            assert_eq!(service.allocations(), allocations);
            assert_eq!(service.catalogue().outbox(TENANT), outbox);
            assert_eq!(io.order.len(), calls);
        }
    }
}

#[tokio::test]
async fn cancel_uses_live_restore_terminal_state_before_mutation_grants() {
    for state in [
        "queued",
        "running",
        "published",
        "failed",
        "expired",
        "cancelled",
    ] {
        let (mut service, mut io, upload, _, auth) = hot_upload().await;
        let selection = negotiate(&mut service, &mut io).await;
        let o::Output::Job(job) = parity(
            &mut service,
            &scope(),
            o::Operation::Restore,
            vec![
                text("reference", "object"),
                text("generation", upload.target.generation.as_str()),
                text("identity", "terminal_restore"),
                ("availability_seconds".into(), o::Value::Number(30)),
            ],
        )
        .unwrap() else {
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
        match state {
            "published" => run(
                service.catalogue_mut(),
                &mut io,
                physical,
                &Time(Cell::new(10)),
                &Rules::default(),
                auth.as_ref(),
            )
            .await
            .unwrap(),
            "failed" | "running" => {
                let fence = service
                    .catalogue_mut()
                    .claim(TENANT, physical, 10, 20)
                    .unwrap();
                if state == "failed" {
                    service
                        .catalogue_mut()
                        .transition(
                            TENANT,
                            fence,
                            Transition::FailUnrecoverable,
                            10,
                            auth.as_ref(),
                        )
                        .unwrap();
                }
            }
            "expired" => {
                service
                    .catalogue_mut()
                    .expire_job(TENANT, physical, 1010)
                    .unwrap();
                service.set_now(1010).unwrap();
            }
            "cancelled" => {
                auth.denied.borrow_mut().insert("object:Restore".into());
                service
                    .catalogue_mut()
                    .cancel_unneeded_restore(TENANT, physical, 10, auth.as_ref())
                    .unwrap();
            }
            _ => {}
        }
        let selection = if state == "expired" {
            let policy = profile();
            let n::ResponseBody::Capabilities(refreshed) = native(
                &mut service,
                &request(
                    "fresh_cancel_session",
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
                panic!("refreshed session");
            };
            refreshed
        } else {
            selection
        };
        auth.denied.borrow_mut().insert("object:Restore".into());
        let fields = vec![
            text("job", job.handle.as_str()),
            text("identity", "terminal_cancel"),
        ];
        let allocations = service.allocations();
        let outbox = service.catalogue().outbox(TENANT);
        let stored = service.catalogue().job(TENANT, physical).unwrap();
        let before = service
            .catalogue()
            .lookup(TENANT, "object", service.now(), auth.as_ref())
            .unwrap();
        let calls = io.order.len();
        // All scopes and Read revocations stay opaque, including terminal jobs.
        auth.denied.borrow_mut().insert("object:Read".into());
        reject(
            &mut service,
            &scope(),
            o::Operation::Cancel,
            fields.clone(),
            o::ErrorCode::Denied,
            o::Effects::None,
        );
        auth.denied.borrow_mut().remove("object:Read");
        for caller in [
            o::Scope {
                principal: id("foreign"),
                ..scope()
            },
            o::Scope {
                tenant: id("foreign"),
                ..scope()
            },
        ] {
            reject(
                &mut service,
                &caller,
                o::Operation::Cancel,
                fields.clone(),
                o::ErrorCode::Denied,
                o::Effects::None,
            );
        }
        if matches!(state, "queued" | "running") {
            reject(
                &mut service,
                &scope(),
                o::Operation::Cancel,
                fields,
                o::ErrorCode::Denied,
                o::Effects::None,
            );
        } else {
            let o::Output::Cancel {
                outcome,
                job: projected,
            } = parity(&mut service, &scope(), o::Operation::Cancel, fields).unwrap()
            else {
                panic!("cancel {state}");
            };
            assert_eq!(
                outcome,
                if state == "published" {
                    o::CancelOutcome::AlreadyCommitted
                } else {
                    o::CancelOutcome::AlreadyTerminal
                }
            );
            assert_eq!(
                projected.effects,
                if state == "published" {
                    o::Effects::Committed
                } else {
                    o::Effects::Accepted
                }
            );
        }
        {
            let now = service.now();
            let req = request(
                "native_terminal_cancel",
                Some(&selection.session),
                n::Action::Cancel {
                    job: nid(job.handle.as_str()),
                },
            );
            let expected = match state {
                "queued" | "running" => n::ResponseBody::Error(n::ErrorCode::NotAuthorized),
                "published" => n::ResponseBody::Cancel(n::CancelOutcome::AlreadyCommitted),
                _ => n::ResponseBody::Cancel(n::CancelOutcome::AlreadyFinished),
            };
            assert_eq!(
                native(
                    &mut service,
                    &req,
                    &mut io,
                    &Time(Cell::new(now)),
                    &Rules::default()
                )
                .await,
                expected,
                "{state}"
            );
            auth.denied.borrow_mut().insert("object:Read".into());
            assert_eq!(
                native(
                    &mut service,
                    &req,
                    &mut io,
                    &Time(Cell::new(now)),
                    &Rules::default()
                )
                .await,
                n::ResponseBody::Error(n::ErrorCode::NotAuthorized)
            );
        }
        assert_eq!(service.allocations(), allocations);
        assert_eq!(service.catalogue().outbox(TENANT), outbox);
        assert_eq!(service.catalogue().job(TENANT, physical).unwrap(), stored);
        auth.denied.borrow_mut().remove("object:Read");
        assert_eq!(
            service
                .catalogue()
                .lookup(TENANT, "object", service.now(), auth.as_ref())
                .unwrap(),
            before
        );
        assert_eq!(io.order.len(), calls);
    }
    evidence(
        "service-terminal-cancel.json",
        serde_json::json!({
            "published":"AlreadyCommitted", "failed_expired_cancelled":"AlreadyTerminal",
            "queued_running_without_restore":"Denied/None", "foreign_or_no_read":"Denied/None",
            "storage_outbox_subscription_mutations":0, "qualification":"synthetic reference only"
        }),
    );
}
