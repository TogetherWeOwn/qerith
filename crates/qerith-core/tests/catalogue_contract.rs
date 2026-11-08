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
            subscription: OperationId(4),
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
        matches!(&c.outbox(A)[0].effect, Effect::Delete { generation, target: DeletionTarget::StorageVersion(location), .. } if *generation == G && location == "copy/10")
    );
    dispatch_and_ack(&mut c, event, 10);
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
        c.validate_pin(A, pin, 10, &policy()),
        Err(Error::Unavailable)
    );
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
    dispatch_and_ack(&mut c, event, 10);
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

fn dispatch_and_ack(c: &mut impl JobPort, event: EventId, now: u64) {
    c.dispatch_deletion(A, event, now, &policy()).unwrap();
    c.acknowledge_deletion(A, event).unwrap();
}

#[test]
fn policy_updates_are_retained_through_storage_reconciliation() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    c.set_moderation(A, G, 1, true).unwrap();
    assert_eq!(
        c.dispatch_deletion(A, event, 7, &policy()),
        Err(Error::Unsafe)
    );
    c.cancel_deletion(A, event).unwrap();
    assert_eq!(c.lookup(A, "object", 7, &policy()), Err(Error::Unavailable));
    c.set_moderation(A, G, 2, false).unwrap();
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 8, 9, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 9, &policy()).unwrap();
    c.dispatch_deletion(A, event, 9, &policy()).unwrap();
    c.set_moderation(A, G, 3, true).unwrap();
    assert_eq!(c.set_moderation(A, G, 2, false), Err(Error::Fenced));
    assert_eq!(c.cancel_deletion(A, event), Err(Error::Fenced));
    c.acknowledge_deletion(A, event).unwrap();
    assert_eq!(
        c.lookup(A, "object", 10, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(3),
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 1,
                profile: "standard".into(),
                deadline: 100,
                availability_for: 10,
            },
            10,
            &policy()
        ),
        Err(Error::Unavailable)
    );
}

#[test]
fn archive_recovery_refreshes_epoch_only_with_a_new_fence() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    for backbone in [1, 2] {
        c.record_verification(A, evidence(G, backbone), independence(), 3)
            .unwrap();
    }
    let old = c.claim(A, archive, 3, 10).unwrap();
    c.set_moderation(A, G, 1, true).unwrap();
    assert_eq!(c.claim(A, archive, 10, 20), Err(Error::Unavailable));
    c.set_moderation(A, G, 2, false).unwrap();
    assert_eq!(
        c.transition(A, old.clone(), Transition::CompleteArchive, 9, &policy()),
        Err(Error::Unavailable)
    );
    let fresh = c.claim(A, archive, 10, 20).unwrap();
    assert_ne!(old.token, fresh.token);
    assert_eq!(
        c.transition(A, old, Transition::CompleteArchive, 11, &policy()),
        Err(Error::Fenced)
    );
    c.transition(A, fresh, Transition::CompleteArchive, 11, &policy())
        .unwrap();
}

