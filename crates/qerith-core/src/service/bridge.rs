use super::*;
use n::Authority as _;

#[derive(Clone, Default)]
pub(super) struct NativeModel {
    sessions: BTreeMap<(o::Scope, n::Opaque), n::SessionRecord>,
    replay: BTreeMap<(o::Scope, n::Opaque), (n::ReplayRecord, n::ResponseBody)>,
}

/// Explicit worker dependencies; the request transport never owns a scheduler.
pub struct UploadWorker<'a, S, C, P> {
    pub storage: &'a mut S,
    pub budget: &'a flow::Budget,
    pub clock: &'a C,
    pub policy: &'a P,
}

struct View<'a, A> {
    service: &'a Service<A>,
    scope: &'a o::Scope,
}
impl<A: Access> View<'_, A> {
    fn owned<T>(&self, value: T) -> Option<n::Owned<T>> {
        if self.service.tenant(self.scope).is_err() || !self.service.access.admit(self.scope) {
            return None;
        }
        Some(n::Owned {
            owner: owner(self.scope),
            value,
        })
    }
    fn object_value(&self, target: &n::Target) -> Option<n::Object> {
        let target = logical(target).ok()?;
        let view = self.service.exact(self.scope, &target).ok()?;
        Some(
            self.service
                .bound_object(self.scope, &target.reference, &view)
                .ok()?
                .object
                .clone(),
        )
    }
}
fn owner(scope: &o::Scope) -> n::Owner {
    n::Owner {
        scope: native_id(&scope.tenant),
        principal: native_id(&scope.principal),
    }
}
fn logical(target: &n::Target) -> Result<o::LogicalReference, o::Failure> {
    Ok(o::LogicalReference {
        reference: operation_id(&target.object)?,
        generation: operation_id(&target.g)?,
    })
}
fn fields_target(target: &n::Target) -> o::Fields {
    vec![
        (
            "reference".into(),
            o::Value::Text(target.object.as_str().into()),
        ),
        (
            "generation".into(),
            o::Value::Text(target.g.as_str().into()),
        ),
    ]
}
fn text(name: &str, value: &n::Opaque) -> (String, o::Value) {
    (name.into(), o::Value::Text(value.as_str().into()))
}
fn status(job: &Job) -> n::JobStatus {
    let restore = job.restore.is_some();
    n::JobStatus {
        job: native_id(&job.value.handle),
        target: n::Target {
            object: native_id(&job.value.target.reference),
            g: native_id(&job.value.target.generation),
        },
        kind: if restore {
            n::JobKind::Restore
        } else {
            n::JobKind::Upload
        },
        state: match job.value.state {
            o::JobState::Queued => n::JobState::Queued,
            o::JobState::Running | o::JobState::CancelRequested => n::JobState::Running,
            o::JobState::Succeeded => n::JobState::Succeeded,
            o::JobState::Failed => n::JobState::Failed,
            o::JobState::Cancelled => n::JobState::Cancelled,
        },
        completed_bytes: job.value.progress.completed(),
        total_bytes: job.value.progress.total(),
        outcome: match job.value.state {
            o::JobState::Succeeded => Some(if restore {
                n::Outcome::Restored
            } else {
                n::Outcome::Committed
            }),
            o::JobState::Cancelled => Some(n::Outcome::CancelledBeforeCommit),
            o::JobState::Failed => Some(n::Outcome::Unavailable),
            _ => None,
        },
    }
}
fn cancel_outcome(outcome: o::CancelOutcome) -> n::CancelOutcome {
    match outcome {
        o::CancelOutcome::Requested => n::CancelOutcome::Requested,
        o::CancelOutcome::StoppedBeforeCommit => n::CancelOutcome::CancelledBeforeCommit,
        o::CancelOutcome::AlreadyCommitted => n::CancelOutcome::AlreadyCommitted,
        o::CancelOutcome::AlreadyTerminal => n::CancelOutcome::AlreadyFinished,
    }
}
fn error(error: o::Failure) -> n::ErrorCode {
    match error.code {
        o::ErrorCode::Unauthenticated | o::ErrorCode::Denied => n::ErrorCode::NotAuthorized,
        o::ErrorCode::InvalidInput | o::ErrorCode::InvalidCursor => n::ErrorCode::Malformed,
        o::ErrorCode::Unsupported => n::ErrorCode::UnsupportedProfile,
        o::ErrorCode::PreconditionFailed => n::ErrorCode::PreconditionFailed,
        o::ErrorCode::Conflict => n::ErrorCode::ReplayConflict,
        o::ErrorCode::QuotaExceeded => n::ErrorCode::LimitExceeded,
        o::ErrorCode::IntegrityFailed => n::ErrorCode::IntegrityFailure,
        o::ErrorCode::Cancelled | o::ErrorCode::NotReady => n::ErrorCode::InvalidState,
        _ => n::ErrorCode::Unavailable,
    }
}
impl<A: Access> n::Authority for View<'_, A> {
    fn session(&self, id: &n::Opaque) -> Option<n::Owned<n::SessionRecord>> {
        self.owned(
            self.service
                .model
                .native
                .sessions
                .get(&(self.scope.clone(), id.clone()))?
                .clone(),
        )
    }
    fn key_envelope(&self, key: &n::Opaque, envelope: &n::Opaque) -> Option<n::Owned<()>> {
        self.service
            .access
            .key_envelope(self.scope, key, envelope)
            .then(|| self.owned(()))
            .flatten()
    }
    fn transfer(&self, id: &n::Opaque) -> Option<n::Owned<n::TransferHandle>> {
        let id = operation_id(id).ok()?;
        let value = self.service.model.transfers.get(&id)?;
        self.service.redeem(self.scope, &id).ok()?;
        let object = self.object_value(&n::Target {
            object: native_id(&value.value.target.reference),
            g: native_id(&value.value.target.generation),
        })?;
        self.owned(n::TransferHandle {
            handle: native_id(&id),
            object,
            range: None,
            expires_at: value.value.expires_at,
        })
    }
    fn destination(&self, id: &n::Opaque) -> Option<n::Owned<Option<n::Opaque>>> {
        let id = operation_id(id).ok()?;
        self.service
            .permit(self.scope, &id, c::Action::Write)
            .ok()?;
        let current = match self.service.lookup(self.scope, &id) {
            Ok(view) => Some(
                self.service
                    .bound_object(self.scope, &id, &view)
                    .ok()?
                    .object
                    .target
                    .g
                    .clone(),
            ),
            Err(_) => None,
        };
        self.owned(current)
    }
    fn object(&self, target: &n::Target) -> Option<n::Owned<n::Object>> {
        self.owned(self.object_value(target)?)
    }
    fn upload(&self, id: &n::Opaque) -> Option<n::Owned<n::UploadRecord>> {
        let id = operation_id(id).ok()?;
        let upload = self.service.model.uploads.get(&id)?;
        if upload.scope != *self.scope {
            return None;
        }
        self.service
            .permit_descriptor(self.scope, &upload.descriptor)
            .ok()?;
        let job = self.service.job(self.scope, &upload.job).ok()?;
        self.owned(n::UploadRecord {
            intent: upload.descriptor.intent.clone(),
            received_bytes: upload.received,
            integrity_verified: upload.verified,
            expires_at: upload.transfer.expires_at,
            committed: job.value.effects == o::Effects::Committed,
            abort_outcome: upload.abort.clone(),
        })
    }
    fn committed_upload(&self, id: &n::Opaque) -> Option<n::Owned<n::Object>> {
        let upload = self.service.model.uploads.get(&operation_id(id).ok()?)?;
        if upload.scope != *self.scope
            || self
                .service
                .job(self.scope, &upload.job)
                .ok()?
                .value
                .effects
                != o::Effects::Committed
        {
            return None;
        }
        self.object(&n::Target {
            object: native_id(&upload.transfer.target.reference),
            g: native_id(&upload.transfer.target.generation),
        })
    }
    fn container(&self, id: &n::Opaque) -> Option<n::Owned<()>> {
        self.service
            .access
            .container(self.scope, id.as_str())
            .then(|| self.owned(()))
            .flatten()
    }
    fn listed_object(
        &self,
        container: &n::Opaque,
        target: &n::Target,
    ) -> Option<n::Owned<n::Object>> {
        let tenant = self.service.tenant(self.scope).ok()?;
        if !self.service.model.members.contains(&(
            tenant,
            operation_id(container).ok()?,
            operation_id(&target.object).ok()?,
        )) {
            return None;
        }
        self.object(target)
    }
    fn cursor(&self, id: &n::Opaque) -> Option<n::Owned<n::CursorRecord>> {
        let value = self.service.model.cursors.get(&operation_id(id).ok()?)?;
        if value.scope != *self.scope {
            return None;
        }
        self.owned(n::CursorRecord {
            container: native_id(&value.parent),
            page_entries: value.limit.try_into().ok()?,
            expires_at: value.expires,
        })
    }
    fn job(&self, id: &n::Opaque) -> Option<n::Owned<n::JobRecord>> {
        let value = self.service.job(self.scope, &operation_id(id).ok()?).ok()?;
        let cleanup_required = self
            .service
            .model
            .uploads
            .values()
            .any(|u| u.job == value.value.handle && u.cleanup);
        self.owned(n::JobRecord {
            status: status(&value),
            cleanup_required,
        })
    }
    fn replay(
        &self,
        requested_owner: &n::Owner,
        id: &n::Opaque,
    ) -> Option<n::Owned<n::ReplayRecord>> {
        if *requested_owner != owner(self.scope) {
            return None;
        }
        self.owned(
            self.service
                .model
                .native
                .replay
                .get(&(self.scope.clone(), id.clone()))?
                .0
                .clone(),
        )
    }
}

