use qerith_core::catalogue::*;
use std::collections::BTreeMap;

const A: TenantId = TenantId(1);
const B: TenantId = TenantId(2);
const G: GenerationId = GenerationId(10);

struct Policy {
    current: bool,
    denied: Vec<Reference>,
}
impl Authority for Policy {
    fn is_current(&self) -> bool {
        self.current
    }
    fn permits(&self, reference: &Reference, _: Action) -> bool {
        !self.denied.contains(reference)
    }
}
fn policy() -> Policy {
    Policy {
        current: true,
        denied: vec![],
    }
}
fn denied(name: &str) -> Policy {
    Policy {
        current: true,
        denied: vec![Reference {
            tenant: A,
            name: name.into(),
        }],
    }
}
fn metadata(g: GenerationId) -> CiphertextMetadata {
    CiphertextMetadata {
        identity: CiphertextIdentity {
            length: 32,
            sha256: [g.0 as u8; 32],
        },
        validator: format!("opaque-generation-{}", g.0),
        modified_at: 1,
        headers: BTreeMap::from([("content-encoding".into(), "identity".into())]),
        checksums: vec![Checksum {
            algorithm: "SHA256".into(),
            kind: ChecksumType::FullObject,
            value: vec![g.0 as u8; 32],
            parts: vec![],
        }],
        recovery_ref: format!("fixture-recovery/{}", g.0),
    }
}
fn copy(g: GenerationId, location: &str) -> CompleteCopy {
    let m = metadata(g);
    CompleteCopy {
        identity: m.identity,
        checksums: m.checksums,
        location: location.into(),
        receipt: "fixture-complete-copy".into(),
    }
}
fn begin(name: &str, revision: u64, g: GenerationId) -> Mutation {
    Mutation::BeginUpload {
        name: name.into(),
        expected_revision: revision,
        generation: g,
        metadata: metadata(g),
        archive_deadline: 1000,
    }
}
fn tx(c: &mut impl MetadataOutbox, op: u64, mutation: Mutation, now: u64) -> Outcome {
    c.transact(A, OperationId(op), mutation, now, &policy())
        .unwrap()
}
fn upload(
    c: &mut impl MetadataOutbox,
    name: &str,
    revision: u64,
    g: GenerationId,
    op: u64,
) -> JobId {
    tx(c, op, begin(name, revision, g), 1);
    match tx(
        c,
        op + 1,
        Mutation::CommitUpload {
            intent: OperationId(op),
            copy: copy(g, &format!("copy/{}", g.0)),
        },
        2,
    ) {
        Outcome::Committed { archive, .. } => archive,
        _ => panic!("expected committed"),
    }
}
fn independence() -> IndependenceEvidence {
    IndependenceEvidence {
        backbones: [BackboneId(1), BackboneId(2)],
        assessor_ref: "fixture-assessor".into(),
        decision_ref: "fixture-only-not-real-qualification".into(),
        valid_until: 900,
    }
}
fn evidence(g: GenerationId, backbone: u64) -> VerificationEvidence {
    VerificationEvidence {
        generation: g,
        backbone: BackboneId(backbone),
        reconstructed: metadata(g).identity,
        verified_at: 3,
        valid_until: 900,
        verifier_version: "fixture-v1".into(),
        provenance_ref: format!("fixture-backbone/{backbone}"),
        readability_ref: "fixture-client-readability".into(),
    }
}
fn qualify(c: &mut impl JobPort, g: GenerationId, archive: JobId) {
    for backbone in [1, 2] {
        c.record_verification(A, evidence(g, backbone), independence(), 3)
            .unwrap();
    }
    let fence = c.claim(A, archive, 3, 100).unwrap();
    c.transition(A, fence, Transition::CompleteArchive, 4, &policy())
        .unwrap();
}
fn restore(c: &mut impl MetadataOutbox, name: &str, revision: u64, op: u64) -> JobId {
    match tx(
        c,
        op,
        Mutation::RequestRestore {
            name: name.into(),
            expected_revision: revision,
            profile: "whole-generation-standard".into(),
            deadline: 100,
            availability_for: 30,
        },
        5,
    ) {
        Outcome::Restore(job) => job,
        _ => panic!("expected restore"),
    }
}
fn publish(c: &mut impl JobPort, job: JobId, g: GenerationId, now: u64) -> Result<()> {
    let fence = c.claim(A, job, now, 90)?;
    c.transition(
        A,
        fence,
        Transition::PublishRestore {
            copy: copy(g, &format!("copy/{}", g.0)),
        },
        now,
        &policy(),
    )
}

