use super::*;
use a::ArchiveProvider;

#[tokio::test]
async fn provider_pending_write_cancel_retains_original_journal_and_safety_copy() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::Stall).await;
        let events = storage.control.events.clone();
        let mut future = Box::pin(attempt(&mut c, &mut storage, job, &auth, &time));
        assert!(std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx))
        })
        .await
        .is_pending());
        events.send_replace(Some(a::Failure::Cancelled));
        assert_eq!(future.await, Err(Failure::Io(IoError::Uncertain)));
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::EffectPending { .. }
        ));
        assert_eq!(writer(&storage, backend).calls, ["begin", "part"]);
        assert!(storage.cache.provider_record.is_none());
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_write_scope_and_saved_session_binding_fail_before_effects() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for field in 0..5 {
            let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
            let journal = storage.cache.provider_write.as_mut().unwrap();
            match field {
                0 => journal.intent.target.tenant = aid("2"),
                1 => journal.intent.target.generation = aid("2"),
                2 => journal.intent.sha256[0] ^= 1,
                3 => {
                    let mut intent = journal.intent.clone();
                    intent.target.account = aid("another-account");
                    journal.phase = WritePhase::Ready {
                        session: a::WriteSession {
                            intent,
                            remote: aid("foreign-session"),
                        },
                        receipts: Vec::new(),
                    };
                }
                _ => {
                    journal.phase = WritePhase::Ready {
                        session: a::WriteSession {
                            intent: journal.intent.clone(),
                            remote: aid("original-session"),
                        },
                        receipts: vec![a::PartReceipt {
                            index: 0,
                            intent_binding: [0; 32],
                            acknowledgement: aid("foreign-ack"),
                        }],
                    }
                }
            }
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Integrity))
            );
            assert!(writer(&storage, backend).calls.is_empty());
            assert!(storage.cache.provider_record.is_none());
            assert_retained(&c, &storage, job, backend);
        }
    }
}

#[tokio::test]
async fn provider_write_rejects_changed_staging_before_part_io() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
        let location = c
            .generation(TENANT, GENERATION)
            .unwrap()
            .cache_location
            .unwrap();
        storage.cache.copies.get_mut(&location).unwrap()[0] ^= 1;
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Integrity))
        );
        assert_eq!(writer(&storage, backend).calls, ["begin"]);
        assert!(storage.cache.copies.contains_key(&location));
        assert!(storage.cache.provider_record.is_none());
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::Ready { .. }
        ));
    }
}

