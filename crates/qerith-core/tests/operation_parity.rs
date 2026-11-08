use qerith_core::operations::*;
#[path = "operations/fixture.rs"]
mod fixture;
use fixture::*;

#[derive(Clone, Copy)]
enum Transport {
    Rest,
    Mcp,
}
const TRANSPORTS: [Transport; 2] = [Transport::Rest, Transport::Mcp];

fn call(
    transport: Transport,
    fixture: &mut Fixture,
    scope: Option<&Scope>,
    op: Operation,
    fields: Fields,
) -> Result<Output, Failure> {
    match transport {
        Transport::Rest => {
            rest_call(
                fixture,
                scope,
                "POST",
                &format!("/v1/operations/{}", op.definition().name),
                fields,
            )
            .outcome
        }
        Transport::Mcp => {
            mcp_call(
                fixture,
                scope,
                McpSession::default(),
                TaskMode::Baseline,
                op.definition().name,
                fields,
            )
            .outcome
        }
    }
}

fn parity(
    fixture: &Fixture,
    scope: Option<&Scope>,
    op: Operation,
    fields: Fields,
) -> Result<Output, Failure> {
    let rest = call(
        Transport::Rest,
        &mut fixture.clone(),
        scope,
        op,
        fields.clone(),
    );
    let mcp = call(Transport::Mcp, &mut fixture.clone(), scope, op, fields);
    assert_eq!(rest, mcp, "{}", op.definition().name);
    rest
}

#[test]
fn registry_drives_both_projections_and_capabilities() {
    let routes = rest_routes();
    let tools = mcp_tools();
    assert_eq!(routes.len(), REGISTRY.len());
    let implemented: Vec<_> = REGISTRY.iter().filter(|d| d.implemented).collect();
    assert_eq!(tools.len(), implemented.len());
    for (tool, definition) in tools.iter().zip(&implemented) {
        assert_eq!(tool.definition, *definition);
        assert_eq!(tool.name, definition.name);
    }
    for (i, definition) in REGISTRY.iter().enumerate() {
        assert_eq!(routes[i].definition, definition);
        assert_eq!(
            routes[i].path,
            format!("/v1/operations/{}", definition.name)
        );
        if definition.effects != EffectClass::ReadOnly {
            assert!(definition
                .input
                .iter()
                .any(|f| f.name == "identity" && f.required));
        }
    }
    let Output::Capabilities {
        version,
        operations,
        experimental_tasks,
    } = parity(
        &Fixture::default(),
        Some(&scope("a")),
        Operation::Capabilities,
        vec![],
    )
    .unwrap()
    else {
        panic!()
    };
    assert_eq!(version, VERSION);
    assert!(!experimental_tasks);
    assert!(!operations.contains(&Operation::Versions));
    assert_eq!(
        operations,
        tools
            .iter()
            .map(|tool| tool.definition.operation)
            .collect::<Vec<_>>()
    );
}

#[test]
fn every_operation_has_identical_authentication_and_authorization() {
    for definition in REGISTRY {
        let fields = args(definition.operation);
        assert_eq!(
            parity(
                &Fixture::default(),
                None,
                definition.operation,
                fields.clone()
            ),
            Err(Failure::new(ErrorCode::Unauthenticated))
        );
        let denied = Fixture {
            denied: true,
            ..Fixture::default()
        };
        assert_eq!(
            parity(&denied, Some(&scope("a")), definition.operation, fields),
            Err(Failure::new(ErrorCode::Denied))
        );
    }
}

