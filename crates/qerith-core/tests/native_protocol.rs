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
    session_expires_at: u64,
    session_override: Option<Owned<SessionRecord>>,
    upload_override: Option<Owned<UploadRecord>>,
    transfer_override: Option<Owned<TransferHandle>>,
    upload: UploadRecord,
    committed_result: Option<Object>,
    object: Object,
    object_override: Option<Object>,
    other_objects: Vec<Object>,
    cleanup_required: bool,
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
            session_expires_at: 2000,
            session_override: None,
            upload_override: None,
            transfer_override: None,
            committed_result: Some(object.clone()),
            object_override: None,
            cleanup_required: false,
            upload: UploadRecord {
                intent,
                received_bytes: 10,
                integrity_verified: true,
                expires_at: 2000,
                committed: false,
                abort_outcome: None,
            },
            object,
            other_objects: vec![],
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

    fn for_case(name: &str) -> Self {
        let mut memory = Self::new();
        match name {
            "initiate_upload" => {
                memory.upload.received_bytes = 0;
                memory.upload.integrity_verified = false;
            }
            "abort_upload" => {
                memory.upload.abort_outcome = Some(CancelOutcome::CancelledBeforeCommit);
            }
            "status" => {
                memory.job.state = JobState::Failed;
                memory.job.outcome = Some(Outcome::IrrecoverableKey);
            }
            _ => {}
        }
        memory
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
        if let Some(record) = &self.session_override {
            return Some(record.clone());
        }
        (value == &self.selection.session).then(|| {
            self.owned(SessionRecord {
                selection: self.selection.clone(),
                expires_at: self.session_expires_at,
            })
        })
    }
    fn key_envelope(&self, key: &Opaque, envelope: &Opaque) -> Option<Owned<()>> {
        (key == &id("key-ref-1") && envelope == &id("envelope-ref-1")).then(|| self.owned(()))
    }
    fn transfer(&self, value: &Opaque) -> Option<Owned<TransferHandle>> {
        if let Some(record) = &self.transfer_override {
            return Some(record.clone());
        }
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
        if let Some(object) = &self.object_override {
            return Some(self.owned(object.clone()));
        }
        std::iter::once(&self.object)
            .chain(&self.other_objects)
            .find(|object| *target == object.target)
            .map(|object| self.owned(object.clone()))
    }
    fn upload(&self, value: &Opaque) -> Option<Owned<UploadRecord>> {
        if let Some(record) = &self.upload_override {
            return Some(record.clone());
        }
        (value == &id("upload-1")).then(|| self.owned(self.upload.clone()))
    }
    fn committed_upload(&self, value: &Opaque) -> Option<Owned<Object>> {
        self.committed_result
            .as_ref()
            .filter(|_| value == &id("upload-1"))
            .map(|object| self.owned(object.clone()))
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
    fn job(&self, value: &Opaque) -> Option<Owned<JobRecord>> {
        (value == &self.job.job).then(|| {
            self.owned(JobRecord {
                status: self.job.clone(),
                cleanup_required: self.cleanup_required,
            })
        })
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
    for case in golden().valid {
        let memory = MemoryAuthority::for_case(&case.name);
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
    let fixtures = golden();
    for mutation in fixtures.invalid_response_mutations {
        let memory = MemoryAuthority::for_case(&mutation.case);
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
    let mut memory = MemoryAuthority::new();
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
    memory.session_expires_at = 2001;
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &req,
            &memory.owner,
            &policy(),
            &memory,
            2000
        ),
        Err(ErrorCode::GenerationMismatch)
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
        for field in ["c", "checksum_hex"] {
            let mut changed = request(op);
            let intent = match &mut changed.action {
                Action::ResumeUpload(a) | Action::CommitUpload(a) | Action::AbortUpload(a) => {
                    &mut a.intent
                }
                _ => panic!(),
            };
            if field == "c" {
                intent.ciphertext.c = id("different-ciphertext");
            } else {
                intent.ciphertext.checksum_hex = id("0123");
            }
            assert_eq!(check(&changed, &memory), Err(ErrorCode::ReplayConflict));
        }
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
    let mut mixed_offer = offer.clone();
    let mut unsupported = mixed_offer.profiles[0].clone();
    unsupported.integrity = id("unknown");
    mixed_offer.profiles.push(unsupported);
    assert_eq!(
        negotiate(&mixed_offer, &policy(), id("session-1")),
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
fn aborted_uploads_reject_fresh_resume_and_commit_but_allow_reconciliation() {
    for outcome in [
        CancelOutcome::Requested,
        CancelOutcome::CancelledBeforeCommit,
        CancelOutcome::CleanupRequired,
        CancelOutcome::AlreadyCommitted,
        CancelOutcome::AlreadyFinished,
    ] {
        let mut memory = MemoryAuthority::new();
        memory.upload.abort_outcome = Some(outcome.clone());
        for name in ["resume_upload", "commit_upload"] {
            let req = request(name);
            assert_eq!(check(&req, &memory), Err(ErrorCode::InvalidState));
            memory.replay = Some((req.request_id.clone(), req.action.clone()));
            memory.upload.expires_at = NOW;
            assert_eq!(check(&req, &memory), Ok(Admission::Replay));
            memory.replay = None;
            memory.upload.expires_at = 2000;
        }
        let req = request("abort_upload");
        assert_eq!(check(&req, &memory), Ok(Admission::New));
        if matches!(
            outcome,
            CancelOutcome::CancelledBeforeCommit | CancelOutcome::CleanupRequired
        ) {
            assert_eq!(
                validate_response(
                    &req,
                    &response(&req, ResponseBody::Aborted(outcome)),
                    &memory.owner,
                    &policy(),
                    &memory,
                    NOW
                ),
                Ok(())
            );
        }
        memory.upload.abort_outcome = None;
        for name in ["resume_upload", "commit_upload"] {
            assert_eq!(check(&request(name), &memory), Ok(Admission::New));
        }
    }
}

#[test]
fn status_responses_require_the_persisted_snapshot_for_both_job_kinds() {
    for (kind, outcome) in [
        (JobKind::Upload, Outcome::Committed),
        (JobKind::Restore, Outcome::Restored),
    ] {
        let mut memory = MemoryAuthority::new();
        memory.job.kind = kind;
        let req = request("status");
        let before = memory.job.clone();
        let mut after = before.clone();
        after.state = JobState::Succeeded;
        after.completed_bytes = 10;
        after.total_bytes = Some(10);
        after.outcome = Some(outcome);
        assert_eq!(validate_status_transition(&before, &after), Ok(()));
        for state in [JobState::Running, JobState::Succeeded] {
            let mut claimed = after.clone();
            claimed.state = state;
            if claimed.state == JobState::Running {
                claimed.outcome = None;
            }
            let reply = response(&req, ResponseBody::Status(claimed.clone()));
            assert_eq!(
                validate_response(&req, &reply, &memory.owner, &policy(), &memory, NOW),
                Err(ErrorCode::InvalidState)
            );
            memory.job = claimed;
            assert_eq!(
                validate_response(&req, &reply, &memory.owner, &policy(), &memory, NOW),
                Ok(())
            );
            let stale = response(&req, ResponseBody::Status(before.clone()));
            assert_eq!(
                validate_response(&req, &stale, &memory.owner, &policy(), &memory, NOW),
                Err(ErrorCode::InvalidState)
            );
            memory.job = before.clone();
        }
        memory.job = after.clone();
        let mut foreign = memory.owner.clone();
        foreign.principal = id("foreign-principal");
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Status(after)),
                &foreign,
                &policy(),
                &memory,
                NOW
            ),
            Err(ErrorCode::NotAuthorized)
        );
        let mut missing = req.clone();
        missing.action = Action::Status {
            job: id("missing-job"),
        };
        assert_eq!(
            validate_response(
                &missing,
                &response(&missing, ResponseBody::Status(memory.job.clone())),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Err(ErrorCode::NotAuthorized)
        );
    }
}

#[test]
fn capability_response_requires_an_owned_live_matching_session() {
    let memory = MemoryAuthority::new();
    let req = request("capabilities");
    let reply = response(&req, ResponseBody::Capabilities(memory.selection.clone()));
    assert_eq!(
        validate_response(&req, &reply, &memory.owner, &policy(), &memory, NOW),
        Ok(())
    );
    let mut missing = memory.selection.clone();
    missing.session = id("missing-session");
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Capabilities(missing)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::NotAuthorized)
    );
    for mutation in 0..6 {
        let mut changed = memory.clone();
        let mut record = memory.session(&memory.selection.session).unwrap();
        let expected = match mutation {
            0 => {
                record.owner.principal = id("foreign-principal");
                ErrorCode::NotAuthorized
            }
            1 => {
                record.value.expires_at = NOW;
                ErrorCode::NotAuthorized
            }
            2 => {
                record.value.selection.session = id("wrong-session");
                ErrorCode::NotAuthorized
            }
            3 => {
                record.value.selection.version = 2;
                ErrorCode::UnsupportedVersion
            }
            4 => {
                record.value.selection.profile.crypto = id("unsupported");
                ErrorCode::UnsupportedProfile
            }
            _ => {
                record.value.selection.limits.page_entries = 1;
                ErrorCode::InvalidState
            }
        };
        changed.session_override = Some(record);
        assert_eq!(
            validate_response(&req, &reply, &changed.owner, &policy(), &changed, NOW),
            Err(expected)
        );
    }
}