#[derive(Clone, Copy)]
enum WriteFault {
    None,
    Begin,
    Part,
    Commit,
    Proof,
    Revoke,
    Stall,
}
struct Writer {
    inner: Provider,
    fault: WriteFault,
    calls: Vec<&'static str>,
    proof: Option<a::WriteProof>,
}
impl a::ArchiveProvider for Writer {
    fn capabilities(&self) -> a::Capabilities {
        a::Capabilities {
            write: true,
            reconcile: true,
            ..self.inner.capabilities()
        }
    }
    async fn begin(
        &mut self,
        intent: &a::WriteIntent,
        control: &impl Control,
    ) -> a::Result<a::WriteSession> {
        control.check(&intent.target, a::Action::Write)?;
        assert_eq!(intent.target.backend, self.inner.backend);
        self.calls.push("begin");
        if matches!(self.fault, WriteFault::Begin) {
            return Err(a::Failure::Uncertain);
        }
        Ok(a::WriteSession {
            intent: intent.clone(),
            remote: aid("original-session"),
        })
    }
    async fn write_part(
        &mut self,
        session: &a::WriteSession,
        index: usize,
        bytes: &[u8],
        control: &impl Control,
    ) -> a::Result<a::PartReceipt> {
        control.check(&session.intent.target, a::Action::Write)?;
        session.intent.check_part(index, bytes)?;
        assert_eq!(bytes, self.inner.bytes);
        self.calls.push("part");
        if matches!(self.fault, WriteFault::Stall) {
            return Err(control
                .cancelled(&session.intent.target, a::Action::Write)
                .await);
        }
        if matches!(self.fault, WriteFault::Part) {
            return Err(a::Failure::Uncertain);
        }
        Ok(a::PartReceipt {
            index,
            intent_binding: session.intent.binding()?,
            acknowledgement: aid("ack"),
        })
    }
    async fn commit(
        &mut self,
        session: &a::WriteSession,
        _: &[a::PartReceipt],
        control: &impl Control,
    ) -> a::Result<a::WriteProof> {
        control.check(&session.intent.target, a::Action::Write)?;
        self.calls.push("commit");
        let proof = a::WriteProof {
            record: a::ObjectRecord {
                identity: a::ObjectIdentity {
                    target: session.intent.target.clone(),
                    version: if self.inner.backend == a::Backend::Nntp {
                        session.intent.target.generation.clone()
                    } else {
                        aid("exact-s3-version")
                    },
                    bytes: session.intent.bytes,
                    sha256: session.intent.sha256,
                },
                operation: session.intent.operation.clone(),
                parts: session.intent.parts.clone(),
            },
            acknowledged: true,
            full_ciphertext_readback: true,
            backend: self.inner.backend,
        };
        self.proof = Some(proof.clone());
        if matches!(self.fault, WriteFault::Commit) {
            return Err(a::Failure::Uncertain);
        }
        if matches!(self.fault, WriteFault::Revoke) {
            self.inner
                .auth
                .denied
                .borrow_mut()
                .insert("object:Write".into());
        }
        let mut returned = proof;
        if matches!(self.fault, WriteFault::Proof) {
            returned.record.identity.target.account = aid("wrong-account");
        }
        Ok(returned)
    }
    async fn abort(&mut self, _: &a::WriteSession, _: &impl Control) -> a::Result<a::AbortOutcome> {
        panic!("uncertain writes must never auto-abort")
    }
    async fn stat(
        &mut self,
        _: &a::ObjectRecord,
        _: &impl Control,
    ) -> a::Result<a::ObjectIdentity> {
        Err(a::Failure::Unsupported)
    }
    async fn read_range(
        &mut self,
        record: &a::ObjectRecord,
        range: a::Range,
        sink: &mut impl Sink,
        control: &impl Control,
    ) -> a::Result<()> {
        self.inner.read_range(record, range, sink, control).await
    }
    async fn reconcile(
        &mut self,
        session: &a::WriteSession,
        control: &impl Control,
    ) -> a::Result<a::Reconciled> {
        control.check(&session.intent.target, a::Action::Write)?;
        assert_eq!(session.remote, aid("original-session"));
        self.calls.push("reconcile");
        Ok(self
            .proof
            .clone()
            .map(|p| a::Reconciled::Verified(Box::new(p)))
            .unwrap_or(a::Reconciled::Uncertain))
    }
    async fn health(&mut self, _: &a::Target, _: &impl Control) -> a::Result<a::Health> {
        Err(a::Failure::Unsupported)
    }
}
type WriteStorage = ProviderStorage<Io, Writer, Writer, Current>;
fn writer(storage: &WriteStorage, backend: a::Backend) -> &Writer {
    if backend == a::Backend::Nntp {
        &storage.nntp
    } else {
        &storage.s3
    }
}
async fn staged(
    backend: a::Backend,
    fault: WriteFault,
) -> (MemoryCatalogue, WriteStorage, JobId, Rc<Auth>, Time) {
    let mut io = Io::new(1).await;
    io.provider_write = Some(WriteJournal {
        intent: record(&io, backend).intent(),
        phase: WritePhase::Prepared,
    });
    let auth = Rc::new(Auth::default());
    let ProviderStorage {
        cache,
        nntp,
        s3,
        control,
    } = bridge(io, backend, auth.clone(), Fault::None);
    let wrap = |inner: Provider| Writer {
        fault: if inner.backend == backend {
            fault
        } else {
            WriteFault::None
        },
        inner,
        calls: Vec::new(),
        proof: None,
    };
    let mut storage = ProviderStorage {
        cache,
        nntp: wrap(nntp),
        s3: wrap(s3),
        control,
    };
    let mut c = MemoryCatalogue::default();
    let time = Time(Cell::new(10));
    let upload = storage.cache.upload();
    let job = commit_job(
        ingest(
            &mut c,
            &mut storage,
            &upload,
            &budget(),
            &time,
            &Rules::default(),
            auth.as_ref(),
        )
        .await
        .unwrap(),
    );
    (c, storage, job, auth, time)
}
async fn attempt(
    c: &mut MemoryCatalogue,
    storage: &mut WriteStorage,
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
fn assert_retained(c: &MemoryCatalogue, storage: &WriteStorage, job: JobId, backend: a::Backend) {
    assert_ne!(c.job(TENANT, job).unwrap().state, JobState::Complete);
    let location = c
        .generation(TENANT, GENERATION)
        .unwrap()
        .cache_location
        .unwrap();
    assert_eq!(
        storage.cache.copies.get(&location).unwrap(),
        storage.cache.fixture.bytes()
    );
    assert!(storage.cache.trace.0.is_empty());
    assert!(!storage.cache.order.contains(&"engine-post"));
    assert!(!storage.cache.order.contains(&"engine-verify-pair"));
    assert!(writer(
        storage,
        if backend == a::Backend::Nntp {
            a::Backend::S3
        } else {
            a::Backend::Nntp
        }
    )
    .calls
    .is_empty());
}

#[tokio::test]
async fn provider_write_uses_product_upload_and_job_but_never_fabricates_qualification() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::None).await;
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::RepairUnavailable))
        );
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::Verified { .. }
        ));
        assert_eq!(writer(&storage, backend).calls, ["begin", "part", "commit"]);
        assert_eq!(
            storage
                .cache
                .provider_record
                .as_ref()
                .unwrap()
                .identity
                .target
                .backend,
            backend
        );
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_lost_commit_reconciles_original_session_after_serialized_restart() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut c, mut storage, job, auth, time) = staged(backend, WriteFault::Commit).await;
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::Uncertain))
        );
        assert!(matches!(
            storage.cache.provider_write.as_ref().unwrap().phase,
            WritePhase::EffectPending { .. }
        ));
        assert!(storage.cache.provider_record.is_none());
        let checkpoint =
            serde_json::to_vec(storage.cache.provider_write.as_ref().unwrap()).unwrap();
        storage.cache.provider_write = Some(serde_json::from_slice(&checkpoint).unwrap());
        time.0.set(13);
        assert_eq!(
            attempt(&mut c, &mut storage, job, &auth, &time).await,
            Err(Failure::Io(IoError::RepairUnavailable))
        );
        assert_eq!(
            writer(&storage, backend).calls,
            ["begin", "part", "commit", "reconcile"]
        );
        assert!(storage.cache.provider_record.is_some());
        assert_retained(&c, &storage, job, backend);
    }
}

