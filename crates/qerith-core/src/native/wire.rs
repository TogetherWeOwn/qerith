use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

pub const VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 65_536;

/// A scoped reference, not a path, URL, key, bearer credential or content proof.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Opaque(String);

impl TryFrom<String> for Opaque {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        {
            return Err("invalid opaque reference");
        }
        Ok(Self(value))
    }
}

impl From<Opaque> for String {
    fn from(value: Opaque) -> Self {
        value.0
    }
}

impl Opaque {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Opaque {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub format: Opaque,
    pub crypto: Opaque,
    pub integrity: Opaque,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub object_bytes: u64,
    pub page_entries: u16,
    pub transfer_bytes: u64,
    pub job_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub versions: Vec<u16>,
    pub profiles: Vec<Profile>,
    pub limits: Limits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub version: u16,
    pub session: Opaque,
    pub profile: Profile,
    pub limits: Limits,
}

/// C and G are distinct: ciphertext identity and immutable catalogue generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ciphertext {
    pub c: Opaque,
    pub length: u64,
    pub checksum_hex: Opaque,
    pub profile: Profile,
    pub key_ref: Opaque,
    pub envelope_ref: Opaque,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub content_type: String,
    pub content_encoding: Option<String>,
    #[serde(deserialize_with = "unique_metadata")]
    pub user: BTreeMap<String, String>,
}

fn unique_metadata<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Unique;
    impl<'de> serde::de::Visitor<'de> for Unique {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a bounded map with unique metadata keys")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if values.len() >= 64
                    || key.len() > 128
                    || value.len() > 1024
                    || values.insert(key, value).is_some()
                {
                    return Err(serde::de::Error::custom("invalid metadata map"));
                }
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(Unique)
}

impl fmt::Debug for Metadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Metadata([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "condition",
    content = "generation",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Precondition {
    Absent,
    Matches(Opaque),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub object: Opaque,
    pub g: Opaque,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadIntent {
    pub object: Opaque,
    pub precondition: Precondition,
    pub ciphertext: Ciphertext,
    pub metadata: Metadata,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadAction {
    pub upload: Opaque,
    pub intent: UploadIntent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Browse {
    pub container: Opaque,
    pub page_entries: u16,
    pub cursor: Option<Opaque>,
}

/// Inclusive ciphertext offsets. No plaintext-range claim is made.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ByteRange {
    pub first: u64,
    pub last: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Download {
    pub target: Target,
    pub range: Option<ByteRange>,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Restore {
    pub target: Target,
    pub max_bytes: u64,
    pub max_seconds: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "op",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Action {
    Capabilities(Offer),
    InitiateUpload(UploadIntent),
    ResumeUpload(UploadAction),
    CommitUpload(UploadAction),
    AbortUpload(UploadAction),
    Browse(Browse),
    Stat(Target),
    Download(Download),
    Restore(Restore),
    Status { job: Opaque },
    Cancel { job: Opaque },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u16,
    pub scope: Opaque,
    pub request_id: Opaque,
    pub session: Option<Opaque>,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Object {
    pub target: Target,
    pub ciphertext: Ciphertext,
    pub metadata: Metadata,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Upload,
    Restore,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Committed,
    Restored,
    CancelledBeforeCommit,
    CleanupRequired,
    AlreadyCommitted,
    IrrecoverableKey,
    IntegrityFailure,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobStatus {
    pub job: Opaque,
    pub target: Target,
    pub kind: JobKind,
    pub state: JobState,
    /// Ciphertext bytes verified in this operation, not provider durability.
    pub completed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub outcome: Option<Outcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelOutcome {
    Requested,
    CancelledBeforeCommit,
    AlreadyCommitted,
    CleanupRequired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferHandle {
    pub handle: Opaque,
    pub object: Object,
    pub range: Option<ByteRange>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "result",
    content = "output",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ResponseBody {
    Capabilities(Selection),
    Upload {
        upload: Opaque,
        received_bytes: u64,
    },
    Committed(Object),
    Aborted(CancelOutcome),
    Browse {
        entries: Vec<Object>,
        cursor: Option<Opaque>,
    },
    Stat(Object),
    Download(TransferHandle),
    Restore(JobStatus),
    Status(JobStatus),
    Cancel(CancelOutcome),
    Error(ErrorCode),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub version: u16,
    pub scope: Opaque,
    pub request_id: Opaque,
    pub body: ResponseBody,
}

/// Intentionally contains no echoed inputs or free-form provider errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Malformed,
    UnsupportedVersion,
    UnsupportedProfile,
    CapabilityDowngrade,
    LimitExceeded,
    NotAuthorized,
    PreconditionFailed,
    ReplayConflict,
    GenerationMismatch,
    InvalidRange,
    InvalidState,
    IrrecoverableKey,
    IntegrityFailure,
    Unavailable,
}