#[test]
fn initiate_response_requires_an_owned_live_active_matching_upload() {
    let memory = MemoryAuthority::for_case("initiate_upload");
    let req = request("initiate_upload");
    let reply = response(
        &req,
        ResponseBody::Upload {
            upload: id("upload-1"),
            received_bytes: 0,
        },
    );
    assert_eq!(
        validate_response(&req, &reply, &memory.owner, &policy(), &memory, NOW),
        Ok(())
    );
    let missing = response(
        &req,
        ResponseBody::Upload {
            upload: id("missing-upload"),
            received_bytes: 0,
        },
    );
    assert_eq!(
        validate_response(&req, &missing, &memory.owner, &policy(), &memory, NOW),
        Err(ErrorCode::NotAuthorized)
    );
    for mutation in 0..13 {
        let mut changed = memory.clone();
        let mut record = memory.owned(memory.upload.clone());
        match mutation {
            0 => record.owner.principal = id("foreign-principal"),
            1 => record.value.expires_at = NOW,
            2 => record.value.committed = true,
            3 => record.value.abort_outcome = Some(CancelOutcome::CancelledBeforeCommit),
            4 => record.value.abort_outcome = Some(CancelOutcome::CleanupRequired),
            5 => record.value.received_bytes = 1,
            6 => record.value.intent.object = id("wrong-object"),
            7 => record.value.intent.precondition = Precondition::Matches(id("wrong-generation")),
            8 => record.value.intent.ciphertext.c = id("wrong-ciphertext"),
            9 => record.value.intent.ciphertext.length = 9,
            10 => record.value.intent.ciphertext.checksum_hex = id("0123"),
            11 => record.value.intent.ciphertext.envelope_ref = id("wrong-envelope"),
            _ => record.value.intent.metadata.content_encoding = None,
        }
        changed.upload_override = Some(record);
        assert_eq!(
            validate_response(&req, &reply, &changed.owner, &policy(), &changed, NOW),
            Err(if mutation == 0 {
                ErrorCode::NotAuthorized
            } else {
                ErrorCode::InvalidState
            })
        );
    }
    let mut continuation = request("resume_upload");
    let Action::ResumeUpload(value) = &mut continuation.action else {
        panic!()
    };
    value.upload = id("upload-1");
    assert_eq!(check(&continuation, &memory), Ok(Admission::New));
}

