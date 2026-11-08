use qerith_core::native::*;
use serde::Deserialize;
use serde_json::Value;

const NOW: u64 = 1000;

fn id(s: &str) -> Opaque {
    s.to_owned().try_into().unwrap()
}

#[derive(Deserialize)]
struct Golden {
    valid: Vec<Valid>,
    invalid: Vec<Invalid>,
    invalid_response_mutations: Vec<InvalidResponse>,
}

#[derive(Deserialize)]
struct InvalidResponse {
    case: String,
    pointer: String,
    value: Value,
    error: ErrorCode,
}

#[derive(Deserialize)]
struct Valid {
    name: String,
    request: Value,
    response: Value,
}

#[derive(Deserialize)]
struct Invalid {
    name: String,
    request: Value,
    error: ErrorCode,
}

fn golden() -> Golden {
    serde_json::from_str(include_str!("fixtures/native-v1.json")).unwrap()
}

#[derive(Clone)]
struct MemoryAuthority {
    owner: Owner,
    selection: Selection,
    upload: UploadRecord,
    object: Object,
    current: Option<Opaque>,
    cursor: CursorRecord,
    job: JobStatus,
    replay: Option<(Opaque, Action)>,
}

impl MemoryAuthority {
    fn new() -> Self {
        let fixtures = golden();
        let request: Request = serde_json::from_value(fixtures.valid[1].request.clone()).unwrap();
        let Action::InitiateUpload(intent) = request.action else {
            panic!()
        };
        let response: Response =
            serde_json::from_value(fixtures.valid[0].response.clone()).unwrap();
        let ResponseBody::Capabilities(selection) = response.body else {
            panic!()
        };
        let response: Response =
            serde_json::from_value(fixtures.valid[3].response.clone()).unwrap();
        let ResponseBody::Committed(object) = response.body else {
            panic!()
        };
        Self {
            owner: Owner {
                scope: id("tenant-a"),
                principal: id("principal-a"),
            },
            selection,
            upload: UploadRecord {
                intent,
                received_bytes: 10,
                integrity_verified: true,
                expires_at: 2000,
                committed: false,
            },
            object,
            current: None,
            cursor: CursorRecord {
                container: id("container-1"),
                page_entries: 2,
                expires_at: 2000,
            },
            job: JobStatus {
                job: id("job-1"),
                target: Target {
                    object: id("object-1"),
                    g: id("generation-1"),
                },
                kind: JobKind::Restore,
                state: JobState::Queued,
                completed_bytes: 0,
                total_bytes: None,
                outcome: None,
            },
            replay: None,
        }
    }

    fn owned<T>(&self, value: T) -> Owned<T> {
        Owned {
            owner: self.owner.clone(),
            value,
        }
    }
}

impl Authority for MemoryAuthority {
    fn session(&self, value: &Opaque) -> Option<Owned<SessionRecord>> {
        (value == &self.selection.session).then(|| {
            self.owned(SessionRecord {
                selection: self.selection.clone(),
                expires_at: 2000,
            })
        })
    }
    fn key_envelope(&self, key: &Opaque, envelope: &Opaque) -> Option<Owned<()>> {
        (key == &id("key-ref-1") && envelope == &id("envelope-ref-1")).then(|| self.owned(()))
    }
    fn transfer(&self, value: &Opaque) -> Option<Owned<TransferHandle>> {
        (value == &id("transfer-1")).then(|| {
            self.owned(TransferHandle {
                handle: value.clone(),
                object: self.object.clone(),
                range: Some(ByteRange { first: 2, last: 5 }),
                expires_at: 2000,
            })
        })
    }
    fn destination(&self, value: &Opaque) -> Option<Owned<Option<Opaque>>> {
        (value == &id("object-1")).then(|| self.owned(self.current.clone()))
    }
    fn object(&self, target: &Target) -> Option<Owned<Object>> {
        (target.object == self.object.target.object).then(|| self.owned(self.object.clone()))
    }
    fn upload(&self, value: &Opaque) -> Option<Owned<UploadRecord>> {
        (value == &id("upload-1")).then(|| self.owned(self.upload.clone()))
    }
    fn container(&self, value: &Opaque) -> Option<Owned<()>> {
        (value == &id("container-1")).then(|| self.owned(()))
    }
    fn listed_object(&self, container: &Opaque, target: &Target) -> Option<Owned<Object>> {
        if container == &id("container-1") {
            self.object(target)
        } else {
            None
        }
    }
    fn cursor(&self, value: &Opaque) -> Option<Owned<CursorRecord>> {
        (value == &id("cursor-1")).then(|| self.owned(self.cursor.clone()))
    }
    fn job(&self, value: &Opaque) -> Option<Owned<JobStatus>> {
        (value == &self.job.job).then(|| self.owned(self.job.clone()))
    }
    fn replay(&self, _owner: &Owner, request: &Opaque) -> Option<Owned<ReplayRecord>> {
        self.replay
            .as_ref()
            .filter(|(key, _)| key == request)
            .map(|(_, action)| {
                self.owned(ReplayRecord {
                    action: action.clone(),
                })
            })
    }
}

