use super::*;
use a::nntp;

#[derive(Clone, Copy)]
enum ReadFault {
    None,
    LostPostAck,
    Missing,
    Corrupt,
}
struct Remote {
    posted: Vec<String>,
    reads: Vec<String>,
    bodies: BTreeMap<String, Vec<u8>>,
    fault: ReadFault,
}
// The shared adapter performs framing, encoding and verification. This fake is
// only generated in-memory I/O, not a socket, pool or physical settlement proof.
struct ArticleIo {
    intent: a::WriteIntent,
    bytes: Vec<u8>,
    remote: Rc<RefCell<Remote>>,
}
impl ArticleIo {
    fn part(&self, target: &a::Target, message_id: &str) -> &a::Part {
        assert_eq!(target, &self.intent.target);
        self.intent
            .parts
            .iter()
            .find(|part| part.reference.as_str() == message_id)
            .unwrap()
    }
}
impl nntp::Io for ArticleIo {
    async fn post(
        &mut self,
        target: &a::Target,
        message_id: &str,
        article: &[u8],
        control: &impl Control,
    ) -> a::Result<()> {
        control.check(target, a::Action::Write)?;
        let part = self.part(target, message_id);
        let mut decoded = vec![0; part.bytes as usize];
        assert_eq!(
            velmora::yenc::decode_to(message_id, article, &mut decoded).unwrap(),
            decoded.len()
        );
        let start = part.offset as usize;
        assert_eq!(decoded, self.bytes[start..start + decoded.len()]);
        let split = article.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let body = article[split + 4..].to_vec();
        let mut remote = self.remote.borrow_mut();
        assert!(
            remote.bodies.insert(message_id.to_owned(), body).is_none(),
            "reconciliation must never replay an irreversible POST"
        );
        remote.posted.push(message_id.to_owned());
        if matches!(remote.fault, ReadFault::LostPostAck)
            && remote.posted.len() == self.intent.parts.len()
        {
            return Err(a::Failure::Uncertain);
        }
        Ok(())
    }
    async fn body(
        &mut self,
        target: &a::Target,
        message_id: &str,
        control: &impl Control,
    ) -> a::Result<Vec<u8>> {
        control.check(target, a::Action::Read)?;
        let part = self.part(target, message_id);
        let mut remote = self.remote.borrow_mut();
        remote.reads.push(message_id.to_owned());
        if matches!(remote.fault, ReadFault::Missing) {
            return Err(a::Failure::Missing);
        }
        if matches!(remote.fault, ReadFault::Corrupt) {
            let start = part.offset as usize;
            let mut changed = self.bytes[start..start + part.bytes as usize].to_vec();
            changed[0] ^= 1;
            let mut body = Vec::new();
            velmora::yenc::encode_segment(
                &mut body,
                &velmora::yenc::SegmentParams::single("generated"),
                &changed,
            )
            .unwrap();
            // Valid yEnc/CRC is still not the immutable ciphertext part digest.
            return Ok(body);
        }
        remote
            .bodies
            .get(message_id)
            .cloned()
            .ok_or(a::Failure::Missing)
    }
    async fn stat(
        &mut self,
        target: &a::Target,
        message_id: &str,
        control: &impl Control,
    ) -> a::Result<()> {
        control.check(target, a::Action::Read)?;
        self.part(target, message_id);
        if self.remote.borrow().bodies.contains_key(message_id) {
            Ok(())
        } else {
            Err(a::Failure::Missing)
        }
    }
}