#[test]
fn download_response_requires_the_owned_live_exact_transfer_record() {
    let memory = MemoryAuthority::new();
    let req = request("download");
    let handle = memory.transfer(&id("transfer-1")).unwrap().value;
    let reply = response(&req, ResponseBody::Download(handle.clone()));
    assert_eq!(
        validate_response(&req, &reply, &memory.owner, &policy(), &memory, NOW),
        Ok(())
    );
    let mut missing = handle.clone();
    missing.handle = id("missing-handle");
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Download(missing)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::NotAuthorized)
    );
    for mutation in 0..9 {
        let mut changed = memory.clone();
        let mut record = memory.owned(handle.clone());
        match mutation {
            0 => record.owner.principal = id("foreign-principal"),
            1 => record.value.handle = id("wrong-handle"),
            2 => record.value.expires_at = NOW,
            3 => record.value.expires_at += 1,
            4 => record.value.object.target.g = id("wrong-generation"),
            5 => record.value.object.ciphertext.c = id("wrong-ciphertext"),
            6 => record.value.object.metadata.content_encoding = None,
            7 => record.value.range = None,
            _ => record.value.range = Some(ByteRange { first: 0, last: 3 }),
        }
        changed.transfer_override = Some(record);
        assert_eq!(
            validate_response(&req, &reply, &changed.owner, &policy(), &changed, NOW),
            Err(if mutation == 0 {
                ErrorCode::NotAuthorized
            } else {
                ErrorCode::GenerationMismatch
            })
        );
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
    memory.cleanup_required = true;
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
    memory.cleanup_required = false;
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
    let mut memory = MemoryAuthority::new();
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
        memory.job = status.clone();
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
    let mut status = MemoryAuthority::new().job;
    status.state = JobState::Running;
    status.completed_bytes = 4;
    memory.job = status.clone();
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
fn status_and_cancel_bind_progress_to_resolved_ciphertext_length() {
    for (kind, outcome) in [
        (JobKind::Restore, Outcome::Restored),
        (JobKind::Upload, Outcome::Committed),
    ] {
        let mut memory = MemoryAuthority::new();
        memory.job.kind = kind;
        let req = request("status");
        for (completed, total, expected) in [
            (4, None, Ok(())),
            (4, Some(10), Ok(())),
            (11, None, Err(ErrorCode::InvalidState)),
            (4, Some(20), Err(ErrorCode::InvalidState)),
        ] {
            let mut status = memory.job.clone();
            status.state = JobState::Running;
            status.completed_bytes = completed;
            status.total_bytes = total;
            let mut recorded = memory.clone();
            recorded.job = status.clone();
            assert_eq!(
                validate_response(
                    &req,
                    &response(&req, ResponseBody::Status(status.clone())),
                    &recorded.owner,
                    &policy(),
                    &recorded,
                    NOW
                ),
                expected
            );
            for name in ["status", "cancel"] {
                assert_eq!(check(&request(name), &recorded).map(|_| ()), expected);
            }
        }
        for bytes in [0, 10, 20] {
            let mut status = memory.job.clone();
            status.state = JobState::Succeeded;
            status.outcome = Some(outcome.clone());
            status.completed_bytes = bytes;
            status.total_bytes = Some(bytes);
            let expected = if bytes == 10 {
                Ok(())
            } else {
                Err(ErrorCode::InvalidState)
            };
            let mut recorded = memory.clone();
            recorded.job = status.clone();
            assert_eq!(
                validate_response(
                    &req,
                    &response(&req, ResponseBody::Status(status.clone())),
                    &recorded.owner,
                    &policy(),
                    &recorded,
                    NOW
                ),
                expected
            );
            for name in ["status", "cancel"] {
                assert_eq!(check(&request(name), &recorded).map(|_| ()), expected);
            }
        }
        memory.job.target.g = id("wrong-generation");
        for name in ["status", "cancel"] {
            let expected = if memory.job.kind == JobKind::Upload {
                // An unpublished, unfinished upload has no committed target yet.
                Ok(Admission::New)
            } else {
                Err(ErrorCode::NotAuthorized)
            };
            assert_eq!(check(&request(name), &memory), expected);
        }
    }
}

#[test]
fn upload_status_without_a_committed_target_cannot_claim_success() {
    let mut memory = MemoryAuthority::new();
    memory.job.kind = JobKind::Upload;
    memory.job.target.object = id("not-yet-committed");
    for name in ["status", "cancel"] {
        assert_eq!(check(&request(name), &memory), Ok(Admission::New));
    }
    let req = request("status");
    let mut status = memory.job.clone();
    status.state = JobState::Succeeded;
    status.completed_bytes = 10;
    status.total_bytes = Some(10);
    status.outcome = Some(Outcome::Committed);
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Status(status.clone())),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::NotAuthorized)
    );
    memory.job = status;
    assert_eq!(check(&req, &memory), Err(ErrorCode::NotAuthorized));
    memory.job.kind = JobKind::Restore;
    memory.job.state = JobState::Queued;
    memory.job.completed_bytes = 0;
    memory.job.total_bytes = None;
    memory.job.outcome = None;
    assert_eq!(check(&req, &memory), Err(ErrorCode::NotAuthorized));
}