impl<A: Access> Service<A> {
    pub async fn native_bytes<S: flow::Storage, C: flow::Clock, P: flow::Policy>(
        &mut self,
        scope: &o::Scope,
        parent: &o::Opaque,
        bytes: &[u8],
        worker: UploadWorker<'_, S, C, P>,
    ) -> Result<n::Response, n::ErrorCode> {
        let request = n::decode_request(bytes)?;
        Ok(self.native_call(scope, parent, &request, worker).await)
    }
    /// Authenticated in-process native handler. Requests never supply the trusted
    /// principal or container grant. Full protocol validation precedes allocation.
    /// Unsupported ranges fail closed rather than silently widening a transfer.
    pub async fn native_call<S: flow::Storage, C: flow::Clock, P: flow::Policy>(
        &mut self,
        scope: &o::Scope,
        parent: &o::Opaque,
        request: &n::Request,
        worker: UploadWorker<'_, S, C, P>,
    ) -> n::Response {
        let result = self.native_apply(scope, parent, request, worker).await;
        n::Response {
            version: n::VERSION,
            scope: request.scope.clone(),
            request_id: request.request_id.clone(),
            body: result.unwrap_or_else(n::ResponseBody::Error),
        }
    }
    async fn native_apply<S: flow::Storage, C: flow::Clock, P: flow::Policy>(
        &mut self,
        scope: &o::Scope,
        parent: &o::Opaque,
        request: &n::Request,
        worker: UploadWorker<'_, S, C, P>,
    ) -> Result<n::ResponseBody, n::ErrorCode> {
        self.tenant(scope).map_err(error)?;
        if !self.access.admit(scope) {
            return Err(n::ErrorCode::NotAuthorized);
        }
        match &request.action {
            n::Action::Restore(value) => self
                .permit(
                    scope,
                    &operation_id(&value.target.object).map_err(error)?,
                    c::Action::Restore,
                )
                .map_err(error)?,
            n::Action::Status { job } | n::Action::Cancel { job } => {
                let value = self
                    .job(scope, &operation_id(job).map_err(error)?)
                    .map_err(error)?;
                if !value.native_upload && value.restore.is_none() {
                    return Err(n::ErrorCode::UnsupportedProfile);
                }
            }
            _ => {}
        }
        let admission = n::validate_request(
            request,
            &owner(scope),
            &self.profile,
            &View {
                service: self,
                scope,
            },
            self.now,
        )?;
        if admission == n::Admission::Replay {
            if matches!(request.action, n::Action::InitiateUpload(_)) {
                let descriptor = self
                    .model
                    .descriptors
                    .get(&(
                        scope.clone(),
                        operation_id(&request.request_id).map_err(error)?,
                    ))
                    .ok_or(n::ErrorCode::NotAuthorized)?;
                self.permit_descriptor(scope, descriptor).map_err(error)?;
                if descriptor.parent != *parent {
                    return Err(n::ErrorCode::ReplayConflict);
                }
            }
            let body = self
                .model
                .native
                .replay
                .get(&(scope.clone(), request.request_id.clone()))
                .ok_or(n::ErrorCode::Unavailable)?
                .1
                .clone();
            // Admission above rechecks live authority. Progress/status replies were
            // validated at issuance and are immutable history, not current state.
            // Other replies still need live response checks (e.g. transfer expiry).
            if !matches!(
                request.action,
                n::Action::ResumeUpload(_) | n::Action::Restore(_) | n::Action::Status { .. }
            ) {
                self.check_response(scope, request, body.clone())?;
            }
            return Ok(body);
        }
        let additional = if matches!(request.action, n::Action::Capabilities(_)) {
            2
        } else {
            1
        };
        if (self.model.native.replay.len() + self.model.native.sessions.len())
            .saturating_add(additional)
            > self.limits.records
        {
            return Err(n::ErrorCode::LimitExceeded);
        }
        let identity = text("identity", &request.request_id);
        let call = |service: &mut Self, op, fields| {
            o::dispatch(service, Some(scope), o::VERSION, op, fields).map_err(error)
        };
        let body = match &request.action {
            n::Action::Capabilities(offer) => {
                let id = native_id(&token("session", self.next().map_err(error)?));
                let selection = n::negotiate(offer, &self.profile, id.clone())?;
                let expires_at = self.expiry(self.limits.job_seconds).map_err(error)?;
                self.model.native.sessions.insert(
                    (scope.clone(), id),
                    n::SessionRecord {
                        selection: selection.clone(),
                        expires_at,
                    },
                );
                n::ResponseBody::Capabilities(selection)
            }
            n::Action::InitiateUpload(intent) => {
                self.bind_upload(
                    scope,
                    operation_id(&request.request_id).map_err(error)?,
                    parent.clone(),
                    intent.clone(),
                )
                .map_err(error)?;
                let mut fields = vec![
                    text("reference", &intent.object),
                    (
                        "max_bytes".into(),
                        o::Value::Number(intent.ciphertext.length),
                    ),
                    identity,
                ];
                match &intent.precondition {
                    n::Precondition::Absent => {
                        fields.push(("if_absent".into(), o::Value::Flag(true)))
                    }
                    n::Precondition::Matches(g) => fields.push(text("generation", g)),
                }
                let o::Output::Upload { transfer, .. } =
                    call(self, o::Operation::InitiateUpload, fields)?
                else {
                    return Err(n::ErrorCode::Unavailable);
                };
                n::ResponseBody::Upload {
                    upload: native_id(&transfer.handle),
                    received_bytes: 0,
                }
            }
            n::Action::ResumeUpload(value) => {
                let (_, received_bytes) = self
                    .resume(scope, &operation_id(&value.upload).map_err(error)?)
                    .map_err(error)?;
                n::ResponseBody::Upload {
                    upload: value.upload.clone(),
                    received_bytes,
                }
            }
            n::Action::CommitUpload(value) | n::Action::AbortUpload(value) => {
                let handle = operation_id(&value.upload).map_err(error)?;
                let upload = self
                    .model
                    .uploads
                    .get(&handle)
                    .cloned()
                    .ok_or(n::ErrorCode::NotAuthorized)?;
                let target = n::Target {
                    object: native_id(&upload.transfer.target.reference),
                    g: native_id(&upload.transfer.target.generation),
                };
                let mut fields = fields_target(&target);
                fields.push(text("transfer", &value.upload));
                fields.push(identity);
                if matches!(request.action, n::Action::AbortUpload(_)) {
                    let o::Output::Cancel { outcome, .. } =
                        call(self, o::Operation::AbortUpload, fields)?
                    else {
                        return Err(n::ErrorCode::Unavailable);
                    };
                    let outcome = if upload.cleanup {
                        n::CancelOutcome::CleanupRequired
                    } else {
                        cancel_outcome(outcome)
                    };
                    self.model.uploads.get_mut(&handle).unwrap().abort = Some(outcome.clone());
                    n::ResponseBody::Aborted(outcome)
                } else {
                    call(self, o::Operation::CommitUpload, fields)?;
                    self.finish_upload(
                        scope,
                        &handle,
                        worker.storage,
                        worker.budget,
                        worker.clock,
                        worker.policy,
                    )
                    .await
                    .map_err(error)?;
                    n::ResponseBody::Committed(
                        View {
                            service: self,
                            scope,
                        }
                        .committed_upload(&value.upload)
                        .ok_or(n::ErrorCode::Unavailable)?
                        .value,
                    )
                }
            }
            n::Action::Browse(value) => {
                let mut fields = vec![
                    text("parent", &value.container),
                    ("limit".into(), o::Value::Number(value.page_entries.into())),
                ];
                if let Some(cursor) = &value.cursor {
                    fields.push(text("cursor", cursor));
                }
                let o::Output::Page { entries, cursor } = call(self, o::Operation::Browse, fields)?
                else {
                    return Err(n::ErrorCode::Unavailable);
                };
                let entries = entries
                    .into_iter()
                    .map(|entry| {
                        View {
                            service: self,
                            scope,
                        }
                        .object_value(&n::Target {
                            object: native_id(&entry.target.reference),
                            g: native_id(&entry.target.generation),
                        })
                        .ok_or(n::ErrorCode::NotAuthorized)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                n::ResponseBody::Browse {
                    entries,
                    cursor: cursor.as_ref().map(native_id),
                }
            }
            n::Action::Stat(target) => {
                call(self, o::Operation::Stat, fields_target(target))?;
                n::ResponseBody::Stat(
                    View {
                        service: self,
                        scope,
                    }
                    .object_value(target)
                    .ok_or(n::ErrorCode::NotAuthorized)?,
                )
            }
            n::Action::Download(value) => {
                if value.range.is_some() {
                    return Err(n::ErrorCode::InvalidRange);
                }
                let mut fields = fields_target(&value.target);
                fields.push(identity);
                let o::Output::Download(transfer) =
                    call(self, o::Operation::AuthorizeDownload, fields)?
                else {
                    return Err(n::ErrorCode::Unavailable);
                };
                n::ResponseBody::Download(
                    View {
                        service: self,
                        scope,
                    }
                    .transfer(&native_id(&transfer.handle))
                    .ok_or(n::ErrorCode::Unavailable)?
                    .value,
                )
            }
            n::Action::Restore(value) => {
                let mut fields = fields_target(&value.target);
                fields.push(identity);
                fields.push((
                    "availability_seconds".into(),
                    o::Value::Number(value.max_seconds.into()),
                ));
                fields.push((
                    "max_seconds".into(),
                    o::Value::Number(value.max_seconds.into()),
                ));
                let o::Output::Job(job) = call(self, o::Operation::Restore, fields)? else {
                    return Err(n::ErrorCode::Unavailable);
                };
                n::ResponseBody::Restore(status(&self.job(scope, &job.handle).map_err(error)?))
            }
            n::Action::Status { job } => {
                call(self, o::Operation::Status, vec![text("job", job)])?;
                n::ResponseBody::Status(status(
                    &self
                        .job(scope, &operation_id(job).map_err(error)?)
                        .map_err(error)?,
                ))
            }
            n::Action::Cancel { job } => {
                let o::Output::Cancel { outcome, .. } =
                    call(self, o::Operation::Cancel, vec![text("job", job), identity])?
                else {
                    return Err(n::ErrorCode::Unavailable);
                };
                let record = View {
                    service: self,
                    scope,
                }
                .job(job)
                .ok_or(n::ErrorCode::NotAuthorized)?;
                n::ResponseBody::Cancel(if record.value.cleanup_required {
                    n::CancelOutcome::CleanupRequired
                } else {
                    cancel_outcome(outcome)
                })
            }
        };
        let initiated_upload = match &body {
            n::ResponseBody::Upload { upload, .. }
                if matches!(request.action, n::Action::InitiateUpload(_)) =>
            {
                Some(upload.clone())
            }
            _ => None,
        };
        self.model.native.replay.insert(
            (scope.clone(), request.request_id.clone()),
            (
                n::ReplayRecord {
                    action: request.action.clone(),
                    initiated_upload,
                },
                body.clone(),
            ),
        );
        // Response validation needs the issuance record for post-effect reconciliation.
        // Preserve an actual commit even if the session expired at worker entry;
        // replay still requires a live session and current response authority.
        if let Err(error) = self.check_response(scope, request, body.clone()) {
            if !matches!(body, n::ResponseBody::Committed(_)) {
                self.model
                    .native
                    .replay
                    .remove(&(scope.clone(), request.request_id.clone()));
            }
            return Err(error);
        }
        Ok(body)
    }
    fn check_response(
        &self,
        scope: &o::Scope,
        request: &n::Request,
        body: n::ResponseBody,
    ) -> Result<(), n::ErrorCode> {
        let response = n::Response {
            version: n::VERSION,
            scope: request.scope.clone(),
            request_id: request.request_id.clone(),
            body,
        };
        n::validate_response(
            request,
            &response,
            &owner(scope),
            &self.profile,
            &View {
                service: self,
                scope,
            },
            self.now,
        )
    }
}
