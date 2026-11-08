use super::wire::*;
use std::fmt;

type Check<T = ()> = std::result::Result<T, ErrorCode>;

/// Deployment-supplied, independently reviewed profile registry; no built-in suite.
#[derive(Clone, Debug)]
pub struct SupportedProfile {
    pub profile: Profile,
    pub checksum_hex_chars: u16,
}

#[derive(Clone, Debug)]
pub struct Policy {
    pub profiles: Vec<SupportedProfile>,
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub scope: Opaque,
    pub principal: Opaque,
}

#[derive(Clone, Debug)]
pub struct Owned<T> {
    pub owner: Owner,
    pub value: T,
}

impl<T> Owned<T> {
    fn for_owner(self, owner: &Owner) -> Check<T> {
        if self.owner == *owner {
            Ok(self.value)
        } else {
            Err(ErrorCode::NotAuthorized)
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub selection: Selection,
    pub expires_at: u64,
}

#[derive(Clone, Debug)]
pub struct UploadRecord {
    pub intent: UploadIntent,
    pub received_bytes: u64,
    /// Set only by trusted full-byte length/checksum verification, never the client.
    pub integrity_verified: bool,
    pub expires_at: u64,
    pub committed: bool,
    /// Trusted result of an abort attempt, including outstanding external cleanup.
    pub abort_outcome: Option<CancelOutcome>,
}

#[derive(Clone, Debug)]
pub struct JobRecord {
    pub status: JobStatus,
    /// Independent of the immutable terminal failure; never inferred from the client.
    pub cleanup_required: bool,
}

#[derive(Clone, Debug)]
pub struct CursorRecord {
    pub container: Opaque,
    pub page_entries: u16,
    pub expires_at: u64,
}

#[derive(Clone, Debug)]
pub struct ReplayRecord {
    pub action: Action,
}

/// Trusted authorization/resolution port, not a wire payload or persistence API.
///
/// Implementations must authenticate outside this module, enforce current grants,
/// use non-enumerable scoped IDs, and resolve only committed immutable snapshots.
/// `replay` is keyed by owner + request ID across ALL operations. A matching
/// replay requires atomic reconciliation by the adapter, never re-execution.
/// Errors and absent/foreign references must have the same public disclosure.
pub trait Authority {
    fn session(&self, id: &Opaque) -> Option<Owned<SessionRecord>>;
    fn key_envelope(&self, key: &Opaque, envelope: &Opaque) -> Option<Owned<()>>;
    fn transfer(&self, id: &Opaque) -> Option<Owned<TransferHandle>>;
    /// An authorized logical destination, including one with no current generation.
    fn destination(&self, id: &Opaque) -> Option<Owned<Option<Opaque>>>;
    fn object(&self, target: &Target) -> Option<Owned<Object>>;
    fn upload(&self, id: &Opaque) -> Option<Owned<UploadRecord>>;
    /// Retained result actually published by this upload, not any matching object.
    fn committed_upload(&self, id: &Opaque) -> Option<Owned<Object>>;
    fn container(&self, id: &Opaque) -> Option<Owned<()>>;
    fn listed_object(&self, container: &Opaque, target: &Target) -> Option<Owned<Object>>;
    fn cursor(&self, id: &Opaque) -> Option<Owned<CursorRecord>>;
    fn job(&self, id: &Opaque) -> Option<Owned<JobRecord>>;
    fn replay(&self, owner: &Owner, request_id: &Opaque) -> Option<Owned<ReplayRecord>>;
}

fn owned<T>(record: Option<Owned<T>>, owner: &Owner) -> Check<T> {
    record.ok_or(ErrorCode::NotAuthorized)?.for_owner(owner)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    New,
    /// Reconcile the retained result/checkpoint; this is NOT permission to run again.
    Replay,
}

pub fn decode_request(bytes: &[u8]) -> Check<Request> {
    decode(bytes)
}

pub fn decode_response(bytes: &[u8]) -> Check<Response> {
    decode(bytes)
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Check<T> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(ErrorCode::LimitExceeded);
    }
    serde_json::from_slice(bytes).map_err(|_| ErrorCode::Malformed)
}

impl Limits {
    fn valid(&self) -> bool {
        self.object_bytes > 0
            && self.object_bytes <= (1_u64 << 50)
            && self.transfer_bytes > 0
            && self.transfer_bytes <= self.object_bytes
            && self.page_entries > 0
            && self.page_entries <= 1000
            && self.job_seconds > 0
            && self.job_seconds <= 86_400
    }