#[test]
fn supported_read_profiles_can_differ_but_write_intents_stay_session_bound() {
    let mut memory = MemoryAuthority::new();
    let mut rules = policy();
    let mut older = rules.profiles[0].clone();
    older.profile.format = id("fixture-older-format");
    older.profile.crypto = id("fixture-older-crypto");
    older.profile.integrity = id("fixture-older-integrity");
    older.checksum_hex_chars = 8;
    rules.profiles.push(older.clone());
    let mut object = memory.object.clone();
    object.target.object = id("older-object");
    object.target.g = id("older-generation");
    object.ciphertext.c = id("older-ciphertext");
    object.ciphertext.profile = older.profile.clone();
    object.ciphertext.checksum_hex = id("0123abcd");
    memory.other_objects.push(object.clone());
    let req = request("browse");
    let page = response(
        &req,
        ResponseBody::Browse {
            entries: vec![memory.object.clone(), object.clone()],
            cursor: None,
        },
    );
    assert_eq!(
        validate_response(&req, &page, &memory.owner, &rules, &memory, NOW),
        Ok(())
    );
    assert_eq!(
        decode_response(&serde_json::to_vec(&page).unwrap()),
        Ok(page.clone())
    );
    for name in ["stat", "download", "restore"] {
        let mut req = request(name);
        match &mut req.action {
            Action::Stat(target) => *target = object.target.clone(),
            Action::Download(value) => value.target = object.target.clone(),
            Action::Restore(value) => value.target = object.target.clone(),
            _ => panic!(),
        }
        let body = match name {
            "stat" => ResponseBody::Stat(object.clone()),
            "download" => {
                let handle = TransferHandle {
                    handle: id("older-transfer"),
                    object: object.clone(),
                    range: Some(ByteRange { first: 2, last: 5 }),
                    expires_at: 2000,
                };
                memory.transfer_override = Some(memory.owned(handle.clone()));
                ResponseBody::Download(handle)
            }
            "restore" => {
                let mut status = memory.job.clone();
                status.target = object.target.clone();
                memory.job = status.clone();
                ResponseBody::Restore(status)
            }
            _ => panic!(),
        };
        assert_eq!(
            validate_request(&req, &memory.owner, &rules, &memory, NOW),
            Ok(Admission::New)
        );
        assert_eq!(
            validate_response(
                &req,
                &response(&req, body),
                &memory.owner,
                &rules,
                &memory,
                NOW
            ),
            Ok(())
        );
        assert_eq!(
            validate_request(&req, &memory.owner, &policy(), &memory, NOW),
            Err(ErrorCode::UnsupportedProfile)
        );
    }
    assert_eq!(
        validate_response(
            &request("browse"),
            &page,
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::UnsupportedProfile)
    );
    for kind in [JobKind::Restore, JobKind::Upload] {
        memory.job.kind = kind;
        memory.job.target = object.target.clone();
        for name in ["status", "cancel"] {
            assert_eq!(
                validate_request(&request(name), &memory.owner, &rules, &memory, NOW),
                Ok(Admission::New)
            );
        }
    }
    // Redemption rechecks the stored profile, not just authorization issuance.
    memory.transfer_override = None;
    memory.object = object;
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &request("download"),
            &memory.owner,
            &rules,
            &memory,
            NOW
        ),
        Err(ErrorCode::NotAuthorized)
    );
    let mut download = request("download");
    let Action::Download(value) = &mut download.action else {
        panic!()
    };
    value.target = memory.object.target.clone();
    assert_eq!(
        validate_transfer(
            &id("transfer-1"),
            &download,
            &memory.owner,
            &rules,
            &memory,
            NOW
        ),
        Ok(())
    );
    for name in [
        "initiate_upload",
        "resume_upload",
        "commit_upload",
        "abort_upload",
    ] {
        let mut req = request(name);
        let intent = match &mut req.action {
            Action::InitiateUpload(intent) => intent,
            Action::ResumeUpload(value)
            | Action::CommitUpload(value)
            | Action::AbortUpload(value) => &mut value.intent,
            _ => panic!(),
        };
        intent.ciphertext.profile = older.profile.clone();
        intent.ciphertext.checksum_hex = id("0123abcd");
        assert_eq!(
            validate_request(&req, &memory.owner, &rules, &memory, NOW),
            Err(ErrorCode::CapabilityDowngrade)
        );
    }
}

