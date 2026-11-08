use super::{Operation, Request};

pub const VERSION: u16 = 1;
pub const MAX_TOKEN_BYTES: usize = 128;
pub const MAX_PAGE_SIZE: u64 = 100;
pub const MAX_FIELDS: usize = 12;

/// An opaque logical identity, never a global content hash or provider locator.
/// Syntax validation is not proof of authority, encryption or unguessability.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Opaque(String);

impl Opaque {
    pub fn new(value: impl Into<String>) -> Result<Self, Failure> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_TOKEN_BYTES
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            return Err(Failure::new(ErrorCode::InvalidInput));
        }
        Ok(Self(value))
    }

    /// Only the authority/serializer should expose identities to their authorized caller.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Opaque {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Opaque([redacted])")
    }
}

/// Trusted authentication-adapter input, never deserialized from operation fields.
/// Construct only after credential validation; the port still checks current ACLs.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Scope {
    pub tenant: Opaque,
    pub principal: Opaque,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogicalReference {
    pub reference: Opaque,
    pub generation: Opaque,
}

/// Deliberately no recursive values, byte bodies, keys or caller-supplied scope.
/// The eventual wire adapter must also bound raw bytes/depth and reject duplicate
/// JSON keys before constructing these fields. The Vec retains duplicates here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Text(String),
    Number(u64),
    Flag(bool),
}
pub type Fields = Vec<(String, Value)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Unauthenticated,
    Denied,
    InvalidInput,
    Unsupported,
    PreconditionFailed,
    Conflict,
    QuotaExceeded,
    InvalidCursor,
    NotAvailable,
    NotReady,
    Cancelled,
    IntegrityFailed,
    Unavailable,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effects {
    None,
    Accepted,
    Committed,
    Unknown,
}

/// No backend exception strings, locations, keys or tenant IDs in public errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: ErrorCode,
    pub effects: Effects,
}