#[test]
fn incomplete_upload_is_invisible_and_commit_is_atomic_with_outbox() {
    let mut c = MemoryCatalogue::default();
    tx(&mut c, 1, begin("object", 0, G), 1);
    assert_eq!(c.lookup(A, "object", 1, &policy()), Err(Error::Unavailable));
    assert!(c.outbox(A).is_empty());
    let mut bad = copy(G, "copy/10");
    bad.identity.length -= 1;
    let commit = Mutation::CommitUpload {
        intent: OperationId(1),
        copy: bad,
    };
    assert_eq!(
        c.transact(A, OperationId(2), commit, 2, &policy()),
        Err(Error::IncompleteCopy)
    );
    assert_eq!(
        c.reconcile(A, OperationId(2), &policy()),
        Ok(Reconciliation::Absent)
    );
    assert!(c.outbox(A).is_empty());
    let committed = tx(
        &mut c,
        2,
        Mutation::CommitUpload {
            intent: OperationId(1),
            copy: copy(G, "copy/10"),
        },
        2,
    );
    assert_eq!(
        c.reconcile(A, OperationId(2), &policy()),
        Ok(Reconciliation::Applied(committed))
    );
    assert_eq!(c.outbox(A).len(), 1);
    let view = c.lookup(A, "object", 2, &policy()).unwrap();
    assert_eq!(view.metadata, metadata(G));
    assert_eq!(view.availability_until, None);
    assert_eq!(
        c.transact(
            A,
            OperationId(3),
            Mutation::AcquireServingPin {
                name: "object".into(),
                until: 10
            },
            3,
            &policy()
        ),
        Err(Error::Unavailable)
    );
}

#[test]
fn operation_identity_reconciles_exact_mutations_not_universal_idempotency() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    let events = c.outbox(A);
    let mutation = Mutation::CommitUpload {
        intent: OperationId(1),
        copy: copy(G, "copy/10"),
    };
    assert!(
        matches!(tx(&mut c, 2, mutation.clone(), 3), Outcome::Committed { archive: id, .. } if id == archive)
    );
    assert_eq!(c.outbox(A), events);
    assert_eq!(
        c.transact(A, OperationId(9), mutation, 3, &policy()),
        Err(Error::Conflict)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(2),
            Mutation::AbortUpload {
                intent: OperationId(1)
            },
            3,
            &policy()
        ),
        Err(Error::Conflict)
    );
    assert_eq!(
        c.reconcile(A, OperationId(2), &denied("object")),
        Err(Error::Unavailable)
    );
}

#[test]
fn two_tenants_have_no_existence_metadata_operation_or_job_oracle() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "private", 0, G, 1);
    assert_eq!(
        c.lookup(B, "private", 3, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.lookup(B, "missing", 3, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.reconcile(B, OperationId(2), &policy()),
        Ok(Reconciliation::Absent)
    );
    assert_eq!(c.job(B, archive), Err(Error::Unavailable));
    assert!(c.outbox(B).is_empty());
    assert_eq!(
        c.transact(
            B,
            OperationId(3),
            Mutation::Link {
                source: "private".into(),
                destination: "stolen".into(),
                expected_revision: 0
            },
            3,
            &policy()
        ),
        Err(Error::Unavailable)
    );
    // Equal local IDs and digest bytes in another tenant grant no shared reference.
    c.transact(B, OperationId(1), begin("private", 0, G), 3, &policy())
        .unwrap();
    assert_eq!(
        c.lookup(B, "private", 3, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.lookup(A, "private", 3, &denied("private")),
        Err(Error::Unavailable)
    );
}

#[test]
fn overwrite_and_tombstone_fence_uploads_and_old_restore_publication() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let job = restore(&mut c, "object", 1, 3);
    let fence = c.claim(A, job, 6, 90).unwrap();
    let successor = GenerationId(11);
    upload(&mut c, "object", 1, successor, 4);
    assert_eq!(
        c.transition(
            A,
            fence,
            Transition::PublishRestore {
                copy: copy(G, "copy/10")
            },
            7,
            &policy()
        ),
        Err(Error::Unavailable)
    );
    let view = c.lookup(A, "object", 7, &policy()).unwrap();
    assert_eq!(view.generation, successor);
    assert_eq!(view.availability_until, None);
    tx(&mut c, 6, begin("object", 2, GenerationId(12)), 8);
    tx(
        &mut c,
        7,
        Mutation::Tombstone {
            name: "object".into(),
            expected_revision: 2,
        },
        9,
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(8),
            Mutation::CommitUpload {
                intent: OperationId(6),
                copy: copy(GenerationId(12), "copy/12")
            },
            10,
            &policy()
        ),
        Err(Error::Conflict)
    );
    // Replaying a prior successful commit returns history, never resurrects it.
    tx(
        &mut c,
        2,
        Mutation::CommitUpload {
            intent: OperationId(1),
            copy: copy(G, "copy/10"),
        },
        11,
    );
    assert_eq!(
        c.lookup(A, "object", 11, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(9),
            begin("object", 0, GenerationId(13)),
            11,
            &policy()
        ),
        Err(Error::Conflict)
    );
}