#[test]
fn unsupported_and_unknown_fields_fail_before_hooks_or_effects() {
    for transport in TRANSPORTS {
        for field in [
            "tenant",
            "principal",
            "skip_integrity",
            "decryption_key",
            "base64_body",
            "retention",
            "provider",
            "ignore_quota",
        ] {
            let mut fixture = Fixture::default();
            let mut fields = args(Operation::Restore);
            fields.push(text(field, "forbidden"));
            assert_eq!(
                call(
                    transport,
                    &mut fixture,
                    Some(&scope("a")),
                    Operation::Restore,
                    fields
                ),
                Err(Failure::new(ErrorCode::InvalidInput))
            );
            assert!(fixture.trace.is_empty());
            assert_eq!(fixture.effects, 0);
        }
        let mut fixture = Fixture::default();
        assert_eq!(
            call(
                transport,
                &mut fixture,
                Some(&scope("a")),
                Operation::Versions,
                args(Operation::Versions)
            ),
            Err(Failure::new(ErrorCode::Unsupported))
        );
        assert_eq!(fixture.trace, ["authorize"]);
    }
    let mut fixture = Fixture::default();
    assert_eq!(
        dispatch(
            &mut fixture,
            Some(&scope("a")),
            2,
            Operation::Stat,
            args(Operation::Stat)
        ),
        Err(Failure::new(ErrorCode::Unsupported))
    );
    assert!(fixture.trace.is_empty());
    assert_eq!(
        rest_call(
            &mut fixture,
            Some(&scope("a")),
            "POST",
            "/v2/operations/stat",
            vec![]
        )
        .outcome,
        Err(Failure::new(ErrorCode::Unsupported))
    );
    assert_eq!(
        mcp_call(
            &mut fixture,
            Some(&scope("a")),
            McpSession::default(),
            TaskMode::Baseline,
            "global_lookup",
            vec![]
        )
        .outcome,
        Err(Failure::new(ErrorCode::Unsupported))
    );
}

#[test]
fn bounded_shapes_and_destination_fences_are_identical() {
    let mut cases = vec![
        vec![text("parent", "root"), num("limit", 0)],
        vec![text("parent", "root"), num("limit", MAX_PAGE_SIZE + 1)],
        vec![text("parent", "root"), num("limit", 1), num("limit", 1)],
        vec![text("parent", ""), num("limit", 1)],
        vec![text("parent", "unicode_é"), num("limit", 1)],
        vec![text("parent", "../../escape"), num("limit", 1)],
        vec![
            text("parent", &"x".repeat(MAX_TOKEN_BYTES + 1)),
            num("limit", 1),
        ],
        vec![text("parent", "root"), text("limit", "1")],
    ];
    cases.push(
        (0..MAX_FIELDS + 1)
            .map(|_| text("parent", "root"))
            .collect(),
    );
    for fields in cases {
        assert_eq!(
            parity(
                &Fixture::default(),
                Some(&scope("a")),
                Operation::Browse,
                fields
            ),
            Err(Failure::new(ErrorCode::InvalidInput))
        );
    }
    for op in [Operation::InitiateUpload, Operation::Copy] {
        let mut no_fence = args(op);
        no_fence.retain(|(name, _)| name != "if_absent");
        assert_eq!(
            parity(&Fixture::default(), Some(&scope("a")), op, no_fence),
            Err(Failure::new(ErrorCode::InvalidInput))
        );
        let mut both = args(op);
        both.push(text("generation", "g1"));
        assert_eq!(
            parity(&Fixture::default(), Some(&scope("a")), op, both),
            Err(Failure::new(ErrorCode::InvalidInput))
        );
    }
}

#[test]
fn preconditions_precede_resource_policy_and_effects() {
    let mut fields = args(Operation::Delete);
    fields.retain(|(key, _)| key != "generation");
    fields.push(text("generation", "stale"));
    let fixture = Fixture {
        quota: true,
        ..Fixture::default()
    };
    assert_eq!(
        parity(&fixture, Some(&scope("a")), Operation::Delete, fields),
        Err(Failure::new(ErrorCode::PreconditionFailed))
    );
    for transport in TRANSPORTS {
        let mut fixture = fixture.clone();
        assert_eq!(
            call(
                transport,
                &mut fixture,
                Some(&scope("a")),
                Operation::Delete,
                args(Operation::Delete)
            ),
            Err(Failure::new(ErrorCode::QuotaExceeded))
        );
        assert_eq!(fixture.trace, ["authorize", "preconditions", "admit"]);
        assert_eq!(fixture.effects, 0);
    }
}

#[test]
fn errors_are_sanitized_and_preserve_uncertain_effects() {
    for code in [
        ErrorCode::IntegrityFailed,
        ErrorCode::Unavailable,
        ErrorCode::Internal,
        ErrorCode::Conflict,
    ] {
        let failure = Failure {
            code,
            effects: Effects::Unknown,
        };
        let fixture = Fixture {
            injected: Some(failure),
            ..Fixture::default()
        };
        let error = parity(
            &fixture,
            Some(&scope("a")),
            Operation::Restore,
            args(Operation::Restore),
        )
        .unwrap_err();
        assert_eq!(error, failure);
        assert!(error.reconciliation_required());
        assert!(!error.message().contains("object"));
        assert!(!error.retryable());
    }
    assert_eq!(
        format!("{:?}", id("sensitive_locator")),
        "Opaque([redacted])"
    );
    let mut fixture = Fixture {
        denied: true,
        ..Fixture::default()
    };
    assert_eq!(
        rest_call(
            &mut fixture,
            Some(&scope("a")),
            "POST",
            "/v1/operations/stat",
            args(Operation::Stat)
        )
        .status,
        403
    );
    assert!(
        mcp_call(
            &mut fixture,
            Some(&scope("a")),
            McpSession::default(),
            TaskMode::Baseline,
            "stat",
            args(Operation::Stat)
        )
        .is_error
    );
}

