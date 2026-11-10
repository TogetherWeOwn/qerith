use super::*;
use qerith_core::catalogue::S3VerificationEvidence;

// These references assert synthetic software qualification only. No media keys,
// supplier durability or authenticated plaintext are present in this fake.
struct S3Qualification(u8);
impl Qualifier for S3Qualification {
    fn qualify(
        &self,
        _: &Work,
        _: &[Reconstruction; 2],
        _: u64,
    ) -> qerith_core::catalogue::Result<Qualification> {
        panic!("S3 must never manufacture NNTP backbones")
    }
    fn qualify_s3(
        &self,
        work: &Work,
        record: &a::ObjectRecord,
        now: u64,
    ) -> std::result::Result<S3VerificationEvidence, IoError> {
        let mut proof = evidence(record.clone(), work.metadata.recovery_ref.clone(), now);
        match self.0 {
            0 => {}
            1 => proof.record.identity.target.account = aid("different-account"),
            2 => proof.record.identity.version = aid("different-version"),
            3 => proof.record.identity.target.encryption.envelope = aid("different-envelope"),
            4 => proof.record.identity.target.tenant = aid("different-tenant"),
            5 => proof.record.identity.target.generation = aid("different-generation"),
            6 => proof.record.identity.target.backend = a::Backend::Nntp,
            7 => proof.recovery_ref.push_str("-different"),
            8 => proof.verified_at = now + 1,
            9 => proof.valid_until = now,
            10 => proof.readability_ref.clear(),
            11 => proof.durability_ref.clear(),
            12 => proof.provenance_ref.clear(),
            13 => proof.verifier_version.clear(),
            _ => unreachable!(),
        }
        Ok(proof)
    }
}
fn evidence(record: a::ObjectRecord, recovery_ref: String, now: u64) -> S3VerificationEvidence {
    S3VerificationEvidence {
        record,
        recovery_ref,
        verified_at: now,
        valid_until: now + 100,
        verifier_version: "MOCK software only".into(),
        provenance_ref: "MOCK exact-version observation".into(),
        readability_ref: "MOCK no cryptographic readability claim".into(),
        durability_ref: "MOCK no supplier durability claim".into(),
    }
}
async fn qualified_attempt(
    c: &mut MemoryCatalogue,
    storage: &mut WriteStorage,
    job: JobId,
    auth: &Auth,
    time: &Time,
    case: u8,
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
        &S3Qualification(case),
        auth,
    )
    .await
}
fn proof(c: &MemoryCatalogue, storage: &WriteStorage, now: u64) -> S3VerificationEvidence {
    evidence(
        storage.cache.provider_record.clone().unwrap(),
        c.generation(TENANT, GENERATION)
            .unwrap()
            .metadata
            .recovery_ref,
        now,
    )
}

#[tokio::test]
async fn s3_qualified_product_archive_completes_without_nntp_evidence_or_eviction() {
    let (mut c, mut storage, job, auth, time) = staged(a::Backend::S3, WriteFault::Qualify).await;
    qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0)
        .await
        .unwrap();
    assert_eq!(c.job(TENANT, job).unwrap().state, JobState::Complete);
    assert_eq!(storage.s3.calls, ["begin", "part", "commit"]);
    assert_eq!(storage.s3.inner.reads, 1);
    assert!(storage.nntp.calls.is_empty());
    assert_eq!(storage.nntp.inner.reads, 0);
    let location = c
        .generation(TENANT, GENERATION)
        .unwrap()
        .cache_location
        .unwrap();
    assert_eq!(
        storage.cache.copies[&location],
        storage.cache.fixture.bytes()
    );
    assert!(storage.cache.trace.0.is_empty());
    assert!(!storage.cache.order.contains(&"engine-verify-pair"));
    let before = c.generation(TENANT, GENERATION).unwrap();
    for kind in [
        DeletionKind::DeliveryCache,
        DeletionKind::UnreferencedGeneration,
    ] {
        assert_eq!(
            c.candidate(TENANT, GENERATION, kind, 10, 10, auth.as_ref()),
            Err(Error::Invalid)
        );
        assert_eq!(
            c.candidate(TENANT, GENERATION, kind, 10, 11, auth.as_ref()),
            Err(Error::Unsafe)
        );
        assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    }
    let p = proof(&c, &storage, 10);
    let before = c.generation(TENANT, GENERATION).unwrap();
    c.record_s3_verification(TENANT, GENERATION, p.clone(), 10)
        .unwrap();
    assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    let changed = S3VerificationEvidence {
        verified_at: 11,
        ..p.clone()
    };
    c.record_s3_verification(TENANT, GENERATION, changed, 11)
        .unwrap();
    let mut changed = p;
    changed.verified_at = 12;
    changed.record.identity.version = aid("another-version");
    let before = c.generation(TENANT, GENERATION).unwrap();
    assert_eq!(
        c.record_s3_verification(TENANT, GENERATION, changed, 12),
        Err(Error::Conflict)
    );
    assert_eq!(c.generation(TENANT, GENERATION).unwrap(), before);
    let metadata = &before.metadata;
    assert_eq!(
        c.record_verification(
            TENANT,
            VerificationEvidence {
                generation: GENERATION,
                backbone: BackboneId(1),
                reconstructed: metadata.identity.clone(),
                verified_at: 12,
                valid_until: 100,
                verifier_version: "MOCK".into(),
                provenance_ref: "MOCK".into(),
                readability_ref: "MOCK".into(),
            },
            IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "MOCK".into(),
                decision_ref: "MOCK".into(),
                valid_until: 100,
            },
            12,
        ),
        Err(Error::Unsafe)
    );
}

#[tokio::test]
async fn s3_qualification_rejects_mismatched_or_incomplete_evidence_without_losing_safety() {
    for case in 1..=13 {
        let (mut c, mut storage, job, auth, time) =
            staged(a::Backend::S3, WriteFault::Qualify).await;
        assert_eq!(
            qualified_attempt(&mut c, &mut storage, job, &auth, &time, case).await,
            Err(Failure::Catalogue(Error::Unsafe)),
            "case {case}"
        );
        assert_retained(&c, &storage, job, a::Backend::S3);
        assert_eq!(storage.s3.inner.reads, 1);
        // No invalid proof reached the catalogue: valid evidence can still bind it.
        let p = proof(&c, &storage, 10);
        c.record_s3_verification(TENANT, GENERATION, p, 10).unwrap();
    }
}

#[tokio::test]
async fn s3_observation_alone_and_bad_readback_never_complete_the_product_archive() {
    let (mut c, mut storage, job, auth, time) = staged(a::Backend::S3, WriteFault::Qualify).await;
    assert_eq!(
        attempt(&mut c, &mut storage, job, &auth, &time).await,
        Err(Failure::Io(IoError::RepairUnavailable))
    );
    assert_retained(&c, &storage, job, a::Backend::S3);
    for fault in [
        Fault::Corrupt,
        Fault::Oversized,
        Fault::Overrun,
        Fault::Short,
        Fault::IgnoreLimit,
    ] {
        let (mut c, mut storage, job, auth, time) =
            staged(a::Backend::S3, WriteFault::Qualify).await;
        storage.s3.inner.fault = fault;
        assert_eq!(
            qualified_attempt(&mut c, &mut storage, job, &auth, &time, 0).await,
            Err(Failure::Io(IoError::Integrity))
        );
        assert_retained(&c, &storage, job, a::Backend::S3);
    }
}