    fn fits(&self, ceiling: &Self) -> bool {
        self.valid()
            && self.object_bytes <= ceiling.object_bytes
            && self.transfer_bytes <= ceiling.transfer_bytes
            && self.page_entries <= ceiling.page_entries
            && self.job_seconds <= ceiling.job_seconds
    }
}

impl Policy {
    fn supported(&self, profile: &Profile) -> Check<&SupportedProfile> {
        self.profiles
            .iter()
            .find(|p| {
                p.profile == *profile
                    && (2..=128).contains(&p.checksum_hex_chars)
                    && p.checksum_hex_chars % 2 == 0
            })
            .ok_or(ErrorCode::UnsupportedProfile)
    }
}

pub fn negotiate(offer: &Offer, policy: &Policy, session: Opaque) -> Check<Selection> {
    if !offer.versions.contains(&VERSION) {
        return Err(ErrorCode::UnsupportedVersion);
    }
    if offer.versions.is_empty()
        || offer.versions.len() > 16
        || offer.profiles.is_empty()
        || offer.profiles.len() > 16
        || !policy.limits.valid()
        || !offer.limits.fits(&policy.limits)
    {
        return Err(ErrorCode::LimitExceeded);
    }
    // An offered requirement is not silently ignored, even if another is supported.
    for profile in &offer.profiles {
        policy.supported(profile)?;
    }
    Ok(Selection {
        version: VERSION,
        session,
        profile: offer.profiles[0].clone(),
        limits: offer.limits.clone(),
    })
}

pub fn validate_selection(offer: &Offer, selected: &Selection, policy: &Policy) -> Check {
    let expected = negotiate(offer, policy, selected.session.clone())?;
    if selected != &expected {
        return Err(ErrorCode::CapabilityDowngrade);
    }
    Ok(())
}

fn metadata(value: &Metadata) -> Check {
    let header = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(|c| c.is_control());
    let bytes = value.content_type.len()
        + value.content_encoding.as_ref().map_or(0, String::len)
        + value
            .user
            .iter()
            .map(|(k, v)| k.len() + v.len())
            .sum::<usize>();
    if !header(&value.content_type)
        || value
            .content_encoding
            .as_deref()
            .is_some_and(|s| !header(s))
        || value.user.len() > 64
        || bytes > 8192
        || value.user.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 128
                || v.len() > 1024
                || k.chars().chain(v.chars()).any(|c| c.is_control())
        })
    {
        return Err(ErrorCode::LimitExceeded);
    }
    Ok(())
}

fn ciphertext(value: &Ciphertext, selected: &Selection, policy: &Policy) -> Check {
    if value.length > selected.limits.object_bytes {
        return Err(ErrorCode::LimitExceeded);
    }
    stored_ciphertext(value, policy)
}

fn stored_ciphertext(value: &Ciphertext, policy: &Policy) -> Check {
    let supported = policy.supported(&value.profile)?;
    if value.length > (1_u64 << 50) {
        return Err(ErrorCode::LimitExceeded);
    }
    if value.checksum_hex.as_str().len() != usize::from(supported.checksum_hex_chars)
        || !value
            .checksum_hex
            .as_str()
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ErrorCode::Malformed);
    }
    Ok(())
}

fn intent(value: &UploadIntent, selected: &Selection, policy: &Policy) -> Check {
    if value.ciphertext.profile != selected.profile {
        return Err(ErrorCode::CapabilityDowngrade);
    }
    ciphertext(&value.ciphertext, selected, policy)?;
    metadata(&value.metadata)
}