#[test]
fn reconnect_limits_do_not_hide_owned_status_or_cancellation() {
    let mut memory = MemoryAuthority::new();
    memory.selection.limits.object_bytes = 5;
    memory.selection.limits.transfer_bytes = 5;
    for kind in [JobKind::Restore, JobKind::Upload] {
        memory.job.kind = kind;
        let req = request("status");
        assert_eq!(check(&req, &memory), Ok(Admission::New));
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Status(memory.job.clone())),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Ok(())
        );
        let req = request("cancel");
        assert_eq!(check(&req, &memory), Ok(Admission::New));
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Cancel(CancelOutcome::Requested)),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Ok(())
        );
        memory.job.completed_bytes = 11;
        assert_eq!(check(&req, &memory), Err(ErrorCode::InvalidState));
        memory.job.completed_bytes = 0;
    }
    for name in ["download", "restore"] {
        assert_eq!(
            check(&request(name), &memory),
            Err(ErrorCode::LimitExceeded)
        );
    }
    memory.object.ciphertext.profile.crypto = id("unsupported");
    assert_eq!(
        check(&request("status"), &memory),
        Err(ErrorCode::UnsupportedProfile)
    );
}

#[test]
fn commit_response_requires_the_authoritative_published_result() {
    let mut memory = MemoryAuthority::new();
    let req = request("commit_upload");
    let valid = response(&req, ResponseBody::Committed(memory.object.clone()));
    assert_eq!(
        validate_response(&req, &valid, &memory.owner, &policy(), &memory, NOW),
        Ok(())
    );
    let mut unpublished = memory.object.clone();
    unpublished.target.g = id("unpublished-generation");
    memory.other_objects.push(unpublished.clone());
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Committed(unpublished)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::GenerationMismatch)
    );
    memory.committed_result = None;
    assert_eq!(
        validate_response(&req, &valid, &memory.owner, &policy(), &memory, NOW),
        Err(ErrorCode::NotAuthorized)
    );
}