#[test]
fn retry_classification_requires_no_effects_across_transports() {
    for code in [
        ErrorCode::Unauthenticated,
        ErrorCode::Denied,
        ErrorCode::InvalidInput,
        ErrorCode::Unsupported,
        ErrorCode::PreconditionFailed,
        ErrorCode::Conflict,
        ErrorCode::QuotaExceeded,
        ErrorCode::InvalidCursor,
        ErrorCode::NotAvailable,
        ErrorCode::NotReady,
        ErrorCode::Cancelled,
        ErrorCode::IntegrityFailed,
        ErrorCode::Unavailable,
        ErrorCode::Internal,
    ] {
        for effects in [
            Effects::None,
            Effects::Accepted,
            Effects::Committed,
            Effects::Unknown,
        ] {
            let failure = Failure { code, effects };
            let fixture = Fixture {
                injected: Some(failure),
                ..Fixture::default()
            };
            let error = parity(
                &fixture,
                Some(&scope("a")),
                Operation::Restore,
                args(Operation::Restore),
            )
            .unwrap_err();
            assert_eq!(error, failure);
            assert_eq!(error.reconciliation_required(), effects != Effects::None);
            assert_eq!(
                error.retryable(),
                effects == Effects::None
                    && matches!(code, ErrorCode::Unavailable | ErrorCode::QuotaExceeded),
                "{code:?}/{effects:?}"
            );
            assert!(!(error.retryable() && error.reconciliation_required()));
        }
    }
}