#[test]
fn delayed_deletion_revalidates_refreshes_and_cancels_without_false_ack() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    assert_eq!(c.acknowledge_deletion(A, event), Err(Error::Fenced));
    assert_eq!(
        c.dispatch_deletion(B, event, 7, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.dispatch_deletion(A, event, 900, &policy()),
        Err(Error::Unsafe)
    );
    assert_eq!(c.cancel_deletion(B, event), Err(Error::Unavailable));
    c.cancel_deletion(A, event).unwrap();
    assert_eq!(
        c.generation(A, G).unwrap().cache_location.as_deref(),
        Some("copy/10")
    );
    assert_eq!(
        c.dispatch_deletion(A, event, 900, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(c.acknowledge_deletion(A, event), Err(Error::Unavailable));
    for backbone in [1, 2] {
        let mut v = evidence(G, backbone);
        v.verified_at = 900;
        v.valid_until = 1100;
        let mut i = independence();
        i.valid_until = 1050;
        c.record_verification(A, v, i, 900).unwrap();
    }
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 900, 901, &policy())
        .unwrap();
    let fresh = c.finalize_deletion(candidate, 901, &policy()).unwrap();
    assert_ne!(event, fresh);
    c.set_safety_hold(A, G, true).unwrap();
    assert_eq!(
        c.dispatch_deletion(A, fresh, 902, &policy()),
        Err(Error::Unsafe)
    );
    c.set_safety_hold(A, G, false).unwrap();
    assert_eq!(
        c.dispatch_deletion(A, fresh, 902, &denied("object")),
        Err(Error::Unsafe)
    );
    let dispatch = c.dispatch_deletion(A, fresh, 902, &policy()).unwrap();
    assert_eq!(dispatch.valid_until, 1050);
    assert_eq!(
        dispatch.target,
        DeletionTarget::StorageVersion("copy/10".into())
    );
    assert_eq!(c.cancel_deletion(A, fresh), Err(Error::Fenced));
    c.acknowledge_deletion(A, fresh).unwrap();
    assert_eq!(c.generation(A, G).unwrap().cache_location, None);
}

#[test]
fn dispatched_no_effect_reconciliation_requires_expiry_settlement_and_same_copy() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    c.dispatch_deletion(A, event, 6, &policy()).unwrap();
    assert_eq!(
        c.dispatch_deletion(A, event, 7, &policy()),
        Err(Error::Fenced)
    );
    assert_eq!(
        c.reconcile_retained_deletion(
            A,
            event,
            copy(G, "copy/10"),
            "fixture-settled-no-effect".into(),
            899
        ),
        Err(Error::Fenced)
    );
    assert_eq!(
        c.reconcile_retained_deletion(A, event, copy(G, "copy/10"), String::new(), 900),
        Err(Error::Unsafe)
    );
    assert_eq!(
        c.reconcile_retained_deletion(
            A,
            event,
            copy(G, "other-copy"),
            "fixture-settled-no-effect".into(),
            900
        ),
        Err(Error::Unsafe)
    );
    c.reconcile_retained_deletion(
        A,
        event,
        copy(G, "copy/10"),
        "fixture-settled-no-effect".into(),
        900,
    )
    .unwrap();
    assert_eq!(
        c.dispatch_deletion(A, event, 900, &policy()),
        Err(Error::Unavailable)
    );
    assert_eq!(c.acknowledge_deletion(A, event), Err(Error::Unavailable));
    assert_eq!(
        c.generation(A, G).unwrap().cache_location.as_deref(),
        Some("copy/10")
    );
}

#[test]
fn queued_deletion_can_refresh_evidence_without_releasing_its_admission_fence() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    assert_eq!(
        c.lookup(A, "object", 7, &policy()).unwrap().metadata,
        metadata(G)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(3),
            Mutation::Link {
                source: "object".into(),
                destination: "other".into(),
                expected_revision: 0
            },
            7,
            &policy()
        ),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(4),
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 1,
                profile: "standard".into(),
                deadline: 100,
                availability_for: 30
            },
            7,
            &policy()
        ),
        Err(Error::Unavailable)
    );
    assert_eq!(
        c.dispatch_deletion(A, event, 900, &policy()),
        Err(Error::Unsafe)
    );
    for backbone in [1, 2] {
        let mut v = evidence(G, backbone);
        v.verified_at = 900;
        v.valid_until = 1200;
        let mut i = independence();
        i.valid_until = 1200;
        c.record_verification(A, v, i, 900).unwrap();
    }
    dispatch_and_ack(&mut c, event, 901);
    assert_eq!(c.generation(A, G).unwrap().cache_location, None);
}

#[test]
fn generation_validators_are_unique_even_after_retirement() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    tx(
        &mut c,
        3,
        Mutation::Tombstone {
            name: "object".into(),
            expected_revision: 1,
        },
        5,
    );
    let candidate = c
        .candidate(A, G, DeletionKind::UnreferencedGeneration, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    dispatch_and_ack(&mut c, event, 6);
    let mut next_metadata = metadata(GenerationId(11));
    next_metadata.validator = metadata(G).validator;
    tx(
        &mut c,
        4,
        Mutation::BeginUpload {
            name: "object".into(),
            expected_revision: 2,
            generation: GenerationId(11),
            metadata: next_metadata,
            archive_deadline: 1000,
        },
        7,
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(5),
            Mutation::CommitUpload {
                intent: OperationId(4),
                copy: copy(GenerationId(11), "copy/11")
            },
            8,
            &policy()
        ),
        Err(Error::Conflict)
    );
    assert!(c.outbox(A).is_empty());
}

