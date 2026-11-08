use qerith_core::operations::*;
#[path = "operations/fixture.rs"]
mod fixture;
use fixture::*;

fn json(fields: Fields) -> Vec<u8> {
    let object: serde_json::Map<_, _> = fields
        .into_iter()
        .map(|(name, value)| {
            let value = match value {
                Value::Text(value) => serde_json::Value::String(value),
                Value::Number(value) => serde_json::Value::Number(value.into()),
                Value::Flag(value) => serde_json::Value::Bool(value),
            };
            (name, value)
        })
        .collect();
    serde_json::to_vec(&object).unwrap()
}

fn wire(
    fixture: &Fixture,
    scope: Option<&Scope>,
    operation: Operation,
    bytes: &[u8],
) -> (RestResponse, Fixture) {
    let mut rest = fixture.clone();
    let mut mcp = fixture.clone();
    let response = rest_request(
        &mut rest,
        scope,
        "POST",
        &format!("/v1/operations/{}", operation.definition().name),
        bytes,
    );
    let tool_response = mcp_request(
        &mut mcp,
        scope,
        McpSession::default(),
        TaskMode::Baseline,
        operation.definition().name,
        bytes,
    );
    assert_eq!(response.outcome, tool_response.outcome);
    assert_eq!(tool_response.is_error, response.outcome.is_err());
    assert_eq!(rest.trace, mcp.trace);
    assert_eq!(rest.effects, mcp.effects);
    assert_eq!(rest.jobs, mcp.jobs);
    assert_eq!(rest.uploads, mcp.uploads);
    assert_eq!(rest.objects, mcp.objects);
    (response, rest)
}

fn invalid(operation: Operation, bytes: &[u8]) {
    let (response, fixture) = wire(&Fixture::default(), Some(&scope("a")), operation, bytes);
    assert_eq!(response.status, 400);
    assert_eq!(response.outcome, Err(Failure::new(ErrorCode::InvalidInput)));
    assert!(fixture.trace.is_empty());
    assert_eq!(fixture.effects, 0);
    assert_eq!(fixture.sequence, 0);
    assert!(fixture.replay.is_empty());
}

#[test]
fn wire_success_matches_typed_calls_for_every_implemented_operation() {
    for definition in REGISTRY.iter().filter(|definition| definition.implemented) {
        let operation = definition.operation;
        let mut fixture = Fixture::default();
        if matches!(operation, Operation::CommitUpload | Operation::AbortUpload) {
            rest_call(
                &mut fixture,
                Some(&scope("a")),
                "POST",
                "/v1/operations/upload_initiate",
                args(Operation::InitiateUpload),
            )
            .outcome
            .unwrap();
            fixture.trace.clear();
        }
        if operation == Operation::Result {
            fixture.complete(&scope("a"), "restorejob");
        }
        let (response, actual) = wire(
            &fixture,
            Some(&scope("a")),
            operation,
            &json(args(operation)),
        );
        let expected = rest_call(
            &mut fixture,
            Some(&scope("a")),
            "POST",
            &format!("/v1/operations/{}", definition.name),
            args(operation),
        );
        assert!(response.outcome.is_ok(), "{}", definition.name);
        assert_eq!(response, expected);
        assert_eq!(actual.trace, fixture.trace);
        assert_eq!(actual.effects, fixture.effects);
        assert_eq!(actual.replay, fixture.replay);
    }
}

#[test]
fn malformed_objects_and_non_scalar_values_never_enter_the_port() {
    for bytes in [
        b"".as_slice(),
        b" ",
        b"null",
        b"true",
        b"0",
        b"\"text\"",
        b"[]",
        b"[{}]",
        b"{",
        b"{}{}",
        b"{} trailing",
        b"{\"reference\":\"new\",}",
        b"{\"reference\":null}",
        b"{\"reference\":{}}",
        b"{\"reference\":[]}",
        b"{\"reference\":[1,2,3]}",
        b"{\"reference\":\"\xff\"}",
        b"{\"reference\":\"\\uD800\"}",
    ] {
        invalid(Operation::InitiateUpload, bytes);
    }
    let deep = format!(
        "{{\"reference\":{}0{}}}",
        "[".repeat(1000),
        "]".repeat(1000)
    );
    invalid(Operation::InitiateUpload, deep.as_bytes());
}