#[test]
fn upload_commit_obeys_job_transition_policy() {
    assert!(!JobState::Queued.permits(JobState::Succeeded));
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let Output::Upload { job, .. } = call(
            transport,
            &mut fixture,
            Some(&scope("a")),
            Operation::InitiateUpload,
            args(Operation::InitiateUpload),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(job.state, JobState::Queued);
        let Output::Job(committed) = call(
            transport,
            &mut fixture,
            Some(&scope("a")),
            Operation::CommitUpload,
            args(Operation::CommitUpload),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(committed.handle, job.handle);
        assert_eq!(committed.state, JobState::Succeeded);
        assert_eq!(committed.effects, Effects::Committed);
        assert_eq!(
            fixture.transitions,
            [
                (JobState::Queued, JobState::Running),
                (JobState::Running, JobState::Succeeded),
            ]
        );
    }
}

#[test]
fn upload_disconnect_reconciliation_commit_abort_and_generation_are_shared() {
    for transport in TRANSPORTS {
        let other = match transport {
            Transport::Rest => Transport::Mcp,
            Transport::Mcp => Transport::Rest,
        };
        let mut fixture = Fixture::default();
        let first = call(
            transport,
            &mut fixture,
            Some(&scope("a")),
            Operation::InitiateUpload,
            args(Operation::InitiateUpload),
        )
        .unwrap();
        // A lost response/disconnected caller changes no state. The other
        // transport reconciles the exact same request through the same authority.
        let mut recovered = fixture.clone();
        assert_eq!(
            call(
                other,
                &mut recovered,
                Some(&scope("a")),
                Operation::InitiateUpload,
                args(Operation::InitiateUpload)
            )
            .unwrap(),
            first
        );
        assert_eq!(recovered.effects, 1);
        let committed = call(
            other,
            &mut recovered,
            Some(&scope("a")),
            Operation::CommitUpload,
            args(Operation::CommitUpload),
        )
        .unwrap();
        assert_eq!(
            call(
                transport,
                &mut recovered,
                Some(&scope("a")),
                Operation::CommitUpload,
                args(Operation::CommitUpload)
            )
            .unwrap(),
            committed
        );
        assert_eq!(recovered.effects, 2);
        let Output::Cancel { outcome, .. } = call(
            transport,
            &mut recovered,
            Some(&scope("a")),
            Operation::AbortUpload,
            args(Operation::AbortUpload),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(outcome, CancelOutcome::AlreadyCommitted);
        assert!(recovered.objects.contains_key(&(id("a"), id("new"))));
        let Output::Stat(entry) = call(
            other,
            &mut recovered,
            Some(&scope("a")),
            Operation::Stat,
            vec![text("reference", "new"), text("generation", "g2")],
        )
        .unwrap() else {
            panic!()
        };
        assert!(!entry.available, "upload never grants a restore lease");
        let Output::Cancel { outcome, .. } = call(
            other,
            &mut fixture,
            Some(&scope("a")),
            Operation::AbortUpload,
            args(Operation::AbortUpload),
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(outcome, CancelOutcome::StoppedBeforeCommit);
        assert_eq!(
            call(
                transport,
                &mut fixture,
                Some(&scope("a")),
                Operation::CommitUpload,
                args(Operation::CommitUpload)
            ),
            Err(Failure::new(ErrorCode::Conflict))
        );
        assert!(!fixture.objects.contains_key(&(id("a"), id("new"))));
    }
}

#[test]
fn reconciliation_binds_full_input_scope_and_operation() {
    let mut fixture = Fixture::default();
    let a = scope("a");
    call(
        Transport::Rest,
        &mut fixture,
        Some(&a),
        Operation::InitiateUpload,
        args(Operation::InitiateUpload),
    )
    .unwrap();
    let mut changed = args(Operation::InitiateUpload);
    changed.retain(|(k, _)| k != "max_bytes");
    changed.push(num("max_bytes", 65));
    assert_eq!(
        parity(&fixture, Some(&a), Operation::InitiateUpload, changed),
        Err(Failure::new(ErrorCode::Conflict))
    );
    let request = Operation::InitiateUpload
        .definition()
        .validate(args(Operation::InitiateUpload))
        .unwrap();
    assert_ne!(
        request.reconciliation(&a),
        request.reconciliation(&scope("b"))
    );
    let other = Operation::Copy
        .definition()
        .validate(vec![
            text("source", "object"),
            text("source_generation", "g1"),
            text("reference", "new"),
            ("if_absent".into(), Value::Flag(true)),
            text("identity", "init"),
        ])
        .unwrap();
    assert_ne!(request.reconciliation(&a), other.reconciliation(&a));
    // Revocation defeats replay: accepted work isn't an enduring ACL bypass.
    fixture.denied = true;
    assert_eq!(
        parity(
            &fixture,
            Some(&a),
            Operation::InitiateUpload,
            args(Operation::InitiateUpload)
        ),
        Err(Failure::new(ErrorCode::Denied))
    );
}

#[test]
fn status_result_and_cancel_survive_transport_switch_without_rollback_claims() {
    let mut fixture = Fixture::default();
    let a = scope("a");
    assert_eq!(
        parity(
            &fixture,
            Some(&a),
            Operation::Result,
            args(Operation::Result)
        ),
        Err(Failure::new(ErrorCode::NotReady))
    );
    let Output::Cancel { job, outcome } = call(
        Transport::Rest,
        &mut fixture,
        Some(&a),
        Operation::Cancel,
        args(Operation::Cancel),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(outcome, CancelOutcome::Requested);
    assert_eq!(job.state, JobState::CancelRequested);
    let Output::Job(status) = call(
        Transport::Mcp,
        &mut fixture,
        Some(&a),
        Operation::Status,
        args(Operation::Status),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(status, job);
    // Best-effort cancellation loses a publication race honestly.
    fixture.complete(&a, "restorejob");
    let Output::Result { job, .. } = parity(
        &fixture,
        Some(&a),
        Operation::Result,
        args(Operation::Result),
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(job.state, JobState::Succeeded);
    let fields = vec![text("job", "restorejob"), text("identity", "cancel_again")];
    let Output::Cancel { outcome, .. } =
        parity(&fixture, Some(&a), Operation::Cancel, fields).unwrap()
    else {
        panic!()
    };
    assert_eq!(outcome, CancelOutcome::AlreadyCommitted);
}

#[test]
fn cross_tenant_reference_job_transfer_and_copy_do_not_disclose() {
    let mut fixture = Fixture::default();
    call(
        Transport::Rest,
        &mut fixture,
        Some(&scope("a")),
        Operation::InitiateUpload,
        args(Operation::InitiateUpload),
    )
    .unwrap();
    for op in [
        Operation::Stat,
        Operation::AuthorizeDownload,
        Operation::Restore,
        Operation::Delete,
        Operation::Copy,
        Operation::Status,
        Operation::Result,
        Operation::Cancel,
        Operation::CommitUpload,
        Operation::AbortUpload,
    ] {
        assert_eq!(
            parity(&fixture, Some(&scope("b")), op, args(op)),
            Err(Failure::new(ErrorCode::Denied))
        );
    }
    let mut absent = args(Operation::Status);
    absent[0] = text("job", "absent");
    assert_eq!(
        parity(&fixture, Some(&scope("b")), Operation::Status, absent),
        Err(Failure::new(ErrorCode::Denied))
    );
    let Output::Page { entries, .. } = parity(
        &fixture,
        Some(&scope("b")),
        Operation::Browse,
        args(Operation::Browse),
    )
    .unwrap() else {
        panic!()
    };
    assert!(entries.is_empty());
    // Same tenant, other principal still cannot use somebody else's job handle.
    let other_principal = Scope {
        tenant: id("a"),
        principal: id("other"),
    };
    assert_eq!(
        parity(
            &fixture,
            Some(&other_principal),
            Operation::Status,
            args(Operation::Status)
        ),
        Err(Failure::new(ErrorCode::Denied))
    );
}

#[test]
fn cursor_is_opaque_and_bound_to_scope_operation_query_and_page_limit() {
    let mut fixture = Fixture::default();
    let a = scope("a");
    let Output::Page {
        entries,
        cursor: Some(cursor),
    } = call(
        Transport::Rest,
        &mut fixture,
        Some(&a),
        Operation::Browse,
        args(Operation::Browse),
    )
    .unwrap()
    else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
    let mut fields = args(Operation::Browse);
    fields.push(text("cursor", cursor.as_str()));
    let Output::Page { entries, .. } =
        parity(&fixture, Some(&a), Operation::Browse, fields.clone()).unwrap()
    else {
        panic!()
    };
    assert!(entries.is_empty());
    assert_eq!(
        parity(
            &fixture,
            Some(&scope("b")),
            Operation::Browse,
            fields.clone()
        ),
        Err(Failure::new(ErrorCode::InvalidCursor))
    );
    for name in ["parent", "limit"] {
        let mut changed = fields.clone();
        changed.retain(|(k, _)| k != name);
        changed.push(if name == "parent" {
            text(name, "another")
        } else {
            num(name, 2)
        });
        assert_eq!(
            parity(&fixture, Some(&a), Operation::Browse, changed),
            Err(Failure::new(ErrorCode::InvalidCursor))
        );
    }
    // Forge a syntactically valid cursor whose authority receipt names another op.
    let foreign_query = Operation::Stat
        .definition()
        .validate(args(Operation::Stat))
        .unwrap();
    fixture.cursors.get_mut(&cursor).unwrap().1 = foreign_query;
    assert_eq!(
        parity(&fixture, Some(&a), Operation::Browse, fields.clone()),
        Err(Failure::new(ErrorCode::InvalidCursor))
    );
    fixture.cursors.clear();
    assert_eq!(
        parity(&fixture, Some(&a), Operation::Browse, fields),
        Err(Failure::new(ErrorCode::InvalidCursor))
    );
}

#[test]
fn download_and_copy_require_logical_availability_not_physical_presence() {
    let mut fixture = Fixture::default();
    fixture
        .objects
        .get_mut(&(id("a"), id("object")))
        .unwrap()
        .available = false;
    for op in [Operation::AuthorizeDownload, Operation::Copy] {
        assert_eq!(
            parity(&fixture, Some(&scope("a")), op, args(op)),
            Err(Failure::new(ErrorCode::NotAvailable))
        );
    }
    assert!(matches!(
        parity(
            &fixture,
            Some(&scope("a")),
            Operation::Stat,
            args(Operation::Stat)
        ),
        Ok(Output::Stat(_))
    ));
    assert!(matches!(
        parity(
            &fixture,
            Some(&scope("a")),
            Operation::Restore,
            args(Operation::Restore)
        ),
        Ok(Output::Job(_))
    ));
    let fixture = Fixture::default();
    for op in [
        Operation::Copy,
        Operation::Delete,
        Operation::AuthorizeDownload,
    ] {
        parity(&fixture, Some(&scope("a")), op, args(op)).unwrap();
    }
}

#[test]
fn every_implemented_operation_has_success_and_quota_parity() {
    for definition in REGISTRY.iter().filter(|d| d.implemented) {
        let op = definition.operation;
        let mut fixture = Fixture::default();
        if matches!(op, Operation::CommitUpload | Operation::AbortUpload) {
            call(
                Transport::Rest,
                &mut fixture,
                Some(&scope("a")),
                Operation::InitiateUpload,
                args(Operation::InitiateUpload),
            )
            .unwrap();
        }
        if op == Operation::Result {
            fixture.complete(&scope("a"), "restorejob");
        }
        parity(&fixture, Some(&scope("a")), op, args(op)).unwrap();
        fixture.quota = true;
        assert_eq!(
            parity(&fixture, Some(&scope("a")), op, args(op)),
            Err(Failure::new(ErrorCode::QuotaExceeded))
        );
    }
}

struct InvalidOutput(Output);
impl OperationPort for InvalidOutput {
    fn authorize(&mut self, _: &Scope, _: &Request) -> Result<(), Failure> {
        Ok(())
    }
    fn preconditions(&mut self, _: &Scope, _: &Request) -> Result<(), Failure> {
        Ok(())
    }
    fn admit(&mut self, _: &Scope, _: &Request) -> Result<(), Failure> {
        Ok(())
    }
    fn resolve_cursor(&mut self, _: &Scope, _: &Request, _: &Opaque) -> Result<Opaque, Failure> {
        Err(Failure::new(ErrorCode::InvalidCursor))
    }
    fn execute(&mut self, _: &Scope, _: &Request, _: Option<&Opaque>) -> Result<Output, Failure> {
        Ok(self.0.clone())
    }
}

#[test]
fn wrong_output_shapes_targets_and_page_bounds_fail_closed() {
    let entry = Entry {
        target: target("other", "g1"),
        bytes: 1,
        available: true,
    };
    let cases = [
        (
            Operation::Stat,
            Output::Page {
                entries: vec![],
                cursor: None,
            },
        ),
        (Operation::Stat, Output::Stat(entry.clone())),
        (
            Operation::Browse,
            Output::Page {
                entries: vec![entry.clone(), entry],
                cursor: None,
            },
        ),
    ];
    for (op, output) in cases {
        let expected = Err(Failure {
            code: ErrorCode::Internal,
            effects: Effects::Unknown,
        });
        assert_eq!(
            rest_call(
                &mut InvalidOutput(output.clone()),
                Some(&scope("a")),
                "POST",
                &format!("/v1/operations/{}", op.definition().name),
                args(op)
            )
            .outcome,
            expected
        );
        assert_eq!(
            mcp_call(
                &mut InvalidOutput(output),
                Some(&scope("a")),
                McpSession::default(),
                TaskMode::Baseline,
                op.definition().name,
                args(op)
            )
            .outcome,
            expected
        );
    }
}

fn initiate_at(
    transport: Transport,
    fixture: &mut Fixture,
    owner: &Scope,
    reference: &str,
    identity: &str,
    generation: Option<&str>,
) -> (Transfer, Job) {
    let mut fields = vec![
        text("reference", reference),
        text("identity", identity),
        num("max_bytes", 64),
    ];
    fields.push(match generation {
        Some(generation) => text("generation", generation),
        None => ("if_absent".into(), Value::Flag(true)),
    });
    let Output::Upload { transfer, job } = call(
        transport,
        fixture,
        Some(owner),
        Operation::InitiateUpload,
        fields,
    )
    .unwrap() else {
        panic!()
    };
    (transfer, job)
}

fn finish_upload(transfer: &Transfer, identity: &str) -> Fields {
    vec![
        text("transfer", transfer.handle.as_str()),
        text("reference", transfer.target.reference.as_str()),
        text("generation", transfer.target.generation.as_str()),
        text("identity", identity),
    ]
}

#[test]
fn competing_uploads_recheck_destination_fences_and_cannot_republish() {
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let a = scope("a");
        let other = Scope {
            tenant: id("a"),
            principal: id("other"),
        };
        let (first, _) = initiate_at(transport, &mut fixture, &a, "new", "first", None);
        let (second, _) = initiate_at(transport, &mut fixture, &other, "new", "second", None);
        call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::CommitUpload,
            finish_upload(&first, "commit_first"),
        )
        .unwrap();
        assert_eq!(
            parity(
                &fixture,
                Some(&other),
                Operation::CommitUpload,
                finish_upload(&second, "commit_second")
            ),
            Err(Failure::new(ErrorCode::PreconditionFailed))
        );
        let committed = fixture.objects[&(id("a"), id("new"))].clone();
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::CommitUpload,
                finish_upload(&first, "fresh_identity")
            ),
            Err(Failure {
                code: ErrorCode::Conflict,
                effects: Effects::Committed
            })
        );
        assert_eq!(fixture.objects[&(id("a"), id("new"))], committed);
        let (replacement, _) = initiate_at(
            transport,
            &mut fixture,
            &a,
            "new",
            "replacement",
            Some(first.target.generation.as_str()),
        );
        fixture
            .objects
            .get_mut(&(id("a"), id("new")))
            .unwrap()
            .target
            .generation = id("successor");
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::CommitUpload,
                finish_upload(&replacement, "stale_replace")
            ),
            Err(Failure::new(ErrorCode::PreconditionFailed))
        );
    }
}