fn policy() -> Policy {
    let memory = MemoryAuthority::new();
    Policy {
        profiles: vec![SupportedProfile {
            profile: memory.selection.profile,
            checksum_hex_chars: 4,
        }],
        limits: memory.selection.limits,
    }
}

fn request(name: &str) -> Request {
    let case = golden().valid.into_iter().find(|c| c.name == name).unwrap();
    decode_request(&serde_json::to_vec(&case.request).unwrap()).unwrap()
}

fn check(request: &Request, memory: &MemoryAuthority) -> Result<Admission, ErrorCode> {
    validate_request(request, &memory.owner, &policy(), memory, NOW)
}

#[test]
fn golden_requests_responses_round_trip_and_validate() {
    let memory = MemoryAuthority::new();
    for case in golden().valid {
        let request = decode_request(&serde_json::to_vec(&case.request).unwrap()).unwrap();
        let response = decode_response(&serde_json::to_vec(&case.response).unwrap()).unwrap();
        assert_eq!(
            check(&request, &memory),
            Ok(Admission::New),
            "{}",
            case.name
        );
        assert_eq!(
            validate_response(&request, &response, &memory.owner, &policy(), &memory, NOW),
            Ok(()),
            "{}",
            case.name
        );
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            case.request,
            "{}",
            case.name
        );
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            case.response,
            "{}",
            case.name
        );
    }
}

#[test]
fn invalid_golden_requests_fail_closed() {
    let memory = MemoryAuthority::new();
    for case in golden().invalid {
        let result = decode_request(&serde_json::to_vec(&case.request).unwrap())
            .and_then(|r| check(&r, &memory));
        assert_eq!(result, Err(case.error), "{}", case.name);
    }
}

#[test]
fn invalid_golden_responses_fail_closed() {
    let memory = MemoryAuthority::new();
    let fixtures = golden();
    for mutation in fixtures.invalid_response_mutations {
        let case = fixtures
            .valid
            .iter()
            .find(|c| c.name == mutation.case)
            .unwrap();
        let mut response = case.response.clone();
        *response.pointer_mut(&mutation.pointer).unwrap() = mutation.value;
        let req = request(&mutation.case);
        let result = decode_response(&serde_json::to_vec(&response).unwrap())
            .and_then(|r| validate_response(&req, &r, &memory.owner, &policy(), &memory, NOW));
        assert_eq!(
            result,
            Err(mutation.error),
            "{} {}",
            mutation.case,
            mutation.pointer
        );
    }
}

#[test]
fn transfer_redemption_rechecks_owner_generation_and_range() {
    let memory = MemoryAuthority::new();
    let req = request("download");
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &req,
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Ok(())
    );
    let mut changed = req.clone();
    let Action::Download(value) = &mut changed.action else {
        panic!()
    };
    value.range = Some(ByteRange { first: 0, last: 3 });
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &changed,
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::GenerationMismatch)
    );
    let mut foreign = memory.owner.clone();
    foreign.principal = id("principal-other");
    assert_eq!(
        validate_transfer(&id("transfer-1"), &req, &foreign, &policy(), &memory, NOW),
        Err(ErrorCode::NotAuthorized)
    );
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &req,
            &memory.owner,
            &policy(),
            &memory,
            2000
        ),
        Err(ErrorCode::NotAuthorized)
    );
}