#[test]
fn coalesced_subscribers_cancel_individually_and_are_reauthorized() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "first", 0, G, 1);
    qualify(&mut c, G, archive);
    tx(
        &mut c,
        3,
        Mutation::Link {
            source: "first".into(),
            destination: "second".into(),
            expected_revision: 0,
        },
        5,
    );
    let first = restore(&mut c, "first", 1, 4);
    let second = restore(&mut c, "second", 1, 5);
    assert_eq!(first, second);
    tx(
        &mut c,
        6,
        Mutation::CancelSubscription {
            name: "first".into(),
            job: first,
        },
        6,
    );
    let fence = c.claim(A, second, 7, 90).unwrap();
    assert_eq!(
        c.transition(A, fence.clone(), Transition::CancelIfUnneeded, 7, &policy()),
        Err(Error::Unsafe)
    );
    c.transition(
        A,
        fence,
        Transition::PublishRestore {
            copy: copy(G, "copy/10"),
        },
        8,
        &policy(),
    )
    .unwrap();
    assert_eq!(
        c.lookup(A, "first", 8, &policy())
            .unwrap()
            .availability_until,
        None
    );
    assert_eq!(
        c.lookup(A, "second", 8, &policy())
            .unwrap()
            .availability_until,
        Some(38)
    );
    assert_eq!(
        c.lookup(A, "second", 8, &denied("second")),
        Err(Error::Unavailable)
    );
}

#[test]
fn publication_rechecks_tombstones_moderation_and_current_authority() {
    for mode in 0..3 {
        let mut c = MemoryCatalogue::default();
        let archive = upload(&mut c, "object", 0, G, 1);
        qualify(&mut c, G, archive);
        let job = restore(&mut c, "object", 1, 3);
        let fence = c.claim(A, job, 6, 90).unwrap();
        let mut auth = policy();
        if mode == 0 {
            tx(
                &mut c,
                4,
                Mutation::Tombstone {
                    name: "object".into(),
                    expected_revision: 1,
                },
                7,
            );
        }
        if mode == 1 {
            c.set_moderation(A, G, 2, true).unwrap();
            assert_eq!(c.set_moderation(A, G, 1, false), Err(Error::Fenced));
        }
        if mode == 2 {
            auth = denied("object");
        }
        assert_eq!(
            c.transition(
                A,
                fence,
                Transition::PublishRestore {
                    copy: copy(G, "copy/10")
                },
                8,
                &auth
            ),
            Err(Error::Unavailable)
        );
        assert_eq!(c.job(A, job).unwrap().state, JobState::Running);
    }
}