#[test]
fn replacement_allocates_a_fresh_generation_and_validator_rejects_reuse() {
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let a = scope("a");
        let (transfer, _) =
            initiate_at(transport, &mut fixture, &a, "object", "replace", Some("g1"));
        assert_ne!(transfer.target.generation, id("g1"));
        call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::CommitUpload,
            finish_upload(&transfer, "commit"),
        )
        .unwrap();
        assert_eq!(
            fixture.objects[&(id("a"), id("object"))].target,
            transfer.target
        );
        let fields = vec![
            text("reference", "object"),
            text("generation", "g1"),
            num("max_bytes", 64),
            text("identity", "replace"),
        ];
        let job = Job {
            handle: id("badjob"),
            target: target("object", "g1"),
            state: JobState::Queued,
            progress: Progress::new(ProgressUnit::Bytes, None),
            effects: Effects::Accepted,
            error: None,
        };
        let bad = Output::Upload {
            transfer: Transfer {
                handle: id("badtransfer"),
                target: job.target.clone(),
                direction: TransferDirection::Upload,
                expires_at: 1,
                max_bytes: 64,
            },
            job,
        };
        assert_eq!(
            dispatch(
                &mut InvalidOutput(bad),
                Some(&a),
                VERSION,
                Operation::InitiateUpload,
                fields
            ),
            Err(Failure {
                code: ErrorCode::Internal,
                effects: Effects::Unknown
            })
        );
    }
}