#[test]
fn worker_inputs_survive_tombstones_without_end_user_visibility() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let first = restore(&mut c, "object", 1, 3);
    let second = match tx(
        &mut c,
        4,
        Mutation::RequestRestore {
            name: "object".into(),
            expected_revision: 1,
            profile: "expedited".into(),
            deadline: 100,
            availability_for: 30,
        },
        5,
    ) {
        Outcome::Restore(job) => job,
        _ => panic!("expected restore"),
    };
    assert_ne!(first, second);
    assert_eq!(
        c.job(A, first).unwrap().profile.as_deref(),
        Some("whole-generation-standard")
    );
    assert_eq!(
        c.job(A, second).unwrap().profile.as_deref(),
        Some("expedited")
    );
    assert!(c.outbox(A).iter().any(|e| matches!(&e.effect, Effect::RunJob(j) if j.id == second && j.profile.as_deref() == Some("expedited"))));
    tx(
        &mut c,
        5,
        Mutation::Tombstone {
            name: "object".into(),
            expected_revision: 1,
        },
        6,
    );
    assert_eq!(c.lookup(A, "object", 6, &policy()), Err(Error::Unavailable));
    assert_eq!(c.generation(B, G), Err(Error::Unavailable));
    let input = c.generation(A, G).unwrap();
    assert_eq!(input.metadata, metadata(G));
    assert_eq!(input.cache_location.as_deref(), Some("copy/10"));
    assert_eq!(c.job(A, archive).unwrap().profile, None);
}

#[test]
fn relinked_subscriber_replaces_stale_revision_but_not_current_subscription() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let job = restore(&mut c, "object", 1, 3);
    tx(
        &mut c,
        4,
        Mutation::Link {
            source: "object".into(),
            destination: "object".into(),
            expected_revision: 1,
        },
        6,
    );
    assert_eq!(restore(&mut c, "object", 2, 5), job);
    assert_eq!(
        c.transact(
            A,
            OperationId(6),
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 2,
                profile: "whole-generation-standard".into(),
                deadline: 100,
                availability_for: 30,
            },
            6,
            &policy()
        ),
        Err(Error::Conflict)
    );
    assert_eq!(
        c.transact(
            A,
            OperationId(7),
            Mutation::CancelSubscription {
                name: "object".into(),
                job,
                subscription: OperationId(3),
            },
            7,
            &policy()
        ),
        Err(Error::Conflict)
    );
    publish(&mut c, job, G, 7).unwrap();
    assert_eq!(
        c.lookup(A, "object", 7, &policy())
            .unwrap()
            .availability_until,
        Some(37)
    );
}

#[test]
fn cancellation_identity_survives_same_revision_resubscription_and_replay() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let job = restore(&mut c, "object", 1, 3);
    let old_cancel = Mutation::CancelSubscription {
        name: "object".into(),
        job,
        subscription: OperationId(3),
    };
    tx(&mut c, 4, old_cancel.clone(), 6);
    assert_eq!(
        tx(
            &mut c,
            5,
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 1,
                profile: "whole-generation-standard".into(),
                deadline: 100,
                availability_for: 30,
            },
            7,
        ),
        Outcome::Restore(job)
    );
    assert_eq!(tx(&mut c, 4, old_cancel.clone(), 7), Outcome::Applied);
    assert_eq!(
        c.transact(A, OperationId(6), old_cancel, 7, &policy()),
        Err(Error::Conflict)
    );
    let current_cancel = Mutation::CancelSubscription {
        name: "object".into(),
        job,
        subscription: OperationId(5),
    };
    assert_eq!(
        c.transact(B, OperationId(7), current_cancel.clone(), 7, &policy()),
        Err(Error::Unavailable)
    );
    tx(&mut c, 7, current_cancel, 7);
    let fence = c.claim(A, job, 8, 90).unwrap();
    c.transition(A, fence, Transition::CancelIfUnneeded, 8, &policy())
        .unwrap();
    assert_eq!(c.job(A, job).unwrap().state, JobState::Cancelled);
    assert!(c.outbox(A).is_empty());
}