#[test]
fn checkpoints_retries_fixed_deadlines_and_claims_are_fenced() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    let old = c.claim(A, archive, 3, 10).unwrap();
    let checkpoint = Transition::Checkpoint {
        expected: 0,
        next: 1,
        inventory_ref: "article-inventory/v1".into(),
    };
    c.transition(A, old.clone(), checkpoint.clone(), 4, &policy())
        .unwrap();
    assert_eq!(
        c.transition(A, old.clone(), checkpoint, 4, &policy()),
        Err(Error::Conflict)
    );
    let fresh = c.claim(A, archive, 10, 20).unwrap();
    assert_ne!(old.token, fresh.token);
    assert_eq!(
        c.transition(A, old, Transition::FailUnrecoverable, 11, &policy()),
        Err(Error::Fenced)
    );
    c.transition(
        A,
        fresh,
        Transition::Retry { not_before: 30 },
        11,
        &policy(),
    )
    .unwrap();
    assert_eq!(c.claim(A, archive, 12, 25), Err(Error::Conflict));
    let retry = c.claim(A, archive, 30, 40).unwrap();
    assert_eq!(
        c.job(A, archive).unwrap().checkpoint_ref.as_deref(),
        Some("article-inventory/v1")
    );
    assert_eq!(c.job(A, archive).unwrap().deadline, 1000);
    c.expire_job(A, archive, 1000).unwrap();
    assert_eq!(c.job(A, archive).unwrap().state, JobState::Expired);
    assert_eq!(
        c.transition(A, retry, Transition::FailUnrecoverable, 1000, &policy()),
        Err(Error::Fenced)
    );
    assert!(c.outbox(A).is_empty());
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 1000, 1001, &policy()),
        Err(Error::Unsafe)
    );
}

#[test]
fn only_full_exact_generation_independently_attributed_evidence_allows_eviction() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 3, 10, &policy()),
        Err(Error::Unsafe)
    );
    let mut bad = evidence(G, 1);
    bad.reconstructed.length -= 1;
    assert_eq!(
        c.record_verification(A, bad, independence(), 3),
        Err(Error::Unsafe)
    );
    let mut unqualified = independence();
    unqualified.decision_ref.clear();
    assert_eq!(
        c.record_verification(A, evidence(G, 1), unqualified, 3),
        Err(Error::Unsafe)
    );
    c.record_verification(A, evidence(G, 1), independence(), 3)
        .unwrap();
    let fence = c.claim(A, archive, 3, 100).unwrap();
    assert_eq!(
        c.transition(A, fence.clone(), Transition::CompleteArchive, 4, &policy()),
        Err(Error::Unsafe)
    );
    let mut bad = evidence(G, 2);
    bad.readability_ref.clear();
    assert_eq!(
        c.record_verification(A, bad, independence(), 3),
        Err(Error::Unsafe)
    );
    assert_eq!(
        c.record_verification(A, evidence(GenerationId(99), 2), independence(), 3),
        Err(Error::Unavailable)
    );
    c.record_verification(A, evidence(G, 2), independence(), 3)
        .unwrap();
    c.transition(A, fence, Transition::CompleteArchive, 4, &policy())
        .unwrap();
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 10, &policy())
        .unwrap();
    assert_eq!(
        c.finalize_deletion(candidate.clone(), 9, &policy()),
        Err(Error::Conflict)
    );
    // Expired attribution is not perpetual evidence, even after archive completion.
    assert_eq!(
        c.finalize_deletion(candidate.clone(), 900, &policy()),
        Err(Error::Unsafe)
    );
    let event = c.finalize_deletion(candidate, 10, &policy()).unwrap();
    assert!(
        matches!(&c.outbox(A)[0].effect, Effect::Delete { generation, location, .. } if *generation == G && location == "copy/10")
    );
    c.acknowledge_deletion(A, event).unwrap();
    assert_eq!(
        c.lookup(A, "object", 11, &policy())
            .unwrap()
            .availability_until,
        None
    );
    assert_eq!(c.acknowledge_deletion(A, event), Err(Error::Unavailable));
}