#[test]
fn abort_response_requires_the_recorded_cleanup_outcome() {
    let mut memory = MemoryAuthority::new();
    let req = request("abort_upload");
    memory.upload.abort_outcome = Some(CancelOutcome::CleanupRequired);
    for (outcome, expected) in [
        (
            CancelOutcome::CancelledBeforeCommit,
            Err(ErrorCode::InvalidState),
        ),
        (CancelOutcome::Requested, Err(ErrorCode::InvalidState)),
        (CancelOutcome::CleanupRequired, Ok(())),
    ] {
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Aborted(outcome)),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            expected
        );
    }
    memory.upload.abort_outcome = None;
    assert_eq!(
        validate_response(
            &req,
            &response(
                &req,
                ResponseBody::Aborted(CancelOutcome::CancelledBeforeCommit)
            ),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::InvalidState)
    );
    memory.upload.committed = true;
    memory.upload.abort_outcome = Some(CancelOutcome::AlreadyCommitted);
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Aborted(CancelOutcome::AlreadyCommitted)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Ok(())
    );
}

#[test]
fn cleanup_obligation_does_not_replace_terminal_failure() {
    let mut memory = MemoryAuthority::new();
    memory.job.kind = JobKind::Upload;
    memory.job.state = JobState::Failed;
    memory.job.completed_bytes = 4;
    memory.job.outcome = Some(Outcome::IntegrityFailure);
    memory.cleanup_required = true;
    let before = memory.job.clone();
    let req = request("cancel");
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Cancel(CancelOutcome::CleanupRequired)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Ok(())
    );
    for outcome in [
        CancelOutcome::Requested,
        CancelOutcome::CancelledBeforeCommit,
        CancelOutcome::AlreadyCommitted,
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
            Err(ErrorCode::InvalidState)
        );
    }
    assert_eq!(memory.job, before);
    memory.cleanup_required = false;
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Cancel(CancelOutcome::CleanupRequired)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::InvalidState)
    );
}