#[tokio::test]
async fn provider_lost_begin_or_part_never_reallocates_aborts_or_cleans_safety_bytes() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for fault in [WriteFault::Begin, WriteFault::Part] {
            let (mut c, mut storage, job, auth, time) = staged(backend, fault).await;
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            time.0.set(13);
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            let expected = if matches!(fault, WriteFault::Begin) {
                vec!["begin"]
            } else {
                vec!["begin", "part", "reconcile"]
            };
            assert_eq!(writer(&storage, backend).calls, expected);
            assert!(storage.cache.provider_record.is_none());
            assert_retained(&c, &storage, job, backend);
        }
    }
}

#[tokio::test]
async fn provider_bad_proof_and_failed_local_record_commit_remain_uncertain() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for local_failure in [false, true] {
            let (mut c, mut storage, job, auth, time) = staged(
                backend,
                if local_failure {
                    WriteFault::None
                } else {
                    WriteFault::Proof
                },
            )
            .await;
            if local_failure {
                storage.cache.inject = Injection::Uncertain;
            }
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::Uncertain))
            );
            assert!(storage.cache.provider_record.is_none());
            assert_retained(&c, &storage, job, backend);
            storage.cache.inject = Injection::None;
            time.0.set(13);
            assert_eq!(
                attempt(&mut c, &mut storage, job, &auth, &time).await,
                Err(Failure::Io(IoError::RepairUnavailable))
            );
            assert_eq!(
                writer(&storage, backend).calls,
                ["begin", "part", "commit", "reconcile"]
            );
        }
    }
}

#[tokio::test]
async fn provider_write_rechecks_write_even_when_read_remains_authorized() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for late in [false, true] {
            let (mut c, mut storage, job, auth, time) = staged(
                backend,
                if late {
                    WriteFault::Revoke
                } else {
                    WriteFault::None
                },
            )
            .await;
            if !late {
                auth.denied.borrow_mut().insert("object:Write".into());
            }
            let result = attempt(&mut c, &mut storage, job, &auth, &time).await;
            assert!(result.is_err());
            assert!(auth.permits(
                &Reference {
                    tenant: TENANT,
                    name: "object".into()
                },
                Action::Read
            ));
            assert!(storage.cache.provider_record.is_none());
            if late {
                assert_eq!(result, Err(Failure::Io(IoError::Uncertain)));
                assert!(matches!(
                    storage.cache.provider_write.as_ref().unwrap().phase,
                    WritePhase::EffectPending { .. }
                ));
            } else {
                assert!(writer(&storage, backend).calls.is_empty());
            }
            assert_retained(&c, &storage, job, backend);
        }
    }
}