#[test]
fn stale_epoch_queued_and_expired_claim_restores_can_retire_without_publication() {
    for expired_claim in [false, true] {
        let mut c = MemoryCatalogue::default();
        let archive = upload(&mut c, "object", 0, G, 1);
        assert_eq!(
            c.cancel_unneeded_restore(A, archive, 2, &policy()),
            Err(Error::Unsafe)
        );
        assert_eq!(c.job(A, archive).unwrap().state, JobState::Queued);
        qualify(&mut c, G, archive);
        let obsolete = restore(&mut c, "object", 1, 3);
        let old_fence = expired_claim.then(|| c.claim(A, obsolete, 6, 10).unwrap());
        c.set_moderation(A, G, 2, true).unwrap();
        c.set_moderation(A, G, 3, false).unwrap();
        if let Some(fence) = &old_fence {
            assert_eq!(
                c.cancel_unneeded_restore(A, obsolete, 9, &policy()),
                Err(Error::Fenced)
            );
            assert_eq!(
                c.transition(
                    A,
                    fence.clone(),
                    Transition::PublishRestore {
                        copy: copy(G, "copy/10")
                    },
                    9,
                    &policy()
                ),
                Err(Error::Unavailable)
            );
        }
        assert_eq!(
            c.cancel_unneeded_restore(A, obsolete, 11, &policy()),
            Err(Error::Unsafe)
        );
        tx(
            &mut c,
            4,
            Mutation::CancelSubscription {
                name: "object".into(),
                job: obsolete,
                subscription: OperationId(3),
            },
            11,
        );
        assert_eq!(c.claim(A, obsolete, 11, 90), Err(Error::Unavailable));
        let current = match tx(
            &mut c,
            5,
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 1,
                profile: "whole-generation-standard".into(),
                deadline: 100,
                availability_for: 30,
            },
            11,
        ) {
            Outcome::Restore(job) => job,
            _ => panic!("expected restore"),
        };
        assert_ne!(current, obsolete);
        let current_view = c.job(A, current).unwrap();
        let events = c.outbox(A);
        assert_eq!(
            c.cancel_unneeded_restore(A, current, 11, &policy()),
            Err(Error::Unsafe)
        );
        assert_eq!(c.job(A, current).unwrap(), current_view);
        assert_eq!(c.outbox(A), events);
        let mut queued_cleanup = c.clone();
        queued_cleanup
            .cancel_unneeded_restore(A, obsolete, 11, &policy())
            .unwrap();
        assert_eq!(queued_cleanup.job(A, current).unwrap(), current_view);
        assert_eq!(
            queued_cleanup.outbox(A),
            events
                .into_iter()
                .filter(|e| matches!(&e.effect, Effect::RunJob(j) if j.id == current))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            queued_cleanup.cancel_unneeded_restore(A, obsolete, 11, &policy()),
            Err(Error::Fenced)
        );
        publish(&mut c, current, G, 12).unwrap();
        assert_eq!(
            c.candidate(A, G, DeletionKind::DeliveryCache, 43, 44, &policy()),
            Err(Error::Unsafe)
        );
        assert_eq!(c.expire_job(A, obsolete, 43), Err(Error::Conflict));
        let unknown = Policy {
            current: false,
            denied: vec![],
        };
        assert_eq!(
            c.cancel_unneeded_restore(A, obsolete, 43, &unknown),
            Err(Error::Unsafe)
        );
        assert_eq!(
            c.cancel_unneeded_restore(B, obsolete, 43, &policy()),
            Err(Error::Unavailable)
        );
        c.cancel_unneeded_restore(A, obsolete, 43, &policy())
            .unwrap();
        assert_eq!(c.job(A, obsolete).unwrap().state, JobState::Cancelled);
        assert_eq!(c.job(A, current).unwrap().state, JobState::Complete);
        assert_eq!(
            c.lookup(A, "object", 43, &policy())
                .unwrap()
                .availability_until,
            Some(42)
        );
        assert!(c.outbox(A).is_empty());
        assert!(c
            .candidate(A, G, DeletionKind::DeliveryCache, 43, 44, &policy())
            .is_ok());
        assert_eq!(c.claim(A, obsolete, 43, 90), Err(Error::Unavailable));
        if let Some(fence) = old_fence {
            assert_eq!(
                c.transition(
                    A,
                    fence,
                    Transition::PublishRestore {
                        copy: copy(G, "copy/10")
                    },
                    43,
                    &policy()
                ),
                Err(Error::Fenced)
            );
        }
    }
}