#[test]
fn independent_acceptances_never_rebind_existing_job_or_transfer_handles() {
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let a = scope("a");
        let (first, first_job) = initiate_at(transport, &mut fixture, &a, "first", "first", None);
        let (second, second_job) =
            initiate_at(transport, &mut fixture, &a, "second", "second", None);
        assert_ne!(first.handle, second.handle);
        assert_ne!(first_job.handle, second_job.handle);
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::Status,
                vec![text("job", first_job.handle.as_str())]
            )
            .unwrap(),
            Output::Job(first_job)
        );
        call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::CommitUpload,
            finish_upload(&first, "commit_first"),
        )
        .unwrap();
        call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::CommitUpload,
            finish_upload(&second, "commit_second"),
        )
        .unwrap();
        let mut handles = std::collections::BTreeSet::new();
        for op in [Operation::Restore, Operation::Copy, Operation::Delete] {
            let Output::Job(job) = call(transport, &mut fixture, Some(&a), op, args(op)).unwrap()
            else {
                panic!()
            };
            assert!(handles.insert(job.handle));
        }
    }
}

#[test]
fn issued_cursor_position_survives_continuation_retries_and_other_browsers() {
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let a = scope("a");
        for reference in ["second", "third"] {
            fixture.objects.insert(
                (id("a"), id(reference)),
                Entry {
                    target: target(reference, "g1"),
                    bytes: 1,
                    available: true,
                },
            );
            fixture
                .parents
                .get_mut(&(a.clone(), id("root")))
                .unwrap()
                .push(id(reference));
        }
        let Output::Page {
            cursor: Some(first),
            ..
        } = call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::Browse,
            args(Operation::Browse),
        )
        .unwrap()
        else {
            panic!()
        };
        let fields = vec![
            text("parent", "root"),
            num("limit", 1),
            text("cursor", first.as_str()),
        ];
        let Output::Page {
            entries: expected,
            cursor: Some(second),
        } = call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::Browse,
            fields.clone(),
        )
        .unwrap()
        else {
            panic!()
        };
        assert_ne!(first, second);
        call(
            transport,
            &mut fixture,
            Some(&scope("b")),
            Operation::Browse,
            args(Operation::Browse),
        )
        .unwrap();
        let Output::Page { entries, .. } =
            parity(&fixture, Some(&a), Operation::Browse, fields).unwrap()
        else {
            panic!()
        };
        assert_eq!(entries, expected);
        assert_eq!(entries[0].target.reference, id("second"));
    }
}