#[test]
fn duplicates_unknown_fields_and_inline_payloads_are_rejected() {
    for bytes in [
        br#"{"reference":"new","reference":"other","if_absent":true,"max_bytes":1,"identity":"init"}"#.as_slice(),
        br#"{"reference":"new","ref\u0065rence":"new","if_absent":true,"max_bytes":1,"identity":"init"}"#,
        br#"{"reference":"new","if_absent":true,"if_absent":true,"max_bytes":1,"identity":"init"}"#,
        br#"{"reference":"new","if_absent":true,"max_bytes":1,"max_bytes":1,"identity":"init"}"#,
    ] {
        invalid(Operation::InitiateUpload, bytes);
    }
    for name in [
        "scope",
        "tenant",
        "principal",
        "session",
        "experimental_tasks_negotiated",
        "body",
        "bytes",
        "key",
        "decryption_key",
        "base64_body",
        "provider",
        "skip_integrity",
        "ignore_quota",
    ] {
        let mut fields = args(Operation::InitiateUpload);
        fields.push(text(name, "c2VjcmV0"));
        invalid(Operation::InitiateUpload, &json(fields));
    }
    let fields = (0..MAX_FIELDS + 1)
        .map(|n| text(&format!("field{n}"), "x"))
        .collect();
    invalid(Operation::InitiateUpload, &json(fields));
    invalid(
        Operation::InitiateUpload,
        &json(vec![text(&"x".repeat(MAX_MESSAGE_BYTES / 2), "x")]),
    );
}

#[test]
fn unsigned_integers_are_exact_and_signed_float_and_overflow_forms_fail() {
    for number in ["0", "9007199254740993", "18446744073709551615"] {
        let bytes = format!(
            r#"{{"reference":"new","if_absent":true,"max_bytes":{number},"identity":"init"}}"#
        );
        let (response, fixture) = wire(
            &Fixture::default(),
            Some(&scope("a")),
            Operation::InitiateUpload,
            bytes.as_bytes(),
        );
        let Output::Upload { transfer, .. } = response.outcome.unwrap() else {
            panic!()
        };
        assert_eq!(response.status, 201);
        assert_eq!(transfer.max_bytes, number.parse::<u64>().unwrap());
        assert_eq!(fixture.effects, 1);
    }
    for number in [
        "-0",
        "-1",
        "+1",
        "1.0",
        "1e0",
        "1E3",
        "18446744073709551616",
        "1e400",
        "01",
        "NaN",
        "Infinity",
        "true",
        "\"1\"",
    ] {
        let bytes = format!(
            r#"{{"reference":"new","if_absent":true,"max_bytes":{number},"identity":"init"}}"#
        );
        invalid(Operation::InitiateUpload, bytes.as_bytes());
    }
}

#[test]
fn registry_validation_still_owns_token_bounds_ranges_and_fences() {
    for value in ["", "unicode_é", "../escape", "YWJjZA==", "a\u{0000}b"] {
        let mut fields = args(Operation::InitiateUpload);
        fields.retain(|(name, _)| name != "reference");
        fields.push(text("reference", value));
        invalid(Operation::InitiateUpload, &json(fields));
    }
    for length in [MAX_TOKEN_BYTES, MAX_TOKEN_BYTES + 1] {
        let bytes = json(vec![text("parent", &"x".repeat(length)), num("limit", 1)]);
        let (response, fixture) = wire(
            &Fixture::default(),
            Some(&scope("a")),
            Operation::Browse,
            &bytes,
        );
        if length == MAX_TOKEN_BYTES {
            assert_eq!(response.outcome, Err(Failure::new(ErrorCode::Denied)));
            assert_eq!(fixture.trace, ["authorize"]);
        } else {
            invalid(Operation::Browse, &bytes);
        }
    }
    for fields in [
        vec![],
        vec![
            text("reference", "new"),
            num("max_bytes", 1),
            text("identity", "init"),
        ],
        vec![
            text("reference", "new"),
            text("generation", "g1"),
            ("if_absent".into(), Value::Flag(true)),
            num("max_bytes", 1),
            text("identity", "init"),
        ],
        vec![
            text("reference", "new"),
            ("if_absent".into(), Value::Flag(false)),
            num("max_bytes", 1),
            text("identity", "init"),
        ],
    ] {
        invalid(Operation::InitiateUpload, &json(fields));
    }
    for limit in [0, MAX_PAGE_SIZE + 1] {
        invalid(
            Operation::Browse,
            &json(vec![text("parent", "root"), num("limit", limit)]),
        );
    }
    let escaped = br#"{"ref\u0065rence":"obj\u0065ct","generation":"g1"}"#;
    let (response, fixture) = wire(
        &Fixture::default(),
        Some(&scope("a")),
        Operation::Stat,
        escaped,
    );
    assert!(response.outcome.is_ok());
    assert_eq!(fixture.effects, 0);
}

#[test]
fn raw_byte_budget_includes_whitespace_and_trailing_bytes() {
    assert_eq!(MAX_MESSAGE_BYTES, 65_536);
    let mut bytes = b"{}".to_vec();
    bytes.resize(MAX_MESSAGE_BYTES, b' ');
    let (response, fixture) = wire(
        &Fixture::default(),
        Some(&scope("a")),
        Operation::Capabilities,
        &bytes,
    );
    assert_eq!(response.status, 200);
    assert!(response.outcome.is_ok());
    assert_eq!(fixture.trace, ["authorize", "preconditions", "admit"]);
    assert_eq!(fixture.effects, 0);
    bytes.push(b' ');
    invalid(Operation::Capabilities, &bytes);
    let huge = vec![b'x'; MAX_MESSAGE_BYTES + 1];
    invalid(Operation::InitiateUpload, &huge);
}