fn precondition(value: &UploadIntent, owner: &Owner, authority: &impl Authority) -> Check {
    let current = owned(authority.destination(&value.object), owner)?;
    match (&value.precondition, current) {
        (Precondition::Absent, None) => Ok(()),
        (Precondition::Matches(expected), Some(actual)) if expected == &actual => Ok(()),
        _ => Err(ErrorCode::PreconditionFailed),
    }
}

fn resolved_object(
    target: &Target,
    owner: &Owner,
    selected: &Selection,
    policy: &Policy,
    authority: &impl Authority,
) -> Check<Object> {
    let value = checked_object(owned(authority.object(target), owner)?, target, policy)?;
    ciphertext(&value.ciphertext, selected, policy)?;
    Ok(value)
}

fn checked_object(value: Object, target: &Target, policy: &Policy) -> Check<Object> {
    if value.target != *target {
        return Err(ErrorCode::GenerationMismatch);
    }
    stored_ciphertext(&value.ciphertext, policy)?;
    metadata(&value.metadata)?;
    Ok(value)
}

fn range_bytes(range: Option<&ByteRange>, length: u64) -> Check<u64> {
    match range {
        Some(r) if r.first <= r.last && r.last < length => Ok(r.last - r.first + 1),
        Some(_) => Err(ErrorCode::InvalidRange),
        None => Ok(length),
    }
}

fn session(
    request: &Request,
    owner: &Owner,
    policy: &Policy,
    authority: &impl Authority,
    now: u64,
) -> Check<Selection> {
    let id = request.session.as_ref().ok_or(ErrorCode::NotAuthorized)?;
    let session = owned(authority.session(id), owner)?;
    if session.expires_at <= now || session.selection.session != *id {
        return Err(ErrorCode::NotAuthorized);
    }
    if session.selection.version != VERSION {
        return Err(ErrorCode::UnsupportedVersion);
    }
    policy.supported(&session.selection.profile)?;
    if !policy.limits.valid() || !session.selection.limits.fits(&policy.limits) {
        return Err(ErrorCode::CapabilityDowngrade);
    }
    Ok(session.selection)
}