#[test]
fn browse_requires_authorized_parent_and_filters_its_members() {
    let mut fixture = Fixture::default();
    let a = scope("a");
    fixture.parents.insert((a.clone(), id("empty")), vec![]);
    fixture
        .parents
        .insert((a.clone(), id("restricted")), vec![id("object")]);
    for parent in ["missing", "private"] {
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::Browse,
                vec![text("parent", parent), num("limit", 1)]
            ),
            Err(Failure::new(ErrorCode::Denied))
        );
    }
    let Output::Page { entries, .. } = parity(
        &fixture,
        Some(&a),
        Operation::Browse,
        vec![text("parent", "empty"), num("limit", 1)],
    )
    .unwrap() else {
        panic!()
    };
    assert!(entries.is_empty());
    assert_eq!(
        parity(
            &fixture,
            Some(&scope("b")),
            Operation::Browse,
            vec![text("parent", "restricted"), num("limit", 1)]
        ),
        Err(Failure::new(ErrorCode::Denied))
    );
    let Output::Page { entries, .. } = parity(
        &fixture,
        Some(&a),
        Operation::Browse,
        vec![text("parent", "restricted"), num("limit", 1)],
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(entries.len(), 1);
}

#[test]
fn result_preserves_failed_and_cancelled_terminal_outcomes() {
    for transport in TRANSPORTS {
        let mut fixture = Fixture::default();
        let a = scope("a");
        let (transfer, job) = initiate_at(transport, &mut fixture, &a, "new", "init", None);
        call(
            transport,
            &mut fixture,
            Some(&a),
            Operation::AbortUpload,
            finish_upload(&transfer, "abort"),
        )
        .unwrap();
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::Result,
                vec![text("job", job.handle.as_str())]
            ),
            Err(Failure::new(ErrorCode::Cancelled))
        );
        let failure = Failure {
            code: ErrorCode::IntegrityFailed,
            effects: Effects::Unknown,
        };
        let failed = fixture
            .jobs
            .get_mut(&(a.clone(), id("restorejob")))
            .unwrap();
        failed.state = JobState::Failed;
        failed.error = Some(failure);
        failed.effects = failure.effects;
        assert_eq!(
            parity(
                &fixture,
                Some(&a),
                Operation::Result,
                args(Operation::Result)
            ),
            Err(failure)
        );
    }
}