#[test]
fn replay_is_owner_operation_arguments_and_precondition_bound() {
    let mut memory = MemoryAuthority::new();
    let mut commit = request("commit_upload");
    memory.replay = Some((commit.request_id.clone(), commit.action.clone()));
    memory.current = Some(id("generation-new"));
    memory.upload.committed = true;
    // A retained identical replay reconciles instead of repeating a failed precondition.
    assert_eq!(check(&commit, &memory), Ok(Admission::Replay));
    if let Action::CommitUpload(value) = &mut commit.action {
        value.intent.precondition = Precondition::Matches(id("generation-new"));
    }
    assert_eq!(check(&commit, &memory), Err(ErrorCode::ReplayConflict));
    commit.action = Action::Cancel { job: id("job-1") };
    assert_eq!(check(&commit, &memory), Err(ErrorCode::ReplayConflict));
    let mut caller = memory.owner.clone();
    caller.principal = id("principal-other");
    assert_eq!(
        validate_request(&commit, &caller, &policy(), &memory, NOW),
        Err(ErrorCode::NotAuthorized)
    );
}

#[test]
fn resume_commit_abort_bind_every_intent_field_and_owner() {
    for op in ["resume_upload", "commit_upload", "abort_upload"] {
        let memory = MemoryAuthority::new();
        let mut req = request(op);
        let action = match &mut req.action {
            Action::ResumeUpload(a) | Action::CommitUpload(a) | Action::AbortUpload(a) => a,
            _ => panic!(),
        };
        action
            .intent
            .metadata
            .user
            .insert("filename".into(), "changed".into());
        assert_eq!(check(&req, &memory), Err(ErrorCode::ReplayConflict));
        let mut foreign = memory.owner.clone();
        foreign.principal = id("principal-other");
        assert_eq!(
            validate_request(&request(op), &foreign, &policy(), &memory, NOW),
            Err(ErrorCode::NotAuthorized)
        );
    }
    let mut memory = MemoryAuthority::new();
    memory.upload.integrity_verified = false;
    assert_eq!(
        check(&request("commit_upload"), &memory),
        Err(ErrorCode::InvalidState)
    );
    memory.upload.integrity_verified = true;
    memory.upload.received_bytes = 9;
    assert_eq!(
        check(&request("commit_upload"), &memory),
        Err(ErrorCode::InvalidState)
    );
    memory.upload.received_bytes = 10;
    memory.current = Some(id("generation-new"));
    assert_eq!(
        check(&request("commit_upload"), &memory),
        Err(ErrorCode::PreconditionFailed)
    );
    memory.current = None;
    memory.upload.expires_at = NOW;
    assert_eq!(
        check(&request("resume_upload"), &memory),
        Err(ErrorCode::InvalidState)
    );
}

#[test]
fn profiles_limits_and_selection_cannot_downgrade() {
    let memory = MemoryAuthority::new();
    let Action::Capabilities(offer) = request("capabilities").action else {
        panic!()
    };
    let mut selection = memory.selection.clone();
    selection.profile.integrity = id("unknown");
    assert_eq!(
        validate_selection(&offer, &selection, &policy()),
        Err(ErrorCode::CapabilityDowngrade)
    );
    selection = memory.selection.clone();
    selection.limits.page_entries = 1;
    assert_eq!(
        validate_selection(&offer, &selection, &policy()),
        Err(ErrorCode::CapabilityDowngrade)
    );
    assert_eq!(
        negotiate(
            &offer,
            &Policy {
                profiles: vec![],
                limits: offer.limits.clone()
            },
            id("session-1")
        ),
        Err(ErrorCode::UnsupportedProfile)
    );
    let mut req = request("initiate_upload");
    let Action::InitiateUpload(intent) = &mut req.action else {
        panic!()
    };
    intent.ciphertext.profile.crypto = id("plaintext");
    assert_eq!(check(&req, &memory), Err(ErrorCode::CapabilityDowngrade));
    let mut memory = memory;
    memory.selection.limits.object_bytes = u64::MAX;
    assert_eq!(
        check(&request("stat"), &memory),
        Err(ErrorCode::CapabilityDowngrade)
    );
}

#[test]
fn ranges_cursors_and_handles_bind_immutable_generation() {
    let mut memory = MemoryAuthority::new();
    let mut req = request("download");
    let Action::Download(value) = &mut req.action else {
        panic!()
    };
    value.range = Some(ByteRange {
        first: 0,
        last: u64::MAX,
    });
    assert_eq!(check(&req, &memory), Err(ErrorCode::InvalidRange));
    memory.cursor.container = id("another-container");
    assert_eq!(
        check(&request("browse"), &memory),
        Err(ErrorCode::ReplayConflict)
    );
    memory.cursor.container = id("container-1");
    memory.cursor.expires_at = NOW;
    assert_eq!(
        check(&request("browse"), &memory),
        Err(ErrorCode::ReplayConflict)
    );
    let case = golden()
        .valid
        .into_iter()
        .find(|c| c.name == "download")
        .unwrap();
    let mut response: Response = serde_json::from_value(case.response).unwrap();
    let ResponseBody::Download(handle) = &mut response.body else {
        panic!()
    };
    handle.object.target.g = id("another-generation");
    assert_eq!(
        validate_response(
            &request("download"),
            &response,
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::GenerationMismatch)
    );
}

