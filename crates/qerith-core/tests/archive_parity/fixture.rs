use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use qerith_core::{catalogue::*, composition::*, native as n, operations as o, service as s};
use sha2::{Digest, Sha256};

use crate::{storage, support::Event};

pub const TENANT: TenantId = TenantId(1);
pub const BYTES: usize = 3072;
pub fn id(value: &str) -> o::Opaque {
    o::Opaque::new(value).unwrap()
}
fn nid(value: &str) -> n::Opaque {
    value.to_owned().try_into().unwrap()
}
pub fn scope(subscriber: usize) -> o::Scope {
    o::Scope {
        tenant: id("tenant"),
        principal: id(&format!("subscriber_{subscriber}")),
    }
}
#[derive(Clone, Default)]
pub struct Access {
    pub denied: Rc<RefCell<BTreeSet<String>>>,
}
impl Authority for Access {
    fn is_current(&self) -> bool {
        true
    }
    fn permits(&self, reference: &Reference, _: Action) -> bool {
        reference.tenant == TENANT && !self.denied.borrow().contains(&reference.name)
    }
}
impl s::Access for Access {
    fn tenant(&self, scope: &o::Scope) -> Option<TenantId> {
        Some(if scope.tenant == id("tenant") {
            TENANT
        } else {
            TenantId(2)
        })
    }
    fn permits(&self, scope: &o::Scope, name: &str, _: Action) -> bool {
        scope.tenant == id("tenant") && !self.denied.borrow().contains(name)
    }
    fn container(&self, scope: &o::Scope, parent: &str) -> bool {
        scope.tenant == id("tenant") && parent == "root"
    }
    fn admit(&self, _: &o::Scope) -> bool {
        true
    }
    fn key_envelope(&self, scope: &o::Scope, _: &n::Opaque, _: &n::Opaque) -> bool {
        scope.tenant == id("tenant")
    }
    fn copy_compatible(&self, _: &o::Scope, _: &n::Object, _: &o::Opaque) -> bool {
        false
    }
}
pub struct Time(Cell<u64>);
impl Clock for Time {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        Ok(self.0.get())
    }
}
pub fn budget() -> Budget {
    Budget::new(4096, 16, 3, 100).unwrap()
}
fn limits() -> s::Limits {
    s::Limits {
        bytes: 4096,
        job_seconds: 1000,
        transfer_seconds: 200,
        attempts: 3,
        records: 4096,
    }
}
fn profile() -> n::Policy {
    n::Policy {
        profiles: vec![n::SupportedProfile {
            profile: n::Profile {
                format: nid("synthetic_C"),
                crypto: nid("unqualified_mock"),
                integrity: nid("sha256"),
            },
            checksum_hex_chars: 64,
        }],
        limits: n::Limits {
            object_bytes: 4096,
            transfer_bytes: 4096,
            page_entries: 100,
            job_seconds: 1000,
        },
    }
}

// Only the native upload ingress differs from the shared S3 fixture, whose
// stage_upload intentionally rejects a second ingest. All cold I/O is reused.
pub struct Io {
    pub inner: storage::Io,
    bytes: Vec<u8>,
}
impl Storage for Io {
    async fn stage_upload(
        &mut self,
        upload: &Upload,
        _: &Budget,
        _: u64,
    ) -> std::result::Result<CompleteCopy, IoError> {
        if upload.metadata.identity.length != self.bytes.len() as u64
            || upload.metadata.identity.sha256 != <[u8; 32]>::from(Sha256::digest(&self.bytes))
        {
            return Err(IoError::Integrity);
        }
        self.inner
            .register(upload.generation, self.bytes.clone())
            .await;
        Ok(CompleteCopy {
            identity: upload.metadata.identity.clone(),
            checksums: upload.metadata.checksums.clone(),
            location: format!("fixture/1/{}/retained", upload.generation.0),
            receipt: "synthetic full C verified, NOT crypto".into(),
        })
    }
    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.inner.post(work).await
    }
    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        self.inner.verify_archive(work).await
    }
    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.inner.retrieve(work).await
    }
    async fn complete_restore(
        &mut self,
        work: &Work,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.inner.complete_restore(work).await
    }
    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.inner.verify_completed(work, location).await
    }
    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.inner.cleanup_incomplete(work).await
    }
}