#[test]
fn progress_is_monotonic_per_declared_unit_and_unknown_never_becomes_zero() {
    let mut unknown = Progress::new(ProgressUnit::Bytes, None);
    unknown.advance(9).unwrap();
    assert_eq!(unknown.total(), None);
    assert_eq!(unknown.unit(), ProgressUnit::Bytes);
    assert_eq!(unknown.advance(8), Err(Failure::new(ErrorCode::Conflict)));
    assert_eq!(unknown.completed(), 9);
    let mut known = Progress::new(ProgressUnit::Objects, Some(2));
    known.advance(2).unwrap();
    assert_eq!(known.advance(3), Err(Failure::new(ErrorCode::Conflict)));
    assert!(!JobState::Succeeded.permits(JobState::Running));
    assert!(!JobState::Cancelled.permits(JobState::Succeeded));
    assert!(JobState::CancelRequested.permits(JobState::Succeeded));
}

#[test]
fn experimental_mcp_tasks_are_not_silently_accepted_even_after_negotiation() {
    for negotiated in [false, true] {
        let mut fixture = Fixture::default();
        let response = mcp_call(
            &mut fixture,
            Some(&scope("a")),
            McpSession {
                experimental_tasks_negotiated: negotiated,
            },
            TaskMode::Experimental,
            "restore",
            args(Operation::Restore),
        );
        assert_eq!(response.outcome, Err(Failure::new(ErrorCode::Unsupported)));
        assert!(response.is_error);
        assert!(fixture.trace.is_empty());
    }
}
