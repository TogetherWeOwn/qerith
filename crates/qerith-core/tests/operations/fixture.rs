//! Synthetic contract authority only: not a database or durability implementation.
use qerith_core::operations::*;
use std::collections::BTreeMap;

pub fn id(text: &str) -> Opaque {
    Opaque::new(text).unwrap()
}
pub fn scope(tenant: &str) -> Scope {
    Scope {
        tenant: id(tenant),
        principal: id("reader"),
    }
}
pub fn target(reference: &str, generation: &str) -> LogicalReference {
    LogicalReference {
        reference: id(reference),
        generation: id(generation),
    }
}
pub fn text(name: &str, value: &str) -> (String, Value) {
    (name.into(), Value::Text(value.into()))
}
pub fn num(name: &str, value: u64) -> (String, Value) {
    (name.into(), Value::Number(value))
}
pub fn args(operation: Operation) -> Fields {
    match operation {
        Operation::Capabilities => vec![],
        Operation::InitiateUpload => vec![
            text("reference", "new"),
            ("if_absent".into(), Value::Flag(true)),
            num("max_bytes", 64),
            text("identity", "init"),
        ],
        Operation::CommitUpload | Operation::AbortUpload => vec![
            text("reference", "new"),
            text("generation", "g2"),
            text("transfer", "upload1"),
            text("identity", "finish"),
        ],
        Operation::Browse => vec![text("parent", "root"), num("limit", 1)],
        Operation::Status | Operation::Result => vec![text("job", "restorejob")],
        Operation::Cancel => vec![text("job", "restorejob"), text("identity", "stop")],
        Operation::Copy => vec![
            text("source", "object"),
            text("source_generation", "g1"),
            text("reference", "new"),
            ("if_absent".into(), Value::Flag(true)),
            text("identity", "copy"),
        ],
        Operation::Versions => vec![text("reference", "object")],
        other => {
            let mut fields = vec![text("reference", "object"), text("generation", "g1")];
            if other != Operation::Stat {
                fields.push(text("identity", "effect"));
            }
            if other == Operation::Restore {
                fields.push(num("availability_seconds", 60));
            }
            fields
        }
    }
}

#[derive(Clone)]
pub struct UploadRecord {
    transfer: Transfer,
    job: Opaque,
    initiation: Request,
    committed: bool,
}

#[derive(Clone)]
pub struct Fixture {
    pub objects: BTreeMap<(Opaque, Opaque), Entry>,
    pub parents: BTreeMap<(Scope, Opaque), Vec<Opaque>>,
    pub jobs: BTreeMap<(Scope, Opaque), Job>,
    pub uploads: BTreeMap<(Scope, Opaque), UploadRecord>,
    pub replay: BTreeMap<Reconciliation, (Request, Output)>,
    pub cursors: BTreeMap<Opaque, (Scope, Request, Opaque)>,
    pub denied: bool,
    pub quota: bool,
    pub injected: Option<Failure>,
    pub trace: Vec<&'static str>,
    pub effects: usize,
    pub sequence: u64,
}

impl Default for Fixture {
    fn default() -> Self {
        let mut fixture = Self {
            objects: BTreeMap::new(),
            parents: BTreeMap::new(),
            jobs: BTreeMap::new(),
            uploads: BTreeMap::new(),
            replay: BTreeMap::new(),
            cursors: BTreeMap::new(),
            denied: false,
            quota: false,
            injected: None,
            trace: vec![],
            effects: 0,
            sequence: 0,
        };
        fixture.objects.insert(
            (id("a"), id("object")),
            Entry {
                target: target("object", "g1"),
                bytes: 64,
                available: true,
            },
        );
        fixture
            .parents
            .insert((scope("a"), id("root")), vec![id("object")]);
        fixture.parents.insert((scope("a"), id("another")), vec![]);
        fixture.parents.insert((scope("b"), id("root")), vec![]);
        fixture.jobs.insert(
            (scope("a"), id("restorejob")),
            Job {
                handle: id("restorejob"),
                target: target("object", "g1"),
                state: JobState::Running,
                progress: Progress::new(ProgressUnit::Bytes, None),
                effects: Effects::Accepted,
                error: None,
            },
        );
        fixture
    }
}