#[test]
fn cancel_after_cleanup_is_a_noop_without_rewriting_terminal_status() {
    let mut memory = MemoryAuthority::new();
    let req = request("cancel");
    let finished = response(&req, ResponseBody::Cancel(CancelOutcome::AlreadyFinished));
    assert_eq!(
        serde_json::to_value(&finished).unwrap()["body"]["output"],
        "already_finished"
    );
    assert_eq!(
        decode_response(&serde_json::to_vec(&finished).unwrap()).unwrap(),
        finished
    );
    for kind in [JobKind::Upload, JobKind::Restore] {
        memory.job.kind = kind;
        for (state, outcome) in [
            (JobState::Cancelled, Outcome::CleanupRequired),
            (JobState::Cancelled, Outcome::CancelledBeforeCommit),
            (JobState::Failed, Outcome::CleanupRequired),
            (JobState::Failed, Outcome::IntegrityFailure),
            (JobState::Failed, Outcome::IrrecoverableKey),
            (JobState::Failed, Outcome::Unavailable),
        ] {
            memory.job.state = state;
            memory.job.outcome = Some(outcome);
            let terminal = memory.job.clone();
            for cleanup_required in [true, false] {
                memory.cleanup_required = cleanup_required;
                assert_eq!(
                    validate_response(&req, &finished, &memory.owner, &policy(), &memory, NOW),
                    if cleanup_required {
                        Err(ErrorCode::InvalidState)
                    } else {
                        Ok(())
                    }
                );
                let cleanup = response(&req, ResponseBody::Cancel(CancelOutcome::CleanupRequired));
                assert_eq!(
                    validate_response(&req, &cleanup, &memory.owner, &policy(), &memory, NOW),
                    if cleanup_required {
                        Ok(())
                    } else {
                        Err(ErrorCode::InvalidState)
                    }
                );
                let status_req = request("status");
                assert_eq!(
                    validate_response(
                        &status_req,
                        &response(&status_req, ResponseBody::Status(terminal.clone())),
                        &memory.owner,
                        &policy(),
                        &memory,
                        NOW
                    ),
                    Ok(())
                );
                assert_eq!(memory.job, terminal);
            }
        }
        for (state, outcome) in [
            (JobState::Queued, None),
            (JobState::Running, None),
            (
                JobState::Succeeded,
                Some(if memory.job.kind == JobKind::Upload {
                    Outcome::Committed
                } else {
                    Outcome::Restored
                }),
            ),
        ] {
            memory.job.state = state;
            memory.job.outcome = outcome;
            memory.job.completed_bytes = 10;
            memory.job.total_bytes = Some(10);
            assert_eq!(
                validate_response(&req, &finished, &memory.owner, &policy(), &memory, NOW),
                Err(ErrorCode::InvalidState)
            );
        }
    }
}

#[test]
fn restore_response_requires_an_owned_persisted_job_snapshot() {
    let memory = MemoryAuthority::new();
    let req = request("restore");
    let mut status = memory.job.clone();
    status.job = id("missing-job");
    assert_eq!(
        validate_response(
            &req,
            &response(&req, ResponseBody::Restore(status)),
            &memory.owner,
            &policy(),
            &memory,
            NOW
        ),
        Err(ErrorCode::NotAuthorized)
    );
    let valid = response(&req, ResponseBody::Restore(memory.job.clone()));
    for mutation in [0, 1, 2] {
        let mut changed = memory.clone();
        match mutation {
            0 => changed.job.target.g = id("another-generation"),
            1 => changed.job.kind = JobKind::Upload,
            _ => changed.job.completed_bytes = 1,
        }
        assert_eq!(
            validate_response(&req, &valid, &changed.owner, &policy(), &changed, NOW),
            Err(ErrorCode::InvalidState)
        );
    }
}

#[test]
fn retained_generations_resolve_exactly_and_malformed_resolvers_fail() {
    let mut memory = MemoryAuthority::new();
    let mut older = memory.object.clone();
    older.target.g = id("retained-generation");
    memory.other_objects.push(older.clone());
    for object in [memory.object.clone(), older] {
        let mut req = request("stat");
        req.action = Action::Stat(object.target.clone());
        assert_eq!(check(&req, &memory), Ok(Admission::New));
        assert_eq!(
            validate_response(
                &req,
                &response(&req, ResponseBody::Stat(object)),
                &memory.owner,
                &policy(),
                &memory,
                NOW
            ),
            Ok(())
        );
    }
    memory.object_override = Some(memory.object.clone());
    let mut req = request("stat");
    req.action = Action::Stat(Target {
        object: id("object-1"),
        g: id("unretained-generation"),
    });
    assert_eq!(check(&req, &memory), Err(ErrorCode::GenerationMismatch));
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
