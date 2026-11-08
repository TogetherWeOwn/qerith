use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Operation {
    Capabilities,
    InitiateUpload,
    CommitUpload,
    AbortUpload,
    Browse,
    Stat,
    AuthorizeDownload,
    Restore,
    Status,
    Result,
    Cancel,
    Copy,
    Delete,
    Versions,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    Opaque,
    Number { min: u64, max: u64 },
    True,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: &'static str,
    pub kind: FieldKind,
    pub required: bool,
}

const fn token(name: &'static str, required: bool) -> Field {
    Field {
        name,
        kind: FieldKind::Opaque,
        required,
    }
}
const fn number(name: &'static str, min: u64, max: u64) -> Field {
    Field {
        name,
        kind: FieldKind::Number { min, max },
        required: true,
    }
}
const REF: Field = token("reference", true);
const GEN: Field = token("generation", true);
const ID: Field = token("identity", true);
const JOB: Field = token("job", true);
const TRANSFER: Field = token("transfer", true);
const ABSENT: Field = Field {
    name: "if_absent",
    kind: FieldKind::True,
    required: false,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputSchema {
    Capabilities,
    Upload,
    Job,
    Page,
    Stat,
    Download,
    Result,
    Cancel,
}

impl OutputSchema {
    pub fn accepts(self, output: &Output) -> bool {
        matches!(
            (self, output),
            (Self::Capabilities, Output::Capabilities { .. })
                | (Self::Upload, Output::Upload { .. })
                | (Self::Job, Output::Job(_))
                | (Self::Page, Output::Page { .. })
                | (Self::Stat, Output::Stat(_))
                | (Self::Download, Output::Download(_))
                | (Self::Result, Output::Result { .. })
                | (Self::Cancel, Output::Cancel { .. })
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectClass {
    ReadOnly,
    TransferAuthorization,
    DurableMutation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preconditions {
    None,
    ExactGeneration,
    DestinationFence,
    UploadOpen,
    JobScope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Definition {
    pub operation: Operation,
    pub name: &'static str,
    pub input: &'static [Field],
    pub output: OutputSchema,
    pub preconditions: Preconditions,
    pub effects: EffectClass,
    pub implemented: bool,
}

// One list supplies capabilities, REST routes, MCP tools and input/output shapes.
// Numbers here bound the contract, not a qualified production size/entitlement.
// Production admission must supply stricter, measured byte/lifetime/cost limits.
pub static REGISTRY: &[Definition] = &[
    Definition {
        operation: Operation::Capabilities,
        name: "capabilities",
        input: &[],
        output: OutputSchema::Capabilities,
        preconditions: Preconditions::None,
        effects: EffectClass::ReadOnly,
        implemented: true,
    },
    Definition {
        operation: Operation::InitiateUpload,
        name: "upload_initiate",
        input: &[
            REF,
            token("generation", false),
            ABSENT,
            number("max_bytes", 0, u64::MAX),
            ID,
        ],
        output: OutputSchema::Upload,
        preconditions: Preconditions::DestinationFence,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::CommitUpload,
        name: "upload_commit",
        input: &[TRANSFER, REF, GEN, ID],
        output: OutputSchema::Job,
        preconditions: Preconditions::UploadOpen,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::AbortUpload,
        name: "upload_abort",
        input: &[TRANSFER, REF, GEN, ID],
        output: OutputSchema::Cancel,
        preconditions: Preconditions::UploadOpen,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::Browse,
        name: "browse",
        input: &[
            token("parent", true),
            token("cursor", false),
            number("limit", 1, MAX_PAGE_SIZE),
        ],
        output: OutputSchema::Page,
        preconditions: Preconditions::None,
        effects: EffectClass::ReadOnly,
        implemented: true,
    },
    Definition {
        operation: Operation::Stat,
        name: "stat",
        input: &[REF, GEN],
        output: OutputSchema::Stat,
        preconditions: Preconditions::ExactGeneration,
        effects: EffectClass::ReadOnly,
        implemented: true,
    },
    Definition {
        operation: Operation::AuthorizeDownload,
        name: "download_authorize",
        input: &[REF, GEN, ID],
        output: OutputSchema::Download,
        preconditions: Preconditions::ExactGeneration,
        effects: EffectClass::TransferAuthorization,
        implemented: true,
    },
    Definition {
        operation: Operation::Restore,
        name: "restore",
        input: &[
            REF,
            GEN,
            number("availability_seconds", 1, u32::MAX as u64),
            Field {
                name: "max_seconds",
                kind: FieldKind::Number {
                    min: 1,
                    max: u32::MAX as u64,
                },
                required: false,
            },
            ID,
        ],
        output: OutputSchema::Job,
        preconditions: Preconditions::ExactGeneration,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::Status,
        name: "status",
        input: &[JOB],
        output: OutputSchema::Job,
        preconditions: Preconditions::JobScope,
        effects: EffectClass::ReadOnly,
        implemented: true,
    },
    Definition {
        operation: Operation::Result,
        name: "result",
        input: &[JOB],
        output: OutputSchema::Result,
        preconditions: Preconditions::JobScope,
        effects: EffectClass::ReadOnly,
        implemented: true,
    },
    Definition {
        operation: Operation::Cancel,
        name: "cancel",
        input: &[JOB, ID],
        output: OutputSchema::Cancel,
        preconditions: Preconditions::JobScope,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::Copy,
        name: "copy",
        input: &[
            token("source", true),
            token("source_generation", true),
            REF,
            token("generation", false),
            ABSENT,
            ID,
        ],
        output: OutputSchema::Job,
        preconditions: Preconditions::DestinationFence,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::Delete,
        name: "delete",
        input: &[REF, GEN, ID],
        output: OutputSchema::Job,
        preconditions: Preconditions::ExactGeneration,
        effects: EffectClass::DurableMutation,
        implemented: true,
    },
    Definition {
        operation: Operation::Versions,
        name: "versions",
        input: &[REF],
        output: OutputSchema::Page,
        preconditions: Preconditions::None,
        effects: EffectClass::ReadOnly,
        implemented: false,
    },
];

impl Operation {
    pub fn definition(self) -> &'static Definition {
        REGISTRY
            .iter()
            .find(|d| d.operation == self)
            .expect("all operations have definitions")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ValidatedValue {
    Opaque(Opaque),
    Number(u64),
    True,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    operation: Operation,
    values: BTreeMap<String, ValidatedValue>,
}

impl Request {
    pub fn operation(&self) -> Operation {
        self.operation
    }
    pub fn opaque(&self, name: &str) -> Option<&Opaque> {
        match self.values.get(name) {
            Some(ValidatedValue::Opaque(v)) => Some(v),
            _ => None,
        }
    }
    pub fn number(&self, name: &str) -> Option<u64> {
        match self.values.get(name) {
            Some(ValidatedValue::Number(v)) => Some(*v),
            _ => None,
        }
    }
    pub fn if_absent(&self) -> bool {
        self.values.contains_key("if_absent")
    }
    pub fn matches_target(&self, target: &LogicalReference) -> bool {
        self.opaque("reference") == Some(&target.reference)
            && self.opaque("generation") == Some(&target.generation)
    }

    /// Stable, structured reconciliation key. The authority MUST additionally
    /// compare the entire Request on reuse and return Conflict for changed input.
    /// Do not concatenate raw strings or reuse one identity across principals/ops.
    pub fn reconciliation(&self, scope: &Scope) -> Option<Reconciliation> {
        self.opaque("identity").map(|identity| Reconciliation {
            version: VERSION,
            scope: scope.clone(),
            operation: self.operation,
            identity: identity.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Reconciliation {
    pub version: u16,
    pub scope: Scope,
    pub operation: Operation,
    pub identity: Opaque,
}

impl Definition {
    pub fn validate(&self, fields: Fields) -> Result<Request, Failure> {
        let invalid = Failure::new(ErrorCode::InvalidInput);
        if fields.len() > MAX_FIELDS {
            return Err(invalid);
        }
        let mut values = BTreeMap::new();
        for (name, value) in fields {
            let field = self.input.iter().find(|f| f.name == name).ok_or(invalid)?;
            let value = match (field.kind, value) {
                (FieldKind::Opaque, Value::Text(v)) => ValidatedValue::Opaque(Opaque::new(v)?),
                (FieldKind::Number { min, max }, Value::Number(v)) if v >= min && v <= max => {
                    ValidatedValue::Number(v)
                }
                (FieldKind::True, Value::Flag(true)) => ValidatedValue::True,
                _ => return Err(invalid),
            };
            if values.insert(name, value).is_some() {
                return Err(invalid);
            }
        }
        if self
            .input
            .iter()
            .any(|f| f.required && !values.contains_key(f.name))
        {
            return Err(invalid);
        }
        if self.preconditions == Preconditions::DestinationFence
            && values.contains_key("generation") == values.contains_key("if_absent")
        {
            return Err(invalid);
        }
        Ok(Request {
            operation: self.operation,
            values,
        })
    }
}