#[test]
fn durable_status_reconnect_cancel_and_irrecoverable_key_are_explicit() {
    let mut memory = MemoryAuthority::new();
    // A replacement negotiated connection can still resolve the same owned job.
    memory.selection.session = id("session-2");
    let mut req = request("status");
    req.session = Some(id("session-2"));
    assert_eq!(check(&req, &memory), Ok(Admission::New));
    let before = memory.job.clone();
    let mut after = before.clone();
    after.state = JobState::Running;
    after.completed_bytes = 4;
    assert_eq!(validate_status_transition(&before, &after), Ok(()));
    let mut backwards = after.clone();
    backwards.completed_bytes = 3;
    assert_eq!(
        validate_status_transition(&after, &backwards),
        Err(ErrorCode::InvalidState)
    );
    let mut terminal = after.clone();
    terminal.state = JobState::Failed;
    terminal.outcome = Some(Outcome::IrrecoverableKey);
    assert_eq!(validate_status_transition(&after, &terminal), Ok(()));
    assert_eq!(terminal.total_bytes, None);
    assert_eq!(
        validate_status_transition(&terminal, &after),
        Err(ErrorCode::InvalidState)
    );
    memory.job = terminal;
    req.action = Action::Cancel { job: id("job-1") };
    assert_eq!(check(&req, &memory), Ok(Admission::New));
    let mut wrong_kind = before;
    wrong_kind.state = JobState::Succeeded;
    wrong_kind.total_bytes = Some(0);
    wrong_kind.outcome = Some(Outcome::Committed);
    assert_eq!(validate_status(&wrong_kind), Err(ErrorCode::InvalidState));
}

fn response(request: &Request, body: ResponseBody) -> Response {
    Response {
        version: VERSION,
        scope: request.scope.clone(),
        request_id: request.request_id.clone(),
        body,
    }
}

#[test]
fn capabilities_share_the_cross_operation_replay_namespace() {
    let mut memory = MemoryAuthority::new();
    let req = request("capabilities");
    memory.replay = Some((req.request_id.clone(), request("restore").action));
    assert_eq!(check(&req, &memory), Err(ErrorCode::ReplayConflict));
    memory.replay = Some((req.request_id.clone(), req.action.clone()));
    assert_eq!(check(&req, &memory), Ok(Admission::Replay));
}

#[test]
fn cancellation_preserves_cleanup_and_publication_outcomes() {
    let mut memory = MemoryAuthority::new();
    let mut req = request("status");
    req.action = Action::Cancel { job: id("job-1") };
    memory.job.state = JobState::Cancelled;
    memory.job.outcome = Some(Outcome::CleanupRequired);
    for (outcome, expected) in [
        (
            CancelOutcome::CancelledBeforeCommit,
            Err(ErrorCode::InvalidState),
        ),
        (CancelOutcome::Requested, Err(ErrorCode::InvalidState)),
        (
            CancelOutcome::AlreadyCommitted,
            Err(ErrorCode::InvalidState),
        ),
        (CancelOutcome::CleanupRequired, Ok(())),
    ] {
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Cancel(outcome)),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            expected
        );
    }
    memory.job.state = JobState::Succeeded;
    memory.job.outcome = Some(Outcome::Restored);
    memory.job.completed_bytes = 10;
    memory.job.total_bytes = Some(10);
    let committed = response(&req, ResponseBody::Cancel(CancelOutcome::AlreadyCommitted));
    assert_eq!(
        validate_response(&req, &committed, &memory.owner, &policy(), &memory, NOW),
        Ok(())
    );
    memory.job.state = JobState::Queued;
    memory.job.outcome = None;
    assert_eq!(
        validate_response(&req, &committed, &memory.owner, &policy(), &memory, NOW),
        Err(ErrorCode::InvalidState)
    );
}

