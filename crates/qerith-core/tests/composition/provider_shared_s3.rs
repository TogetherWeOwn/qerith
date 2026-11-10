use super::*;
use a::s3::{self, SafeTransport};

#[derive(Clone, Copy)]
enum TransportFault {
    None,
    LostCompletion,
    WrongVersion,
    CorruptRead,
}
struct Remote {
    calls: Vec<&'static str>,
    uploaded: bool,
    completed: bool,
    fault: TransportFault,
}
// No networking, signer or credentials: only the shared adapter is real. The
// generated remote state is not durable settlement or supplier qualification.
struct Transport {
    config: s3::Config,
    intent: a::WriteIntent,
    bytes: Vec<u8>,
    remote: Rc<RefCell<Remote>>,
}
impl Transport {
    fn check(
        &self,
        config: &s3::Config,
        intent: &a::WriteIntent,
        action: a::Action,
        control: &impl Control,
    ) -> a::Result<()> {
        assert_eq!(config, &self.config);
        assert_eq!(intent, &self.intent);
        control.check(&intent.target, action)
    }
    fn session(&self, session: &a::WriteSession) {
        assert_eq!(session.intent, self.intent);
        assert_eq!(session.remote, aid("fixture-upload"));
    }
    fn metadata(&self) -> s3::Metadata {
        assert!(self.remote.borrow().completed);
        s3::Metadata {
            version: aid("fixture-version"),
            bytes: self.intent.bytes,
            intent_binding: self.intent.binding().unwrap(),
            checksum: s3::ProviderChecksum::Unavailable,
        }
    }
}
impl SafeTransport for Transport {
    async fn begin(
        &mut self,
        config: &s3::Config,
        intent: &a::WriteIntent,
        control: &impl Control,
    ) -> a::Result<a::Id> {
        self.check(config, intent, a::Action::Write, control)?;
        let mut remote = self.remote.borrow_mut();
        assert!(remote.calls.is_empty(), "never allocate a second session");
        remote.calls.push("begin");
        Ok(aid("fixture-upload"))
    }
    async fn upload_part(
        &mut self,
        config: &s3::Config,
        session: &a::WriteSession,
        index: usize,
        bytes: &[u8],
        control: &impl Control,
    ) -> a::Result<s3::PartAck> {
        self.check(config, &session.intent, a::Action::Write, control)?;
        self.session(session);
        assert_eq!(index, 0);
        assert_eq!(bytes, self.bytes);
        let mut remote = self.remote.borrow_mut();
        assert!(!remote.uploaded, "reconciliation must not replay the part");
        remote.uploaded = true;
        remote.calls.push("part");
        Ok(s3::PartAck {
            etag: aid("fixture-etag"),
            sha256: self.intent.parts[index].sha256,
        })
    }
    async fn complete(
        &mut self,
        config: &s3::Config,
        session: &a::WriteSession,
        receipts: &[a::PartReceipt],
        control: &impl Control,
    ) -> a::Result<s3::Metadata> {
        self.check(config, &session.intent, a::Action::Write, control)?;
        self.session(session);
        assert_eq!(
            receipts,
            &[a::PartReceipt {
                index: 0,
                intent_binding: self.intent.binding()?,
                acknowledgement: aid("fixture-etag"),
            }]
        );
        {
            let mut remote = self.remote.borrow_mut();
            assert!(remote.uploaded);
            assert!(!remote.completed, "never replay completed mutation");
            remote.completed = true;
            remote.calls.push("complete");
            if matches!(remote.fault, TransportFault::LostCompletion) {
                return Err(a::Failure::Uncertain);
            }
        }
        Ok(self.metadata())
    }
    async fn abort_incomplete(
        &mut self,
        _: &s3::Config,
        _: &a::WriteSession,
        _: &impl Control,
    ) -> a::Result<a::AbortOutcome> {
        panic!("job failure must not abort an uncertain or completed object")
    }
    async fn head(
        &mut self,
        config: &s3::Config,
        intent: &a::WriteIntent,
        version: &a::Id,
        control: &impl Control,
    ) -> a::Result<s3::Metadata> {
        self.check(config, intent, a::Action::Read, control)?;
        assert_eq!(*version, aid("fixture-version"));
        self.remote.borrow_mut().calls.push("head");
        Ok(self.metadata())
    }
    async fn get_range(
        &mut self,
        config: &s3::Config,
        record: &a::ObjectRecord,
        range: a::Range,
        out: &mut [u8],
        control: &impl Control,
    ) -> a::Result<s3::RangeReply> {
        self.check(config, &record.intent(), a::Action::Read, control)?;
        assert!(self.remote.borrow().completed);
        assert_eq!(record.identity.version, aid("fixture-version"));
        assert_eq!(record.identity.bytes, self.bytes.len() as u64);
        assert_eq!(range.bytes, out.len() as u64);
        let start = usize::try_from(range.offset).unwrap();
        out.copy_from_slice(&self.bytes[start..start + out.len()]);
        let mut remote = self.remote.borrow_mut();
        remote.calls.push("get");
        if matches!(remote.fault, TransportFault::CorruptRead) {
            out[0] ^= 1;
        }
        Ok(s3::RangeReply {
            bytes: out.len(),
            offset: range.offset,
            total: self.bytes.len() as u64,
            version: aid(if matches!(remote.fault, TransportFault::WrongVersion) {
                "another-version"
            } else {
                "fixture-version"
            }),
        })
    }
    async fn reconcile(
        &mut self,
        config: &s3::Config,
        session: &a::WriteSession,
        control: &impl Control,
    ) -> a::Result<Option<s3::Metadata>> {
        self.check(config, &session.intent, a::Action::Write, control)?;
        self.session(session);
        self.remote.borrow_mut().calls.push("reconcile");
        // This fake only reconciles a known completed object, never reports
        // settled absence from a 404 or pretends a dropped request rolled back.
        Ok(Some(self.metadata()))
    }
    async fn health(
        &mut self,
        _: &s3::Config,
        _: &a::Target,
        _: &impl Control,
    ) -> a::Result<a::Health> {
        Err(a::Failure::Unsupported)
    }
}