#[test]
fn intents_leases_pins_holds_and_authority_uncertainty_block_candidates() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 10, &policy())
        .unwrap();
    c.set_safety_hold(A, G, true).unwrap();
    assert_eq!(
        c.finalize_deletion(candidate.clone(), 10, &policy()),
        Err(Error::Unsafe)
    );
    c.set_safety_hold(A, G, false).unwrap();
    assert_eq!(
        c.finalize_deletion(candidate, 10, &policy()),
        Err(Error::Fenced)
    );
    tx(&mut c, 3, begin("object", 1, GenerationId(11)), 5);
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 5, 10, &policy()),
        Err(Error::Unsafe)
    );
    tx(
        &mut c,
        4,
        Mutation::AbortUpload {
            intent: OperationId(3),
        },
        6,
    );
    let job = restore(&mut c, "object", 1, 5);
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 6, 10, &policy()),
        Err(Error::Unsafe)
    );
    publish(&mut c, job, G, 7).unwrap();
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 8, 10, &policy()),
        Err(Error::Unsafe)
    );
    let pin = match tx(
        &mut c,
        6,
        Mutation::AcquireServingPin {
            name: "object".into(),
            until: 35,
        },
        8,
    ) {
        Outcome::Pin(pin) => pin,
        _ => panic!("expected pin"),
    };
    assert_eq!(c.validate_pin(A, pin, 9, &policy()), Ok(G));
    assert_eq!(
        c.validate_pin(A, pin, 9, &denied("object")),
        Err(Error::Unavailable)
    );
    c.set_moderation(A, G, 1, true).unwrap();
    assert_eq!(
        c.validate_pin(A, pin, 9, &policy()),
        Err(Error::Unavailable)
    );
    c.set_moderation(A, G, 2, false).unwrap();
    assert_eq!(
        c.validate_pin(A, pin, 35, &policy()),
        Err(Error::Unavailable)
    );
    assert!(c
        .candidate(A, G, DeletionKind::DeliveryCache, 38, 40, &policy())
        .is_ok());
    assert_eq!(
        c.candidate(
            A,
            G,
            DeletionKind::UnreferencedGeneration,
            38,
            40,
            &policy()
        ),
        Err(Error::Unsafe)
    );
    let unknown = Policy {
        current: false,
        denied: vec![],
    };
    assert_eq!(
        c.candidate(A, G, DeletionKind::DeliveryCache, 38, 40, &unknown),
        Err(Error::Unsafe)
    );
}

#[test]
fn deletion_rechecks_references_and_prevents_stale_effect_location_reuse() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 10, &policy())
        .unwrap();
    tx(
        &mut c,
        3,
        Mutation::Link {
            source: "object".into(),
            destination: "new-link".into(),
            expected_revision: 0,
        },
        6,
    );
    assert_eq!(
        c.finalize_deletion(candidate, 10, &policy()),
        Err(Error::Fenced)
    );
    tx(
        &mut c,
        4,
        Mutation::Tombstone {
            name: "object".into(),
            expected_revision: 1,
        },
        6,
    );
    assert_eq!(
        c.candidate(A, G, DeletionKind::UnreferencedGeneration, 7, 10, &policy()),
        Err(Error::Unsafe)
    );
    tx(
        &mut c,
        5,
        Mutation::Tombstone {
            name: "new-link".into(),
            expected_revision: 1,
        },
        7,
    );
    let candidate = c
        .candidate(A, G, DeletionKind::UnreferencedGeneration, 8, 10, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 10, &policy()).unwrap();
    c.acknowledge_deletion(A, event).unwrap();
    assert_eq!(
        c.transact(A, OperationId(6), begin("new-object", 0, G), 11, &policy()),
        Err(Error::Conflict)
    );
    tx(&mut c, 7, begin("new-object", 0, GenerationId(11)), 11);
    assert_eq!(
        c.transact(
            A,
            OperationId(8),
            Mutation::CommitUpload {
                intent: OperationId(7),
                copy: copy(GenerationId(11), "copy/10")
            },
            12,
            &policy()
        ),
        Err(Error::Conflict)
    );
}

#[test]
fn abort_and_negotiated_checksum_mismatch_never_commit() {
    let mut c = MemoryCatalogue::default();
    tx(&mut c, 1, begin("object", 0, G), 1);
    let mut wrong = copy(G, "copy/10");
    wrong.checksums[0].kind = ChecksumType::Composite;
    assert_eq!(
        c.transact(
            A,
            OperationId(2),
            Mutation::CommitUpload {
                intent: OperationId(1),
                copy: wrong
            },
            2,
            &policy()
        ),
        Err(Error::IncompleteCopy)
    );
    tx(
        &mut c,
        3,
        Mutation::AbortUpload {
            intent: OperationId(1),
        },
        3,
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(4),
            Mutation::CommitUpload {
                intent: OperationId(1),
                copy: copy(G, "copy/10")
            },
            4,
            &policy()
        ),
        Err(Error::Conflict)
    );
    assert!(c.outbox(A).is_empty());
}