impl Fixture {
    // Deterministic unique tokens for synthetic data only. Production issuance
    // must be unpredictable and survive authority restart without identity reuse.
    fn next(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    fn replayed(&self, scope: &Scope, request: &Request) -> Result<Option<Output>, Failure> {
        match request
            .reconciliation(scope)
            .and_then(|k| self.replay.get(&k))
        {
            Some((previous, output)) if previous == request => Ok(Some(output.clone())),
            Some(_) => Err(Failure::new(ErrorCode::Conflict)),
            None => Ok(None),
        }
    }

    fn job(&self, scope: &Scope, request: &Request) -> Job {
        self.jobs[&(scope.clone(), request.opaque("job").unwrap().clone())].clone()
    }

    fn check_authority(&self, scope: &Scope, request: &Request) -> Result<(), Failure> {
        let denied = Failure::new(ErrorCode::Denied);
        if self.denied {
            return Err(denied);
        }
        if let Some(parent) = request.opaque("parent") {
            if !self.parents.contains_key(&(scope.clone(), parent.clone())) {
                return Err(denied);
            }
        }
        if let Some(job) = request.opaque("job") {
            if !self.jobs.contains_key(&(scope.clone(), job.clone())) {
                return Err(denied);
            }
        }
        if let Some(transfer) = request.opaque("transfer") {
            let upload = self
                .uploads
                .get(&(scope.clone(), transfer.clone()))
                .ok_or(denied)?;
            if !request.matches_target(&upload.transfer.target) {
                return Err(denied);
            }
        }
        for field in ["reference", "source"] {
            if let Some(reference) = request.opaque(field) {
                let destination = field == "reference"
                    && matches!(
                        request.operation(),
                        Operation::InitiateUpload | Operation::Copy
                    );
                let upload = request.opaque("transfer").is_some();
                if !destination
                    && !upload
                    && !self
                        .objects
                        .contains_key(&(scope.tenant.clone(), reference.clone()))
                {
                    return Err(denied);
                }
            }
        }
        Ok(())
    }

    fn check_destination(&self, scope: &Scope, request: &Request) -> Result<(), Failure> {
        if let Some(reference) = request.opaque("reference") {
            let existing = self.objects.get(&(scope.tenant.clone(), reference.clone()));
            if request.if_absent() && existing.is_some() {
                return Err(Failure::new(ErrorCode::PreconditionFailed));
            }
            if let Some(generation) = request.opaque("generation") {
                if existing.map(|e| &e.target.generation) != Some(generation) {
                    return Err(Failure::new(ErrorCode::PreconditionFailed));
                }
            }
        }
        Ok(())
    }

    fn check_preconditions(&self, scope: &Scope, request: &Request) -> Result<(), Failure> {
        if self.replayed(scope, request)?.is_some() {
            return Ok(());
        }
        if let Some(transfer) = request.opaque("transfer") {
            let upload = &self.uploads[&(scope.clone(), transfer.clone())];
            if request.operation() == Operation::CommitUpload {
                if upload.committed {
                    return Err(Failure {
                        code: ErrorCode::Conflict,
                        effects: Effects::Committed,
                    });
                }
                if self.jobs[&(scope.clone(), upload.job.clone())].state == JobState::Cancelled {
                    return Err(Failure::new(ErrorCode::Conflict));
                }
                self.check_destination(scope, &upload.initiation)?;
            }
        } else {
            self.check_destination(scope, request)?;
        }
        if let Some(source) = request.opaque("source") {
            let entry = &self.objects[&(scope.tenant.clone(), source.clone())];
            if Some(&entry.target.generation) != request.opaque("source_generation") {
                return Err(Failure::new(ErrorCode::PreconditionFailed));
            }
            if !entry.available {
                return Err(Failure::new(ErrorCode::NotAvailable));
            }
        }
        Ok(())
    }

    /// Explicit authority completion, not a scheduler or a poll-driven side effect.
    pub fn complete(&mut self, scope: &Scope, handle: &str) {
        let job = self.jobs.get_mut(&(scope.clone(), id(handle))).unwrap();
        assert!(job.state.permits(JobState::Succeeded));
        job.state = JobState::Succeeded;
        job.effects = Effects::Committed;
    }
}

impl OperationPort for Fixture {
    fn authorize(&mut self, scope: &Scope, request: &Request) -> Result<(), Failure> {
        self.trace.push("authorize");
        self.check_authority(scope, request)
    }
    fn preconditions(&mut self, scope: &Scope, request: &Request) -> Result<(), Failure> {
        self.trace.push("preconditions");
        self.check_preconditions(scope, request)
    }
    fn admit(&mut self, _: &Scope, _: &Request) -> Result<(), Failure> {
        self.trace.push("admit");
        if self.quota {
            Err(Failure::new(ErrorCode::QuotaExceeded))
        } else {
            Ok(())
        }
    }
    fn resolve_cursor(
        &mut self,
        scope: &Scope,
        request: &Request,
        cursor: &Opaque,
    ) -> Result<Opaque, Failure> {
        self.trace.push("cursor");
        let (owner, query, position) = self
            .cursors
            .get(cursor)
            .ok_or(Failure::new(ErrorCode::InvalidCursor))?;
        if owner != scope
            || query.operation() != request.operation()
            || query.opaque("parent") != request.opaque("parent")
            || query.number("limit") != request.number("limit")
        {
            return Err(Failure::new(ErrorCode::InvalidCursor));
        }
        Ok(position.clone())
    }
    fn execute(
        &mut self,
        scope: &Scope,
        request: &Request,
        position: Option<&Opaque>,
    ) -> Result<Output, Failure> {
        self.trace.push("execute");
        // This fixture is single-threaded. Real adapters need one transaction/fence,
        // including replay after current authorization, not these separate maps.
        self.check_authority(scope, request)?;
        if let Some(output) = self.replayed(scope, request)? {
            return Ok(output);
        }
        self.check_preconditions(scope, request)?;
        if self.quota {
            return Err(Failure::new(ErrorCode::QuotaExceeded));
        }
        if let Some(failure) = self.injected {
            return Err(failure);
        }
        let operation = request.operation();
        let output = match operation {
            Operation::InitiateUpload => {
                let sequence = self.next();
                let target = LogicalReference {
                    reference: request.opaque("reference").unwrap().clone(),
                    generation: id(&format!("g{}", sequence + 1)),
                };
                let job = Job {
                    handle: id(&format!("uploadjob{sequence}")),
                    target: target.clone(),
                    state: JobState::Queued,
                    progress: Progress::new(ProgressUnit::Bytes, None),
                    effects: Effects::Accepted,
                    error: None,
                };
                let transfer = Transfer {
                    handle: id(&format!("upload{sequence}")),
                    target,
                    direction: TransferDirection::Upload,
                    expires_at: 1000,
                    max_bytes: request.number("max_bytes").unwrap(),
                };
                self.uploads.insert(
                    (scope.clone(), transfer.handle.clone()),
                    UploadRecord {
                        transfer: transfer.clone(),
                        job: job.handle.clone(),
                        initiation: request.clone(),
                        committed: false,
                    },
                );
                self.jobs
                    .insert((scope.clone(), job.handle.clone()), job.clone());
                Output::Upload { transfer, job }
            }
            Operation::CommitUpload | Operation::AbortUpload => {
                let upload = self
                    .uploads
                    .get_mut(&(scope.clone(), request.opaque("transfer").unwrap().clone()))
                    .unwrap();
                let job = self
                    .jobs
                    .get_mut(&(scope.clone(), upload.job.clone()))
                    .unwrap();
                if operation == Operation::CommitUpload {
                    upload.committed = true;
                    job.state = JobState::Succeeded;
                    job.effects = Effects::Committed;
                    self.objects.insert(
                        (scope.tenant.clone(), job.target.reference.clone()),
                        Entry {
                            target: job.target.clone(),
                            bytes: upload.transfer.max_bytes,
                            available: false,
                        },
                    );
                    let members = self.parents.entry((scope.clone(), id("root"))).or_default();
                    if !members.contains(&job.target.reference) {
                        members.push(job.target.reference.clone());
                    }
                    Output::Job(job.clone())
                } else {
                    let outcome = if upload.committed {
                        CancelOutcome::AlreadyCommitted
                    } else {
                        job.state = JobState::Cancelled;
                        job.effects = Effects::None;
                        CancelOutcome::StoppedBeforeCommit
                    };
                    Output::Cancel {
                        job: job.clone(),
                        outcome,
                    }
                }
            }
            Operation::Stat => Output::Stat(
                self.objects[&(
                    scope.tenant.clone(),
                    request.opaque("reference").unwrap().clone(),
                )]
                    .clone(),
            ),
            Operation::Browse => {
                let members =
                    &self.parents[&(scope.clone(), request.opaque("parent").unwrap().clone())];
                let entries: Vec<_> = self
                    .objects
                    .iter()
                    .filter(|((tenant, reference), _)| {
                        tenant == &scope.tenant
                            && members.contains(reference)
                            && position.is_none_or(|p| reference > p)
                    })
                    .map(|(_, e)| e.clone())
                    .take(request.number("limit").unwrap() as usize)
                    .collect();
                let cursor = entries.last().map(|e| {
                    let cursor = id(&format!("pagecursor{}", self.next()));
                    self.cursors.insert(
                        cursor.clone(),
                        (scope.clone(), request.clone(), e.target.reference.clone()),
                    );
                    cursor
                });
                Output::Page { entries, cursor }
            }
            Operation::AuthorizeDownload => {
                let entry = self.objects[&(
                    scope.tenant.clone(),
                    request.opaque("reference").unwrap().clone(),
                )]
                    .clone();
                if !entry.available {
                    return Err(Failure::new(ErrorCode::NotAvailable));
                }
                Output::Download(Transfer {
                    handle: id(&format!("download{}", self.next())),
                    target: entry.target,
                    direction: TransferDirection::Download,
                    expires_at: 1000,
                    max_bytes: entry.bytes,
                })
            }
            Operation::Status => Output::Job(self.job(scope, request)),
            Operation::Result => {
                let job = self.job(scope, request);
                match job.state {
                    JobState::Succeeded => Output::Result {
                        reference: job.target.clone(),
                        job,
                    },
                    JobState::Cancelled => {
                        return Err(Failure {
                            code: ErrorCode::Cancelled,
                            effects: job.effects,
                        })
                    }
                    JobState::Failed => {
                        return Err(job.error.unwrap_or(Failure {
                            code: ErrorCode::Internal,
                            effects: job.effects,
                        }))
                    }
                    _ => return Err(Failure::new(ErrorCode::NotReady)),
                }
            }
            Operation::Cancel => {
                let mut job = self.job(scope, request);
                let outcome = if job.effects == Effects::Committed {
                    CancelOutcome::AlreadyCommitted
                } else if job.state.terminal() {
                    CancelOutcome::AlreadyTerminal
                } else {
                    job.state = JobState::CancelRequested;
                    CancelOutcome::Requested
                };
                self.jobs
                    .insert((scope.clone(), job.handle.clone()), job.clone());
                Output::Cancel { job, outcome }
            }
            Operation::Restore | Operation::Copy | Operation::Delete => {
                let sequence = self.next();
                let reference = request.opaque("reference").unwrap().clone();
                let generation = if operation == Operation::Copy {
                    id(&format!("g{}", sequence + 1))
                } else {
                    request.opaque("generation").unwrap().clone()
                };
                let job = Job {
                    handle: id(&format!("mutationjob{sequence}")),
                    target: LogicalReference {
                        reference,
                        generation,
                    },
                    state: JobState::Queued,
                    progress: Progress::new(ProgressUnit::Steps, None),
                    effects: Effects::Accepted,
                    error: None,
                };
                self.jobs
                    .insert((scope.clone(), job.handle.clone()), job.clone());
                Output::Job(job)
            }
            _ => return Err(Failure::new(ErrorCode::Unsupported)),
        };
        if let Some(key) = request.reconciliation(scope) {
            self.effects += 1;
            self.replay.insert(key, (request.clone(), output.clone()));
        }
        Ok(output)
    }
}