impl Failure {
    pub const fn new(code: ErrorCode) -> Self {
        Self {
            code,
            effects: Effects::None,
        }
    }
    pub fn retryable(self) -> bool {
        matches!(self.code, ErrorCode::Unavailable | ErrorCode::QuotaExceeded)
    }
    pub fn reconciliation_required(self) -> bool {
        self.effects != Effects::None
    }
    pub fn message(self) -> &'static str {
        match self.code {
            ErrorCode::Unauthenticated => "Authentication required",
            ErrorCode::Denied => "Operation not authorized",
            ErrorCode::InvalidInput => "Invalid operation input",
            ErrorCode::Unsupported => "Feature not implemented",
            ErrorCode::PreconditionFailed => "Precondition failed",
            ErrorCode::Conflict => "Operation conflicts with current state",
            ErrorCode::QuotaExceeded => "Resource policy denied admission",
            ErrorCode::InvalidCursor => "Invalid or expired cursor",
            ErrorCode::NotAvailable => "Reference not available for download",
            ErrorCode::NotReady => "Result not ready",
            ErrorCode::Cancelled => "Operation cancelled",
            ErrorCode::IntegrityFailed => "Integrity verification failed",
            ErrorCode::Unavailable => "Service temporarily unavailable",
            ErrorCode::Internal => "Operation failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgressUnit {
    Bytes,
    Objects,
    Steps,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Progress {
    unit: ProgressUnit,
    completed: u64,
    total: Option<u64>,
}

impl Progress {
    pub fn new(unit: ProgressUnit, total: Option<u64>) -> Self {
        Self {
            unit,
            completed: 0,
            total,
        }
    }
    pub fn unit(&self) -> ProgressUnit {
        self.unit
    }
    pub fn completed(&self) -> u64 {
        self.completed
    }
    pub fn total(&self) -> Option<u64> {
        self.total
    }

    /// Unit and declared total cannot change. Unknown is not zero or 100 percent.
    /// Persist updates with the authority's monotonic sequence/fence across restart.
    pub fn advance(&mut self, completed: u64) -> Result<(), Failure> {
        if completed < self.completed || self.total.is_some_and(|total| completed > total) {
            return Err(Failure::new(ErrorCode::Conflict));
        }
        self.completed = completed;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
    pub fn permits(self, next: Self) -> bool {
        self == next
            || matches!(
                (self, next),
                (
                    Self::Queued,
                    Self::Running | Self::CancelRequested | Self::Cancelled | Self::Failed
                ) | (
                    Self::Running,
                    Self::CancelRequested | Self::Succeeded | Self::Failed
                ) | (
                    Self::CancelRequested,
                    Self::Cancelled | Self::Succeeded | Self::Failed
                )
            )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    Requested,
    StoppedBeforeCommit,
    AlreadyCommitted,
    AlreadyTerminal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub handle: Opaque,
    pub target: LogicalReference,
    pub state: JobState,
    pub progress: Progress,
    pub effects: Effects,
    pub error: Option<Failure>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub handle: Opaque,
    pub target: LogicalReference,
    pub direction: TransferDirection,
    /// Absolute authority-defined expiry; polling never extends it.
    pub expires_at: u64,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub target: LogicalReference,
    pub bytes: u64,
    /// Logical availability lease, not evidence of a physical cache hit.
    pub available: bool,
}

/// This closed enum is the output schema. No arbitrary JSON/exception payloads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Output {
    Capabilities {
        version: u16,
        operations: Vec<Operation>,
        experimental_tasks: bool,
    },
    Upload {
        transfer: Transfer,
        job: Job,
    },
    Job(Job),
    Page {
        entries: Vec<Entry>,
        cursor: Option<Opaque>,
    },
    Stat(Entry),
    Download(Transfer),
    Result {
        job: Job,
        reference: LogicalReference,
    },
    Cancel {
        job: Job,
        outcome: CancelOutcome,
    },
}

impl Output {
    pub(crate) fn within_bounds(&self, request: &Request) -> bool {
        match self {
            Self::Page { entries, .. } => {
                entries.len() as u64 <= request.number("limit").unwrap_or(0)
            }
            Self::Job(job)
            | Self::Cancel { job, .. }
            | Self::Result { job, .. }
            | Self::Upload { job, .. } => {
                let handle_matches = request.opaque("job").is_none_or(|id| id == &job.handle);
                let creates_generation = matches!(
                    request.operation(),
                    Operation::InitiateUpload | Operation::Copy
                );
                let target_matches = request
                    .opaque("reference")
                    .is_none_or(|id| id == &job.target.reference)
                    && request.opaque("generation").is_none_or(|id| {
                        if creates_generation {
                            id != &job.target.generation
                        } else {
                            id == &job.target.generation
                        }
                    });
                let error_matches = (job.state == JobState::Failed) == job.error.is_some();
                let shape_matches = match self {
                    Self::Upload { transfer, .. } => {
                        transfer.direction == TransferDirection::Upload
                            && transfer.target == job.target
                            && Some(transfer.max_bytes) == request.number("max_bytes")
                    }
                    Self::Result { reference, .. } => {
                        job.state == JobState::Succeeded && reference == &job.target
                    }
                    Self::Cancel { outcome, .. } => match outcome {
                        CancelOutcome::Requested => job.state == JobState::CancelRequested,
                        CancelOutcome::StoppedBeforeCommit => {
                            job.state == JobState::Cancelled && job.effects == Effects::None
                        }
                        CancelOutcome::AlreadyCommitted => job.effects == Effects::Committed,
                        CancelOutcome::AlreadyTerminal => job.state.terminal(),
                    },
                    _ => true,
                };
                handle_matches && target_matches && error_matches && shape_matches
            }
            Self::Stat(entry) => request.matches_target(&entry.target),
            Self::Download(transfer) => {
                transfer.direction == TransferDirection::Download
                    && request.matches_target(&transfer.target)
            }
            Self::Capabilities { .. } => true,
        }
    }
}