pub fn validate_request(
    request: &Request,
    owner: &Owner,
    policy: &Policy,
    authority: &impl Authority,
    now: u64,
) -> Check<Admission> {
    if request.scope != owner.scope {
        return Err(ErrorCode::NotAuthorized);
    }
    if request.version != VERSION {
        return Err(ErrorCode::UnsupportedVersion);
    }
    let replay = if let Some(prior) = authority.replay(owner, &request.request_id) {
        let prior = prior.for_owner(owner)?;
        if prior.action != request.action {
            return Err(ErrorCode::ReplayConflict);
        }
        true
    } else {
        false
    };
    if let Action::Capabilities(offer) = &request.action {
        if request.session.is_some() {
            return Err(ErrorCode::InvalidState);
        }
        negotiate(offer, policy, request.request_id.clone())?;
        return Ok(if replay {
            Admission::Replay
        } else {
            Admission::New
        });
    }
    let selected = session(request, owner, policy, authority, now)?;
    match &request.action {
        Action::Capabilities(_) => unreachable!(),
        Action::InitiateUpload(value) => {
            intent(value, &selected, policy)?;
            owned(
                authority.key_envelope(&value.ciphertext.key_ref, &value.ciphertext.envelope_ref),
                owner,
            )?;
            if replay {
                owned(authority.destination(&value.object), owner)?;
            } else {
                precondition(value, owner, authority)?;
            }
        }
        Action::ResumeUpload(value) | Action::CommitUpload(value) | Action::AbortUpload(value) => {
            intent(&value.intent, &selected, policy)?;
            owned(
                authority.key_envelope(
                    &value.intent.ciphertext.key_ref,
                    &value.intent.ciphertext.envelope_ref,
                ),
                owner,
            )?;
            let record = owned(authority.upload(&value.upload), owner)?;
            if record.intent != value.intent {
                return Err(ErrorCode::ReplayConflict);
            }
            if record.received_bytes > record.intent.ciphertext.length
                || !replay
                    && (record.expires_at <= now
                        || record.committed && !matches!(request.action, Action::AbortUpload(_)))
            {
                return Err(ErrorCode::InvalidState);
            }
            owned(authority.destination(&value.intent.object), owner)?;
            if !replay && matches!(request.action, Action::CommitUpload(_)) {
                if record.received_bytes != record.intent.ciphertext.length
                    || !record.integrity_verified
                {
                    return Err(ErrorCode::InvalidState);
                }
                precondition(&value.intent, owner, authority)?;
            }
        }
        Action::Browse(value) => {
            owned(authority.container(&value.container), owner)?;
            if value.page_entries == 0 || value.page_entries > selected.limits.page_entries {
                return Err(ErrorCode::LimitExceeded);
            }
            if let Some(id) = &value.cursor {
                let cursor = owned(authority.cursor(id), owner)?;
                if cursor.expires_at <= now
                    || cursor.container != value.container
                    || cursor.page_entries != value.page_entries
                {
                    return Err(ErrorCode::ReplayConflict);
                }
            }
        }
        Action::Stat(target) => {
            resolved_object(target, owner, &selected, policy, authority)?;
        }
        Action::Download(value) => {
            let object = resolved_object(&value.target, owner, &selected, policy, authority)?;
            let bytes = range_bytes(value.range.as_ref(), object.ciphertext.length)?;
            if value.max_bytes == 0
                || value.max_bytes > selected.limits.transfer_bytes
                || bytes > value.max_bytes
            {
                return Err(ErrorCode::LimitExceeded);
            }
        }
        Action::Restore(value) => {
            let object = resolved_object(&value.target, owner, &selected, policy, authority)?;
            if value.max_bytes == 0
                || value.max_bytes > selected.limits.object_bytes
                || object.ciphertext.length > value.max_bytes
                || value.max_seconds == 0
                || value.max_seconds > selected.limits.job_seconds
            {
                return Err(ErrorCode::LimitExceeded);
            }
        }
        Action::Status { job } | Action::Cancel { job } => {
            let record = owned(authority.job(job), owner)?;
            if record.status.job != *job {
                return Err(ErrorCode::NotAuthorized);
            }
            resolved_status(&record.status, owner, policy, authority)?;
        }
    }
    Ok(if replay {
        Admission::Replay
    } else {
        Admission::New
    })
}

pub fn validate_status(value: &JobStatus) -> Check {
    if value.total_bytes.is_some_and(|n| value.completed_bytes > n) {
        return Err(ErrorCode::InvalidState);
    }
    let valid = match (&value.state, &value.kind, &value.outcome) {
        (JobState::Queued | JobState::Running, _, None) => true,
        (JobState::Succeeded, JobKind::Upload, Some(Outcome::Committed))
        | (JobState::Succeeded, JobKind::Restore, Some(Outcome::Restored)) => {
            value.total_bytes == Some(value.completed_bytes)
        }
        (
            JobState::Failed,
            _,
            Some(
                Outcome::IrrecoverableKey
                | Outcome::IntegrityFailure
                | Outcome::Unavailable
                | Outcome::CleanupRequired,
            ),
        ) => true,
        (
            JobState::Cancelled,
            _,
            Some(Outcome::CancelledBeforeCommit | Outcome::CleanupRequired),
        ) => true,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ErrorCode::InvalidState)
    }
}

fn status_length(value: &JobStatus, length: u64) -> Check {
    if value.completed_bytes > length || value.total_bytes.is_some_and(|n| n != length) {
        return Err(ErrorCode::InvalidState);
    }
    Ok(())
}

fn resolved_status(
    value: &JobStatus,
    owner: &Owner,
    policy: &Policy,
    authority: &impl Authority,
) -> Check {
    validate_status(value)?;
    let record = authority.object(&value.target);
    // An unfinished upload may not have published its immutable generation yet.
    if record.is_none() && value.kind == JobKind::Upload && value.state != JobState::Succeeded {
        return Ok(());
    }
    let object = checked_object(owned(record, owner)?, &value.target, policy)?;
    status_length(value, object.ciphertext.length)
}