#[test]
fn authentication_route_and_task_precedence_match_the_existing_projections() {
    for bytes in [b"{".as_slice(), b"{}", &vec![b'x'; MAX_MESSAGE_BYTES + 1]] {
        let (response, fixture) = wire(&Fixture::default(), None, Operation::Stat, bytes);
        assert_eq!(response.status, 401);
        assert_eq!(
            response.outcome,
            Err(Failure::new(ErrorCode::Unauthenticated))
        );
        assert!(fixture.trace.is_empty());
        assert_eq!(fixture.effects, 0);
        let mut fixture = Fixture::default();
        for (method, path) in [
            ("GET", "/v1/operations/stat"),
            ("POST", "/v2/operations/stat"),
            ("POST", "/v1/operations/unknown"),
        ] {
            let response = rest_request(&mut fixture, Some(&scope("a")), method, path, bytes);
            assert_eq!(response.status, 501);
            assert_eq!(response.outcome, Err(Failure::new(ErrorCode::Unsupported)));
        }
        for negotiated in [false, true] {
            for (mode, tool) in [
                (TaskMode::Baseline, "unknown"),
                (TaskMode::Experimental, "restore"),
            ] {
                let response = mcp_request(
                    &mut fixture,
                    Some(&scope("a")),
                    McpSession {
                        experimental_tasks_negotiated: negotiated,
                    },
                    mode,
                    tool,
                    bytes,
                );
                assert!(response.is_error);
                assert_eq!(response.outcome, Err(Failure::new(ErrorCode::Unsupported)));
            }
        }
        assert!(fixture.trace.is_empty());
        assert_eq!(fixture.effects, 0);
    }
    let (response, fixture) = wire(
        &Fixture::default(),
        Some(&scope("a")),
        Operation::Versions,
        &json(args(Operation::Versions)),
    );
    assert_eq!(response.status, 501);
    assert_eq!(fixture.trace, ["authorize"]);
    assert_eq!(fixture.effects, 0);
}

#[test]
fn domain_failures_preserve_projection_status_effects_and_sanitized_messages() {
    for (code, status) in [
        (ErrorCode::Unauthenticated, 401),
        (ErrorCode::Denied, 403),
        (ErrorCode::InvalidInput, 400),
        (ErrorCode::InvalidCursor, 400),
        (ErrorCode::Unsupported, 501),
        (ErrorCode::PreconditionFailed, 412),
        (ErrorCode::Conflict, 409),
        (ErrorCode::NotReady, 409),
        (ErrorCode::Cancelled, 409),
        (ErrorCode::NotAvailable, 403),
        (ErrorCode::QuotaExceeded, 429),
        (ErrorCode::Unavailable, 503),
        (ErrorCode::IntegrityFailed, 500),
        (ErrorCode::Internal, 500),
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
            let (response, fixture) = wire(
                &fixture,
                Some(&scope("a")),
                Operation::Restore,
                &json(args(Operation::Restore)),
            );
            assert_eq!(response.status, status);
            assert_eq!(response.outcome, Err(failure));
            assert_eq!(response.outcome.unwrap_err().message(), failure.message());
            assert_eq!(
                fixture.trace,
                ["authorize", "preconditions", "admit", "execute"]
            );
            assert_eq!(fixture.effects, 0);
        }
    }
}

#[test]
fn caller_scope_and_shared_authority_control_mutations_and_replay() {
    let fields = args(Operation::InitiateUpload);
    let (response, fixture) = wire(
        &Fixture::default(),
        Some(&scope("a")),
        Operation::InitiateUpload,
        &json(fields.clone()),
    );
    assert_eq!(fixture.effects, 1);
    let (replay, mut fixture) = wire(
        &fixture,
        Some(&scope("a")),
        Operation::InitiateUpload,
        &json(fields),
    );
    assert_eq!(replay, response);
    assert_eq!(fixture.effects, 1);
    fixture.denied = true;
    let (denied, denied_fixture) = wire(
        &fixture,
        Some(&scope("a")),
        Operation::InitiateUpload,
        &json(args(Operation::InitiateUpload)),
    );
    assert_eq!(denied.status, 403);
    assert_eq!(denied_fixture.effects, 1);
    for owner in [
        scope("b"),
        Scope {
            tenant: id("a"),
            principal: id("other"),
        },
    ] {
        let (response, fixture) = wire(
            &Fixture::default(),
            Some(&owner),
            Operation::Status,
            &json(args(Operation::Status)),
        );
        assert_eq!(response.outcome, Err(Failure::new(ErrorCode::Denied)));
        assert_eq!(fixture.trace, ["authorize"]);
        assert_eq!(fixture.effects, 0);
    }
}