#[test]
fn cold_publication_and_metadata_only_cleanup_never_reuse_storage_versions() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 5, 6, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 6, &policy()).unwrap();
    dispatch_and_ack(&mut c, event, 6);
    let job = restore(&mut c, "object", 1, 3);
    let fence = c.claim(A, job, 7, 90).unwrap();
    assert_eq!(
        c.transition(
            A,
            fence.clone(),
            Transition::PublishRestore {
                copy: copy(G, "copy/10")
            },
            7,
            &policy()
        ),
        Err(Error::Conflict)
    );
    c.transition(
        A,
        fence,
        Transition::PublishRestore {
            copy: copy(G, "restored/10/v2"),
        },
        7,
        &policy(),
    )
    .unwrap();
    let candidate = c
        .candidate(A, G, DeletionKind::DeliveryCache, 38, 39, &policy())
        .unwrap();
    let event = c.finalize_deletion(candidate, 39, &policy()).unwrap();
    dispatch_and_ack(&mut c, event, 39);
    tx(
        &mut c,
        4,
        Mutation::Tombstone {
            name: "object".into(),
            expected_revision: 1,
        },
        40,
    );
    let candidate = c
        .candidate(
            A,
            G,
            DeletionKind::UnreferencedGeneration,
            40,
            41,
            &policy(),
        )
        .unwrap();
    let event = c.finalize_deletion(candidate, 41, &policy()).unwrap();
    assert!(c.outbox(A).iter().any(|e| matches!(&e.effect, Effect::Delete { target: DeletionTarget::MetadataOnly, .. } if e.id == event)));
    dispatch_and_ack(&mut c, event, 41);
    tx(&mut c, 5, begin("new", 0, GenerationId(11)), 42);
    assert_eq!(
        c.transact(
            A,
            OperationId(6),
            Mutation::CommitUpload {
                intent: OperationId(5),
                copy: copy(GenerationId(11), "restored/10/v2"),
            },
            43,
            &policy()
        ),
        Err(Error::Conflict)
    );
}

#[test]
fn abandoned_intents_require_explicit_trusted_retirement() {
    let mut c = MemoryCatalogue::default();
    let archive = upload(&mut c, "object", 0, G, 1);
    qualify(&mut c, G, archive);
    tx(&mut c, 3, begin("object", 1, GenerationId(11)), 5);
    assert_eq!(
        c.retire_upload_intent(A, OperationId(3), 6),
        Err(Error::Conflict)
    );
    assert_eq!(
        c.retire_upload_intent(B, OperationId(3), 1000),
        Err(Error::Unavailable)
    );
    c.retire_upload_intent(A, OperationId(3), 1000).unwrap();
    assert_eq!(
        c.transact(
            A,
            OperationId(4),
            Mutation::CommitUpload {
                intent: OperationId(3),
                copy: copy(GenerationId(11), "copy/11")
            },
            1000,
            &policy()
        ),
        Err(Error::Conflict)
    );
    for backbone in [1, 2] {
        let mut v = evidence(G, backbone);
        v.verified_at = 1000;
        v.valid_until = 1200;
        let mut i = independence();
        i.valid_until = 1200;
        c.record_verification(A, v, i, 1000).unwrap();
    }
    assert!(c
        .candidate(A, G, DeletionKind::DeliveryCache, 1000, 1001, &policy())
        .is_ok());
}

#[test]
fn mixed_subscriber_authority_grants_only_eligible_leases() {
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
    let job = restore(&mut c, "first", 1, 4);
    assert_eq!(restore(&mut c, "second", 1, 5), job);
    let fence = c.claim(A, job, 6, 90).unwrap();
    c.transition(
        A,
        fence,
        Transition::PublishRestore {
            copy: copy(G, "copy/10"),
        },
        7,
        &denied("first"),
    )
    .unwrap();
    assert_eq!(
        c.lookup(A, "first", 7, &policy())
            .unwrap()
            .availability_until,
        None
    );
    assert_eq!(
        c.lookup(A, "second", 7, &policy())
            .unwrap()
            .availability_until,
        Some(37)
    );
}

#[test]
fn mutation_authorization_distinguishes_read_write_and_restore() {
    struct ReadOnly;
    impl Authority for ReadOnly {
        fn is_current(&self) -> bool {
            true
        }
        fn permits(&self, _: &Reference, action: Action) -> bool {
            action == Action::Read
        }
    }
    let mut c = MemoryCatalogue::default();
    tx(&mut c, 1, begin("object", 0, G), 1);
    assert_eq!(
        c.transact(
            A,
            OperationId(2),
            Mutation::CommitUpload {
                intent: OperationId(1),
                copy: copy(G, "copy/10")
            },
            2,
            &ReadOnly
        ),
        Err(Error::Unavailable)
    );
    let archive = match tx(
        &mut c,
        2,
        Mutation::CommitUpload {
            intent: OperationId(1),
            copy: copy(G, "copy/10"),
        },
        2,
    ) {
        Outcome::Committed { archive, .. } => archive,
        _ => panic!("expected commit"),
    };
    qualify(&mut c, G, archive);
    assert!(c.lookup(A, "object", 5, &ReadOnly).is_ok());
    assert_eq!(
        c.transact(
            A,
            OperationId(3),
            Mutation::RequestRestore {
                name: "object".into(),
                expected_revision: 1,
                profile: "standard".into(),
                deadline: 100,
                availability_for: 30
            },
            5,
            &ReadOnly
        ),
        Err(Error::Unavailable)
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