pub fn validate_status_transition(before: &JobStatus, after: &JobStatus) -> Check {
    validate_status(before)?;
    validate_status(after)?;
    if before.job != after.job
        || before.target != after.target
        || before.kind != after.kind
        || after.completed_bytes < before.completed_bytes
        || before.total_bytes.is_some() && before.total_bytes != after.total_bytes
        || matches!(before.state, JobState::Running) && matches!(after.state, JobState::Queued)
        || matches!(
            before.state,
            JobState::Succeeded | JobState::Failed | JobState::Cancelled
        ) && before != after
    {
        return Err(ErrorCode::InvalidState);
    }
    Ok(())
}

/// Re-resolve a scoped handle on each delivery; never reinterpret it as latest G.
pub fn validate_transfer(
    handle: &Opaque,
    request: &Request,
    owner: &Owner,
    policy: &Policy,
    authority: &impl Authority,
    now: u64,
) -> Check {
    validate_request(request, owner, policy, authority, now)?;
    let Action::Download(expected) = &request.action else {
        return Err(ErrorCode::InvalidState);
    };
    let selected = session(request, owner, policy, authority, now)?;
    let record = owned(authority.transfer(handle), owner)?;
    let object = resolved_object(&expected.target, owner, &selected, policy, authority)?;
    if record.handle != *handle
        || record.object != object
        || record.range != expected.range
        || record.expires_at <= now
    {
        return Err(ErrorCode::GenerationMismatch);
    }
    let bytes = range_bytes(expected.range.as_ref(), object.ciphertext.length)?;
    if expected.max_bytes == 0
        || expected.max_bytes > selected.limits.transfer_bytes
        || bytes > expected.max_bytes
    {
        return Err(ErrorCode::LimitExceeded);
    }
    Ok(())
}

struct MessageBudget(usize);