pub struct Fixture {
    pub service: s::Service<Access>,
    pub io: Io,
    pub auth: Access,
    time: Time,
    sessions: BTreeMap<o::Scope, n::Opaque>,
    object: n::Object,
    restore_job: Option<JobId>,
    serial: usize,
}
async fn native(
    service: &mut s::Service<Access>,
    io: &mut Io,
    time: &Time,
    caller: &o::Scope,
    identity: &str,
    session: Option<&n::Opaque>,
    action: n::Action,
) -> n::ResponseBody {
    let request = n::Request {
        version: 1,
        scope: nid(caller.tenant.as_str()),
        request_id: nid(identity),
        session: session.cloned(),
        action,
    };
    service
        .native_bytes(
            caller,
            &id("root"),
            &serde_json::to_vec(&request).unwrap(),
            s::UploadWorker {
                storage: io,
                budget: &budget(),
                clock: time,
                policy: &storage::Rules,
            },
        )
        .await
        .unwrap()
        .body
}
impl Fixture {
    pub async fn archived() -> Self {
        let auth = Access::default();
        let mut service = s::Service::new(auth.clone(), limits(), profile(), 10).unwrap();
        let mut io = Io {
            inner: storage::Io::default(),
            bytes: (0..BYTES).map(|n| (n % 251) as u8).collect(),
        };
        let time = Time(Cell::new(10));
        let mut sessions = BTreeMap::new();
        for subscriber in 0..20 {
            let caller = scope(subscriber);
            let policy = profile();
            let n::ResponseBody::Capabilities(selection) = native(
                &mut service,
                &mut io,
                &time,
                &caller,
                "session",
                None,
                n::Action::Capabilities(n::Offer {
                    versions: vec![1],
                    profiles: vec![policy.profiles[0].profile.clone()],
                    limits: policy.limits,
                }),
            )
            .await
            else {
                panic!("negotiate")
            };
            sessions.insert(caller, selection.session);
        }
        let digest = Sha256::digest(&io.bytes);
        let intent = n::UploadIntent {
            object: nid("object"),
            precondition: n::Precondition::Absent,
            ciphertext: n::Ciphertext {
                c: nid("opaque_C"),
                length: BYTES as u64,
                checksum_hex: nid(&digest
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()),
                profile: profile().profiles[0].profile.clone(),
                key_ref: nid("key"),
                envelope_ref: nid("envelope"),
            },
            metadata: n::Metadata {
                content_type: "application/octet-stream".into(),
                content_encoding: None,
                user: BTreeMap::from([("qualification".into(), "synthetic-NOT-AEAD".into())]),
            },
        };
        let session = sessions.get(&scope(0)).unwrap();
        let n::ResponseBody::Upload { upload, .. } = native(
            &mut service,
            &mut io,
            &time,
            &scope(0),
            "init",
            Some(session),
            n::Action::InitiateUpload(intent.clone()),
        )
        .await
        else {
            panic!("initiate")
        };
        service
            .staged(&scope(0), &id(upload.as_str()), 0, BYTES as u64)
            .unwrap();
        service
            .verify_staged(
                &scope(0),
                &id(upload.as_str()),
                &CompleteCopy {
                    identity: CiphertextIdentity {
                        length: BYTES as u64,
                        sha256: digest.into(),
                    },
                    checksums: vec![],
                    location: "trusted-staging".into(),
                    receipt: "full bytes/checksum verified".into(),
                },
            )
            .unwrap();
        let n::ResponseBody::Committed(object) = native(
            &mut service,
            &mut io,
            &time,
            &scope(0),
            "commit",
            Some(session),
            n::Action::CommitUpload(n::UploadAction { upload, intent }),
        )
        .await
        else {
            panic!("commit")
        };
        assert!(io.inner.trace.0.is_empty(), "spools start unposted");
        let archive = service
            .catalogue()
            .outbox(TENANT)
            .into_iter()
            .find_map(|e| match e.effect {
                Effect::RunJob(j) if j.kind == JobKind::Archive => Some((e.id, j)),
                _ => None,
            })
            .unwrap();
        // Empty-spool ARTICLE verification must fail before real engine POST.
        let work = Work {
            tenant: TENANT,
            event: archive.0,
            job: archive.1.clone(),
            metadata: service
                .catalogue()
                .generation(TENANT, archive.1.generation)
                .unwrap()
                .metadata,
            retained_location: None,
            inventory_ref: "pre-post-negative-control".into(),
            attempt: 1,
            claim_until: 110,
            budget: budget(),
        };
        assert_eq!(io.verify_archive(&work).await, Err(IoError::Integrity));
        run_once(
            service.catalogue_mut(),
            &mut io,
            TENANT,
            archive.0,
            &budget(),
            &time,
            &storage::Rules,
            &storage::SimulatedQualification,
            &auth,
        )
        .await
        .unwrap();
        assert_eq!(
            io.inner
                .trace
                .0
                .iter()
                .filter(|e| matches!(e, Event::RepairPosted(_)))
                .count(),
            6
        );
        Self {
            service,
            io,
            auth,
            time,
            sessions,
            object,
            restore_job: None,
            serial: 0,
        }
    }
    pub fn target(&self) -> n::Target {
        self.object.target.clone()
    }
    pub fn target_fields(&self) -> serde_json::Value {
        serde_json::json!({"reference":self.object.target.object.as_str(), "generation":self.object.target.g.as_str()})
    }
    pub fn download_fields(&self, identity: &str) -> serde_json::Value {
        let mut fields = self.target_fields();
        fields["identity"] = identity.into();
        fields
    }
    pub fn restore_fields(&self, identity: &str) -> serde_json::Value {
        let mut fields = self.download_fields(identity);
        fields["availability_seconds"] = 50.into();
        fields["max_seconds"] = 50.into();
        fields
    }
    fn snapshot(&self) -> s::Service<Access> {
        s::Service::reconnect(
            self.service.checkpoint(),
            self.auth.clone(),
            limits(),
            profile(),
            self.service.now(),
        )
        .unwrap()
    }
    pub fn reconnect(&mut self) {
        self.service = self.snapshot();
    }
    pub fn set_now(&mut self, now: u64) {
        self.time.0.set(now);
        self.service.set_now(now).unwrap();
    }
    pub fn generation(&self) -> GenerationId {
        self.service
            .catalogue()
            .lookup(TENANT, "object", self.service.now(), &self.auth)
            .unwrap()
            .generation
    }
    pub fn event(&self, job: JobId) -> EventId {
        self.service
            .catalogue()
            .outbox(TENANT)
            .into_iter()
            .find_map(|e| match e.effect {
                Effect::RunJob(j) if j.id == job => Some(e.id),
                _ => None,
            })
            .unwrap()
    }
    pub fn physical(&self) -> JobId {
        self.restore_job.unwrap()
    }
    pub fn evict(&mut self) {
        let generation = self.generation();
        let candidate = self
            .service
            .catalogue()
            .candidate(
                TENANT,
                generation,
                DeletionKind::DeliveryCache,
                10,
                11,
                &self.auth,
            )
            .unwrap();
        let event = self
            .service
            .catalogue_mut()
            .finalize_deletion(candidate, 11, &self.auth)
            .unwrap();
        let dispatch = self
            .service
            .catalogue_mut()
            .dispatch_deletion(TENANT, event, 11, &self.auth)
            .unwrap();
        assert_eq!(dispatch.generation, generation);
        assert!(11 < dispatch.valid_until);
        let DeletionTarget::StorageVersion(location) = dispatch.target else {
            panic!("exact immutable version")
        };
        assert_eq!(self.io.inner.delivery.len(), 1);
        assert!(self.io.inner.delivery.contains_key(&location));
        self.io.inner.forget_location(&location);
        self.service
            .catalogue_mut()
            .acknowledge_deletion(TENANT, event)
            .unwrap();
        self.io.inner.assert_empty();
        self.set_now(11);
    }
    pub async fn run(&mut self) -> RunResult<()> {
        let event = self.event(self.physical());
        run_once(
            self.service.catalogue_mut(),
            &mut self.io,
            TENANT,
            event,
            &budget(),
            &self.time,
            &storage::Rules,
            &storage::SimulatedQualification,
            &self.auth,
        )
        .await
    }
    pub fn parity(
        &mut self,
        caller: &o::Scope,
        operation: o::Operation,
        fields: serde_json::Value,
    ) -> std::result::Result<o::Output, o::Failure> {
        let mut mcp_service = self.snapshot();
        let bytes = serde_json::to_vec(&fields).unwrap();
        let rest = o::rest_request(
            &mut self.service,
            Some(caller),
            "POST",
            &format!("/v1/operations/{}", operation.definition().name),
            &bytes,
        );
        let mcp = o::mcp_request(
            &mut mcp_service,
            Some(caller),
            o::McpSession::default(),
            o::TaskMode::Baseline,
            operation.definition().name,
            &bytes,
        );
        assert_eq!(rest.outcome, mcp.outcome);
        assert_eq!(mcp.is_error, rest.outcome.is_err());
        assert_eq!(self.service.allocations(), mcp_service.allocations());
        if let Ok(o::Output::Download(transfer)) = &mcp.outcome {
            Self::read(
                &mut self.io,
                &mcp_service,
                &self.auth,
                caller,
                &transfer.handle,
            );
        }
        rest.outcome
    }
    pub async fn native_snapshot(
        &mut self,
        caller: &o::Scope,
        identity: &str,
        action: n::Action,
    ) -> n::ResponseBody {
        let mut service = self.snapshot();
        let body = native(
            &mut service,
            &mut self.io,
            &self.time,
            caller,
            identity,
            self.sessions.get(caller),
            action,
        )
        .await;
        if let n::ResponseBody::Download(transfer) = &body {
            assert_eq!(transfer.object, self.object);
            Self::read(
                &mut self.io,
                &service,
                &self.auth,
                caller,
                &id(transfer.handle.as_str()),
            );
        }
        body
    }
    fn read(
        io: &mut Io,
        service: &s::Service<Access>,
        auth: &Access,
        caller: &o::Scope,
        handle: &o::Opaque,
    ) {
        use qerith_core::s3::archive::QualifiedCache;
        let (generation, pin) = service.redeem(caller, handle).unwrap();
        assert_eq!(
            service
                .catalogue()
                .validate_pin(TENANT, pin, service.now(), auth)
                .unwrap(),
            generation
        );
        let view = service.catalogue().generation(TENANT, generation).unwrap();
        let bytes = io
            .inner
            .read(
                TENANT,
                generation,
                &view.metadata.identity,
                &view.cache_location.unwrap(),
                pin,
                None,
            )
            .unwrap();
        assert_eq!(bytes, io.bytes);
        assert_eq!(
            <[u8; 32]>::from(Sha256::digest(&bytes)),
            view.metadata.identity.sha256
        );
    }
    fn next_poll(&mut self) -> String {
        self.serial += 1;
        format!("poll_{}", self.serial)
    }
    pub async fn restore(&mut self, caller: &o::Scope, identity: &str) -> o::Job {
        let body = self
            .native_snapshot(
                caller,
                identity,
                n::Action::Restore(n::Restore {
                    target: self.target(),
                    max_bytes: BYTES as u64,
                    max_seconds: 50,
                }),
            )
            .await;
        let o::Output::Job(job) = self
            .parity(caller, o::Operation::Restore, self.restore_fields(identity))
            .unwrap()
        else {
            panic!("restore")
        };
        let n::ResponseBody::Restore(status) = body else {
            panic!("native restore {body:?}")
        };
        assert_eq!(status.job.as_str(), job.handle.as_str());
        assert_eq!(status.target, self.target());
        self.restore_job = Some(
            self.service
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .find_map(|e| match e.effect {
                    Effect::RunJob(j) if j.kind == JobKind::Restore => Some(j.id),
                    _ => None,
                })
                .unwrap(),
        );
        job
    }
    pub async fn status(&mut self, caller: &o::Scope, job: &o::Job, expected: o::JobState) {
        let identity = self.next_poll();
        let body = self
            .native_snapshot(
                caller,
                &identity,
                n::Action::Status {
                    job: nid(job.handle.as_str()),
                },
            )
            .await;
        let o::Output::Job(current) = self
            .parity(
                caller,
                o::Operation::Status,
                serde_json::json!({"job":job.handle.as_str()}),
            )
            .unwrap()
        else {
            panic!("status")
        };
        assert_eq!(current.state, expected);
        let n::ResponseBody::Status(status) = body else {
            panic!("native status {body:?}")
        };
        let state = match expected {
            o::JobState::Queued => n::JobState::Queued,
            o::JobState::Running => n::JobState::Running,
            o::JobState::Succeeded => n::JobState::Succeeded,
            o::JobState::Failed => n::JobState::Failed,
            o::JobState::Cancelled => n::JobState::Cancelled,
            _ => panic!("unmapped state"),
        };
        assert_eq!(status.state, state);
        assert_eq!(status.job.as_str(), current.handle.as_str());
        assert_eq!(status.target, self.target());
        assert_eq!(status.completed_bytes, current.progress.completed());
        assert_eq!(status.total_bytes, current.progress.total());
    }
    pub async fn stat(&mut self, available: bool) {
        let identity = self.next_poll();
        let body = self
            .native_snapshot(&scope(0), &identity, n::Action::Stat(self.target()))
            .await;
        assert_eq!(body, n::ResponseBody::Stat(self.object.clone()));
        let o::Output::Stat(entry) = self
            .parity(&scope(0), o::Operation::Stat, self.target_fields())
            .unwrap()
        else {
            panic!("stat")
        };
        assert_eq!(entry.available, available);
        assert_eq!(entry.bytes, BYTES as u64);
        assert_eq!(entry.target.generation.as_str(), self.target().g.as_str());
    }
    pub async fn download(&mut self, available: bool) -> Option<o::Transfer> {
        let identity = self.next_poll();
        let body = self
            .native_snapshot(
                &scope(0),
                &identity,
                n::Action::Download(n::Download {
                    target: self.target(),
                    range: None,
                    max_bytes: BYTES as u64,
                }),
            )
            .await;
        let result = self.parity(
            &scope(0),
            o::Operation::AuthorizeDownload,
            self.download_fields(&identity),
        );
        if available {
            let n::ResponseBody::Download(native) = body else {
                panic!("native download {body:?}")
            };
            let o::Output::Download(transfer) = result.unwrap() else {
                panic!("download")
            };
            assert_eq!(native.handle.as_str(), transfer.handle.as_str());
            assert_eq!(native.expires_at, transfer.expires_at);
            Self::read(
                &mut self.io,
                &self.service,
                &self.auth,
                &scope(0),
                &transfer.handle,
            );
            Some(transfer)
        } else {
            assert_eq!(result.unwrap_err().code, o::ErrorCode::NotAvailable);
            assert_eq!(body, n::ResponseBody::Error(n::ErrorCode::Unavailable));
            None
        }
    }
    pub async fn cancel(&mut self, caller: &o::Scope, job: &o::Job, identity: &str) {
        let body = self
            .native_snapshot(
                caller,
                identity,
                n::Action::Cancel {
                    job: nid(job.handle.as_str()),
                },
            )
            .await;
        assert_eq!(
            body,
            n::ResponseBody::Cancel(n::CancelOutcome::CancelledBeforeCommit)
        );
        let o::Output::Cancel { outcome, .. } = self
            .parity(
                caller,
                o::Operation::Cancel,
                serde_json::json!({"job":job.handle.as_str(), "identity":identity}),
            )
            .unwrap()
        else {
            panic!("cancel")
        };
        assert_eq!(outcome, o::CancelOutcome::StoppedBeforeCommit);
    }
    pub fn result(&mut self, caller: &o::Scope, job: &o::Job, success: bool) {
        let result = self.parity(
            caller,
            o::Operation::Result,
            serde_json::json!({"job":job.handle.as_str()}),
        );
        if success {
            assert!(matches!(result, Ok(o::Output::Result { .. })));
        } else {
            assert!(result.is_err());
        }
    }
    pub async fn denied_status(&mut self, caller: &o::Scope, job: &o::Job) {
        let identity = self.next_poll();
        assert!(self
            .parity(
                caller,
                o::Operation::Status,
                serde_json::json!({"job":job.handle.as_str()})
            )
            .is_err());
        let body = self
            .native_snapshot(
                caller,
                &identity,
                n::Action::Status {
                    job: nid(job.handle.as_str()),
                },
            )
            .await;
        assert!(matches!(body, n::ResponseBody::Error(_)), "{body:?}");
    }
}