type SharedStorage = ProviderStorage<Io, Writer, s3::Provider<Transport>, Current>;
fn shared(storage: WriteStorage, fault: TransportFault) -> (SharedStorage, Rc<RefCell<Remote>>) {
    let intent = storage
        .cache
        .provider_write
        .as_ref()
        .unwrap()
        .intent
        .clone();
    let config = s3::Config {
        enabled: true,
        account: intent.target.account.clone(),
        host: aid("archive.example.com"),
        region: aid("fixture-region"),
        bucket: aid("fixture-bucket"),
        credential_ref: aid("fixture-only-no-credential"),
    };
    let remote = Rc::new(RefCell::new(Remote {
        calls: Vec::new(),
        uploaded: false,
        completed: false,
        fault,
    }));
    let transport = Transport {
        config: config.clone(),
        intent,
        bytes: storage.cache.fixture.bytes().to_vec(),
        remote: remote.clone(),
    };
    (
        ProviderStorage {
            cache: storage.cache,
            nntp: storage.nntp,
            s3: s3::Provider::new(Some(config), transport).unwrap(),
            control: storage.control,
        },
        remote,
    )
}
async fn run(
    c: &mut MemoryCatalogue,
    storage: &mut SharedStorage,
    job: JobId,
    auth: &Auth,
    time: &Time,
) -> RunResult<()> {
    let event = job_event(c, job);
    run_once(
        c,
        storage,
        TENANT,
        event,
        &budget(),
        time,
        &Rules::default(),
        &MockQualification,
        auth,
    )
    .await
}
fn retained(c: &MemoryCatalogue, storage: &SharedStorage, job: JobId) {
    assert_ne!(c.job(TENANT, job).unwrap().state, JobState::Complete);
    let generation = c.generation(TENANT, GENERATION).unwrap();
    let location = generation.cache_location.unwrap();
    assert_eq!(
        storage.cache.copies[&location],
        storage.cache.fixture.bytes()
    );
    assert!(storage.nntp.calls.is_empty());
    assert!(storage.cache.trace.0.is_empty());
    assert!(!storage.cache.order.contains(&"engine-post"));
    assert!(!storage.cache.order.contains(&"engine-verify-pair"));
}

#[tokio::test]
async fn shared_s3_adapter_product_job_checks_transport_readback_without_fabricating_qualification()
{
    let (mut c, storage, job, auth, time) = staged(a::Backend::S3, WriteFault::None).await;
    let (mut storage, remote) = shared(storage, TransportFault::None);
    assert_eq!(
        run(&mut c, &mut storage, job, &auth, &time).await,
        Err(Failure::Io(IoError::RepairUnavailable))
    );
    let record = storage.cache.provider_record.as_ref().unwrap();
    assert_eq!(record.identity.version, aid("fixture-version"));
    assert_eq!(
        record.intent(),
        storage.cache.provider_write.as_ref().unwrap().intent
    );
    assert!(matches!(
        &storage.cache.provider_write.as_ref().unwrap().phase,
        WritePhase::Verified { record: saved } if saved == record
    ));
    assert_eq!(
        remote.borrow().calls,
        ["begin", "part", "complete", "get", "head", "get"]
    );
    retained(&c, &storage, job);
}

#[tokio::test]
async fn shared_s3_adapter_uncertain_completion_reconciles_exact_session_and_rechecks_readback() {
    for fault in [
        TransportFault::LostCompletion,
        TransportFault::WrongVersion,
        TransportFault::CorruptRead,
    ] {
        let (mut c, storage, job, auth, time) = staged(a::Backend::S3, WriteFault::None).await;
        let (mut storage, remote) = shared(storage, fault);
        assert_eq!(
            run(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Uncertain))
        );
        assert!(remote.borrow().completed);
        assert!(storage.cache.provider_record.is_none());
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::EffectPending { .. }
        ));
        retained(&c, &storage, job);
        let checkpoint =
            serde_json::to_vec(storage.cache.provider_write.as_ref().unwrap()).unwrap();
        storage.cache.provider_write = Some(serde_json::from_slice(&checkpoint).unwrap());

        // Invalid observations stay uncertain even during original-session
        // reconciliation. Only a new exact-version, full-byte readback can pass.
        if !matches!(fault, TransportFault::LostCompletion) {
            time.0.set(13);
            assert_eq!(
                run(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            assert!(storage.cache.provider_record.is_none());
            retained(&c, &storage, job);
        }
        remote.borrow_mut().fault = TransportFault::None;
        time.0.set(20);
        assert_eq!(
            run(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::RepairUnavailable))
        );
        let record = storage.cache.provider_record.as_ref().unwrap();
        assert_eq!(record.identity.version, aid("fixture-version"));
        assert!(matches!(
            &storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::Verified { record: saved } if saved == record
        ));
        let calls = &remote.borrow().calls;
        for mutation in ["begin", "part", "complete"] {
            assert_eq!(calls.iter().filter(|call| **call == mutation).count(), 1);
        }
        assert!(calls.contains(&"reconcile"));
        retained(&c, &storage, job);
    }
}