#[test]
fn restore_progress_is_bound_to_ciphertext_length_and_budget() {
    let memory = MemoryAuthority::new();
    let mut req = request("restore");
    let Action::Restore(value) = &mut req.action else {
        panic!()
    };
    value.max_bytes = 10;
    for bytes in [0, 10, 11] {
        let mut status = memory.job.clone();
        status.state = JobState::Succeeded;
        status.outcome = Some(Outcome::Restored);
        status.completed_bytes = bytes;
        status.total_bytes = Some(bytes);
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Restore(status)),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            if bytes == 10 {
                Ok(())
            } else {
                Err(ErrorCode::InvalidState)
            }
        );
    }
    let mut status = memory.job.clone();
    status.state = JobState::Running;
    status.completed_bytes = 4;
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Restore(status)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Ok(())
    );
}

#[test]
fn browse_responses_fit_the_decoder_byte_budget() {
    let mut memory = MemoryAuthority::new();
    memory.selection.limits.page_entries = 10;
    memory.cursor.page_entries = 10;
    memory.object.metadata.user.clear();
    for n in 0..7 {
        memory
            .object
            .metadata
            .user
            .insert(format!("field-{n}"), "x".repeat(1024));
    }
    let mut req = request("browse");
    let Action::Browse(value) = &mut req.action else {
        panic!()
    };
    value.page_entries = 10;
    let oversized = response(
        &req,
        ResponseBody::Browse {
            entries: vec![memory.object.clone(); 10],
            cursor: Some(id("cursor-1")),
        },
    );
    assert!(serde_json::to_vec(&oversized).unwrap().len() > MAX_MESSAGE_BYTES);
    let mut limits = policy();
    limits.limits.page_entries = 10;
    assert_eq!(
        validate_response(&req, &oversized, &memory.owner, &limits, &memory, NOW),
        Err(ErrorCode::LimitExceeded)
    );
    let bounded = response(
        &req,
        ResponseBody::Browse {
            entries: vec![memory.object.clone(); 2],
            cursor: Some(id("cursor-1")),
        },
    );
    assert_eq!(
        validate_response(&req, &bounded, &memory.owner, &limits, &memory, NOW),
        Ok(())
    );
    assert_eq!(
        decode_response(&serde_json::to_vec(&bounded).unwrap()),
        Ok(bounded)
    );
}

#[test]
fn metadata_is_exact_and_debug_and_errors_are_redacted() {
    let req = request("initiate_upload");
    let Action::InitiateUpload(intent) = &req.action else {
        panic!()
    };
    assert_eq!(
        intent.metadata.user["CaseSensitive"].as_bytes(),
        "e\u{301}".as_bytes()
    );
    assert_ne!(intent.metadata.user["CaseSensitive"], "é");
    let debug = format!("{req:?}");
    for secret in [
        "tenant-a",
        "key-ref-1",
        "envelope-ref-1",
        "ciphertext-1",
        "雪.bin",
        "application/octet-stream",
    ] {
        assert!(
            !debug.contains(secret),
            "Debug must redact sensitive fields"
        );
    }
    let bytes = serde_json::to_vec(&req).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let duplicate = text.replace(
        "\"filename\":\"雪.bin\"",
        "\"filename\":\"first\",\"filename\":\"second\"",
    );
    assert_ne!(duplicate, text);
    assert_eq!(
        decode_request(duplicate.as_bytes()),
        Err(ErrorCode::Malformed)
    );
    let mut oversized = vec![b' '; MAX_MESSAGE_BYTES + 1];
    oversized[0] = b'{';
    assert_eq!(decode_request(&oversized), Err(ErrorCode::LimitExceeded));
    assert_eq!(format!("{}", ErrorCode::Malformed), "Malformed");
    assert_eq!(
        decode_request(b"{\"scope\":\"private-value\"}"),
        Err(ErrorCode::Malformed)
    );
}

#[test]
fn responses_cannot_change_metadata_or_succeed_with_wrong_operation() {
    let memory = MemoryAuthority::new();
    for name in ["stat", "commit_upload"] {
        let case = golden().valid.into_iter().find(|c| c.name == name).unwrap();
        let mut response: Response = serde_json::from_value(case.response).unwrap();
        let object = match &mut response.body {
            ResponseBody::Stat(o) | ResponseBody::Committed(o) => o,
            _ => panic!(),
        };
        object.metadata.content_encoding = None;
        assert_eq!(
            validate_response(
                &request(name),
                &response,
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Err(ErrorCode::GenerationMismatch)
        );
        response.body = ResponseBody::Cancel(CancelOutcome::Requested);
        assert_eq!(
            validate_response(
                &request(name),
                &response,
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Err(ErrorCode::InvalidState)
        );
    }
}