type SharedStorage = ProviderStorage<Io, nntp::Provider<ArticleIo>, Writer, Current>;
fn shared(mut storage: WriteStorage, fault: ReadFault) -> (SharedStorage, Rc<RefCell<Remote>>) {
    multipart(&mut storage);
    let journal = storage.cache.provider_write.as_mut().unwrap();
    for (index, part) in journal.intent.parts.iter_mut().enumerate() {
        part.reference = aid(&format!("generated-{index}@synthetic.invalid"));
    }
    journal.intent.validate().unwrap();
    let intent = journal.intent.clone();
    let plan = nntp::PostingPlan {
        intent_binding: intent.binding().unwrap(),
        headers: intent
            .parts
            .iter()
            .map(|part| nntp::PostHeaders {
                message_id: part.reference.clone(),
                from: aid("generated@synthetic.invalid"),
                subject: aid("generated"),
                date: "Tue, 10 Nov 2026 00:00:00 +0000".into(),
                newsgroup: aid("alt.test"),
                yenc_name: aid("generated"),
            })
            .collect(),
    };
    let remote = Rc::new(RefCell::new(Remote {
        posted: Vec::new(),
        reads: Vec::new(),
        bodies: BTreeMap::new(),
        fault,
    }));
    let io = ArticleIo {
        intent: intent.clone(),
        bytes: storage.cache.fixture.bytes().to_vec(),
        remote: remote.clone(),
    };
    (
        ProviderStorage {
            cache: storage.cache,
            nntp: nntp::Provider::new(intent.target.account, io, Some(plan)),
            s3: storage.s3,
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
    assert!(storage.s3.calls.is_empty());
    assert!(storage.cache.trace.0.is_empty());
    assert!(!storage.cache.order.contains(&"engine-post"));
    assert!(!storage.cache.order.contains(&"engine-verify-pair"));
}

#[tokio::test]
async fn shared_nntp_adapter_product_job_verifies_generated_parts_without_backbone_qualification() {
    let (mut c, storage, job, auth, time) = staged(a::Backend::Nntp, WriteFault::None).await;
    let (mut storage, remote) = shared(storage, ReadFault::None);
    assert_eq!(
        run(&mut c, &mut storage, job, &auth, &time).await,
        Err(Failure::Io(IoError::RepairUnavailable))
    );
    let record = storage.cache.provider_record.as_ref().unwrap();
    assert_eq!(record.identity.version, record.identity.target.generation);
    assert_eq!(
        record.intent(),
        storage.cache.provider_write.as_ref().unwrap().intent
    );
    assert!(matches!(
        &storage.cache.provider_write.as_ref().unwrap().phase,
        WritePhase::Verified { record: saved } if saved == record
    ));
    let ids: Vec<_> = record
        .parts
        .iter()
        .map(|part| part.reference.as_str().to_owned())
        .collect();
    assert_eq!(remote.borrow().posted, ids);
    assert_eq!(remote.borrow().reads, ids);
    retained(&c, &storage, job);
}

#[tokio::test]
async fn shared_nntp_adapter_uncertain_post_reconciles_original_parts_without_reposting() {
    for fault in [
        ReadFault::LostPostAck,
        ReadFault::Missing,
        ReadFault::Corrupt,
    ] {
        let (mut c, storage, job, auth, time) = staged(a::Backend::Nntp, WriteFault::None).await;
        let (mut storage, remote) = shared(storage, fault);
        assert_eq!(
            run(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Uncertain))
        );
        let pending = storage.cache.provider_write.clone().unwrap();
        assert!(matches!(pending.phase, WritePhase::EffectPending { .. }));
        assert!(storage.cache.provider_record.is_none());
        assert_eq!(remote.borrow().posted.len(), 2);
        retained(&c, &storage, job);
        let saved = serde_json::to_vec(&pending).unwrap();
        storage.cache.provider_write = Some(serde_json::from_slice(&saved).unwrap());
        let posted = remote.borrow().posted.clone();

        // Neither propagation delay nor valid-but-wrong yEnc proves absence or
        // permits retrying POST. Keep the exact uncertain checkpoint.
        if !matches!(fault, ReadFault::LostPostAck) {
            time.0.set(13);
            assert_eq!(
                run(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            assert_eq!(storage.cache.provider_write.as_ref(), Some(&pending));
            assert!(storage.cache.provider_record.is_none());
            assert_eq!(remote.borrow().posted, posted);
            retained(&c, &storage, job);
        }
        remote.borrow_mut().fault = ReadFault::None;
        time.0.set(20);
        assert_eq!(
            run(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::RepairUnavailable))
        );
        let record = storage.cache.provider_record.as_ref().unwrap();
        assert_eq!(record.intent(), pending.intent);
        assert_eq!(record.identity.version, pending.intent.target.generation);
        assert!(matches!(
            &storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::Verified { record: saved } if saved == record
        ));
        assert_eq!(remote.borrow().posted, posted);
        assert!(remote.borrow().reads.ends_with(&posted));
        retained(&c, &storage, job);
    }
}