impl std::io::Write for MessageBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| std::io::Error::other("message limit exceeded"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Checks outbound consistency before serialization. Issued handles/jobs must be
/// durably bound by the adapter BEFORE publication; this function cannot do so.
pub fn validate_response(
    request: &Request,
    response: &Response,
    owner: &Owner,
    policy: &Policy,
    authority: &impl Authority,
    now: u64,
) -> Check {
    serde_json::to_writer(MessageBudget(MAX_MESSAGE_BYTES), response)
        .map_err(|_| ErrorCode::LimitExceeded)?;
    let admission = validate_request(request, owner, policy, authority, now);
    if response.version != VERSION
        || response.scope != request.scope
        || response.request_id != request.request_id
    {
        return Err(ErrorCode::ReplayConflict);
    }
    if let ResponseBody::Error(code) = response.body {
        return match admission {
            Err(expected) if code != expected => Err(ErrorCode::InvalidState),
            _ => Ok(()),
        };
    }
    admission?;
    if let (Action::Capabilities(offer), ResponseBody::Capabilities(value)) =
        (&request.action, &response.body)
    {
        return validate_selection(offer, value, policy);
    }
    let selected = session(request, owner, policy, authority, now)?;
    let object_check = |object: &Object| -> Check {
        ciphertext(&object.ciphertext, &selected, policy)?;
        metadata(&object.metadata)
    };
    match (&request.action, &response.body) {
        (Action::InitiateUpload(value), ResponseBody::Upload { received_bytes, .. })
            if *received_bytes == 0 =>
        {
            intent(value, &selected, policy)
        }
        (
            Action::ResumeUpload(value),
            ResponseBody::Upload {
                upload,
                received_bytes,
            },
        ) => {
            let record = owned(authority.upload(&value.upload), owner)?;
            if upload != &value.upload || received_bytes != &record.received_bytes {
                return Err(ErrorCode::InvalidState);
            }
            Ok(())
        }
        (Action::CommitUpload(value), ResponseBody::Committed(object)) => {
            object_check(object)?;
            if object.target.object != value.intent.object
                || object.ciphertext != value.intent.ciphertext
                || object.metadata != value.intent.metadata
                || matches!(&value.intent.precondition, Precondition::Matches(g) if g == &object.target.g)
                || owned(authority.committed_upload(&value.upload), owner)? != *object
            {
                return Err(ErrorCode::GenerationMismatch);
            }
            Ok(())
        }
        (Action::AbortUpload(value), ResponseBody::Aborted(outcome)) => {
            let record = owned(authority.upload(&value.upload), owner)?;
            if record.committed != matches!(outcome, CancelOutcome::AlreadyCommitted)
                || record.abort_outcome.as_ref() != Some(outcome)
            {
                return Err(ErrorCode::InvalidState);
            }
            Ok(())
        }
        (Action::Cancel { job }, ResponseBody::Cancel(outcome)) => {
            let record = owned(authority.job(job), owner)?;
            let status = &record.status;
            if record.cleanup_required {
                return if *outcome == CancelOutcome::CleanupRequired {
                    Ok(())
                } else {
                    Err(ErrorCode::InvalidState)
                };
            }
            let valid = match outcome {
                CancelOutcome::Requested => {
                    matches!(status.state, JobState::Queued | JobState::Running)
                }
                CancelOutcome::CancelledBeforeCommit => {
                    status.outcome == Some(Outcome::CancelledBeforeCommit)
                }
                CancelOutcome::AlreadyCommitted => {
                    matches!(status.outcome, Some(Outcome::Committed | Outcome::Restored))
                }
                CancelOutcome::CleanupRequired => false,
                CancelOutcome::AlreadyFinished => {
                    matches!(status.state, JobState::Failed | JobState::Cancelled)
                }
            };
            if valid {
                Ok(())
            } else {
                Err(ErrorCode::InvalidState)
            }
        }
        (Action::Browse(value), ResponseBody::Browse { entries, cursor }) => {
            if entries.len() > usize::from(value.page_entries) {
                return Err(ErrorCode::LimitExceeded);
            }
            for entry in entries {
                object_check(entry)?;
                let expected = owned(
                    authority.listed_object(&value.container, &entry.target),
                    owner,
                )?;
                if expected != *entry {
                    return Err(ErrorCode::GenerationMismatch);
                }
            }
            if let Some(id) = cursor {
                let next = owned(authority.cursor(id), owner)?;
                if next.container != value.container
                    || next.page_entries != value.page_entries
                    || next.expires_at <= now
                {
                    return Err(ErrorCode::ReplayConflict);
                }
            }
            Ok(())
        }
        (Action::Stat(target), ResponseBody::Stat(object)) => {
            let expected = resolved_object(target, owner, &selected, policy, authority)?;
            if expected != *object {
                return Err(ErrorCode::GenerationMismatch);
            }
            Ok(())
        }
        (Action::Download(value), ResponseBody::Download(handle)) => {
            let expected = resolved_object(&value.target, owner, &selected, policy, authority)?;
            if handle.object != expected || handle.range != value.range || handle.expires_at <= now
            {
                return Err(ErrorCode::GenerationMismatch);
            }
            Ok(())
        }
        (Action::Restore(value), ResponseBody::Restore(status)) => {
            validate_status(status)?;
            if status.target != value.target || status.kind != JobKind::Restore {
                return Err(ErrorCode::GenerationMismatch);
            }
            let expected = resolved_object(&value.target, owner, &selected, policy, authority)?;
            status_length(status, expected.ciphertext.length)?;
            let record = owned(authority.job(&status.job), owner)?;
            if record.status != *status {
                return Err(ErrorCode::InvalidState);
            }
            Ok(())
        }
        (Action::Status { job }, ResponseBody::Status(status)) => {
            let before = owned(authority.job(job), owner)?;
            validate_status_transition(&before.status, status)?;
            resolved_status(status, owner, policy, authority)
        }
        _ => Err(ErrorCode::InvalidState),
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for ErrorCode {}
