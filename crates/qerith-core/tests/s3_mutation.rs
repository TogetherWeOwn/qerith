use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use qerith_core::{
    catalogue::*,
    s3::{self, mutation::*},
};
use sha2::{Digest, Sha256};

const NOW: i64 = 1369353600;
const T: TenantId = TenantId(1);

struct Auth {
    read: bool,
    write: bool,
    active: bool,
    denied: Option<String>,
}
impl Authority for Auth {
    fn is_current(&self) -> bool {
        self.active
    }
    fn permits(&self, r: &Reference, a: Action) -> bool {
        self.active
            && r.tenant == T
            && self.denied.as_ref() != Some(&r.name)
            && match a {
                Action::Read => self.read,
                Action::Write => self.write,
                Action::Restore => self.read,
            }
    }
}
fn auth() -> Auth {
    Auth {
        read: true,
        write: true,
        active: true,
        denied: None,
    }
}
struct WireAuth {
    secret: [u8; 32],
}
impl WireAuth {
    fn new() -> Self {
        use std::io::Read;
        let mut secret = [0; 32];
        // Linux CI fixture only: fresh OS entropy, no service credential or I/O
        // beyond the local random device. Never suppress the key-analysis rule.
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut secret)
            .unwrap();
        Self { secret }
    }
}
impl s3::Authority for WireAuth {
    fn credential(&self, _: &str) -> Option<s3::Credential<'_>> {
        Some(s3::Credential {
            principal: "fixture",
            secret: &self.secret,
        })
    }
    fn authorize(&self, _: &str, _: &str, _: &s3::Target) -> bool {
        true
    }
}
fn policy() -> s3::Policy {
    s3::Policy::new(
        "s3.example.invalid".into(),
        "fixture".into(),
        s3::Limits {
            target_bytes: 8192,
            control_xml_bytes: 8192,
            header_bytes: 16384,
            header_count: 64,
            query_pairs: 64,
            upload_bytes: 1024,
            min_restore_days: 1,
            max_restore_days: 7,
            clock_skew_seconds: 900,
            presign_seconds: 60,
        },
    )
    .unwrap()
}
fn mutation_policy() -> MutationPolicy {
    MutationPolicy {
        object_bytes: 32,
        part_bytes: 16,
        min_part_bytes: 2,
        parts: 10,
        sessions: 8,
        staged_bytes: 64,
        batch_keys: 10,
        lifetime: 100,
        archive_window: 200,
        result_retention: 30,
        max_attempts: 10,
    }
}
fn bucket() -> s3::Target {
    s3::Target::parse("/archive?delete", &policy()).unwrap()
}
fn model() -> MemoryMutations {
    MemoryMutations::new(mutation_policy()).unwrap()
}
fn reference(name: &str) -> Reference {
    Reference {
        tenant: T,
        name: name.into(),
    }
}
fn metadata() -> UploadMetadata {
    UploadMetadata {
        headers: BTreeMap::from([
            ("content-type".into(), "application/octet-stream".into()),
            ("x-amz-meta-fixture".into(), "preserved".into()),
        ]),
        recovery_ref: "fixture/recovery".into(),
        encryption_context: "fixture/context".into(),
    }
}
fn prepare(m: &MemoryMutations, name: &str) -> PreparedWrite {
    m.prepare(
        reference(name),
        metadata(),
        DestinationConditions::default(),
        None,
        1,
        &auth(),
    )
    .unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
fn body_with(
    bytes: &[u8],
    algorithm: Option<s3::ChecksumAlgorithm>,
    extra: &[(&str, &str)],
) -> s3::Result<ValidatedBody> {
    let length = bytes.len().to_string();
    let digest = match algorithm {
        Some(s3::ChecksumAlgorithm::Sha256) => STANDARD.encode(Sha256::digest(bytes)),
        Some(s3::ChecksumAlgorithm::Crc32) => STANDARD.encode(crc32fast::hash(bytes).to_be_bytes()),
        None => String::new(),
    };
    let mut fields = vec![
        ("host", "s3.example.invalid"),
        ("content-length", &length),
        ("x-amz-date", "20130524T000000Z"),
        ("x-amz-content-sha256", "UNSIGNED-PAYLOAD"),
    ];
    if let Some(a) = algorithm {
        fields.push((a.header(), &digest));
    }
    fields.extend_from_slice(extra);
    let p = policy();
    let unsigned = s3::Headers::new(&fields, &p)?;
    let target = s3::Target::parse("/bucket/key", &p)?;
    let mut names: Vec<_> = fields.iter().map(|(name, _)| *name).collect();
    names.sort_unstable();
    let signed = names.join(";");
    let canonical = s3::canonical_request(
        "PUT",
        &target,
        &unsigned,
        &signed,
        "UNSIGNED-PAYLOAD",
        false,
    )?;
    let authority = WireAuth::new();
    let signing_secret = [b"AWS4".as_slice(), authority.secret.as_slice()].concat();
    let key = hmac(
        &hmac(
            &hmac(&hmac(&signing_secret, b"20130524"), b"fixture"),
            b"s3",
        ),
        b"aws4_request",
    );
    let string = format!(
        "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/fixture/s3/aws4_request\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential=fixture/20130524/fixture/s3/aws4_request, SignedHeaders={signed}, Signature={}",
        hex(&hmac(&key, string.as_bytes()))
    );
    fields.push(("authorization", &authorization));
    let headers = s3::Headers::new(&fields, &p)?;
    let verified = s3::verify("PUT", &target, &headers, true, NOW, &p, &authority)?;
    assert_eq!(
        s3::verify("PUT", &target, &headers, true, NOW, &p, &WireAuth::new()).err(),
        Some(s3::ErrorCode::SignatureDoesNotMatch)
    );
    ValidatedBody::new(bytes.to_vec(), &headers, &verified, &p)
}
fn body(bytes: &[u8]) -> ValidatedBody {
    body_with(bytes, None, &[]).unwrap()
}
fn put(m: &mut MemoryMutations, name: &str, bytes: &[u8]) -> CommitResult {
    m.put(prepare(m, name), body(bytes), 2, &auth()).unwrap()
}
fn initiate(m: &mut MemoryMutations, name: &str, checksum: MultipartChecksum) -> UploadId {
    m.initiate(prepare(m, name), checksum, 2, &auth()).unwrap()
}
fn part(
    m: &mut MemoryMutations,
    name: &str,
    id: UploadId,
    number: u16,
    bytes: &[u8],
) -> PartEvidence {
    m.upload_part(&reference(name), id, number, body(bytes), 3, &auth())
        .unwrap()
}
fn restore(m: &mut MemoryMutations, name: &str) {
    let c = m.catalogue_worker();
    let view = c.lookup(T, name, 3, &auth()).unwrap();
    let archive = c
        .outbox(T)
        .into_iter()
        .find_map(|e| match e.effect {
            Effect::RunJob(j) if j.generation == view.generation && j.kind == JobKind::Archive => {
                Some(j.id)
            }
            _ => None,
        })
        .unwrap();
    // Synthetic assertions only: not a live qualification or eviction proof.
    for backbone in [1, 2] {
        c.record_verification(
            T,
            VerificationEvidence {
                generation: view.generation,
                backbone: BackboneId(backbone),
                reconstructed: view.metadata.identity.clone(),
                verified_at: 3,
                valid_until: 90,
                verifier_version: "fixture".into(),
                provenance_ref: "fixture/reconstruction".into(),
                readability_ref: "fixture/readability".into(),
            },
            IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "fixture".into(),
                decision_ref: "fixture-not-real-qualification".into(),
                valid_until: 90,
            },
            3,
        )
        .unwrap();
    }
    let fence = c.claim(T, archive, 3, 90).unwrap();
    c.transition(T, fence, Transition::CompleteArchive, 4, &auth())
        .unwrap();
    let Outcome::Restore(job) = c
        .transact(
            T,
            OperationId(10_000 + view.generation.0),
            Mutation::RequestRestore {
                name: name.into(),
                expected_revision: view.revision,
                profile: "fixture".into(),
                deadline: 90,
                availability_for: 30,
            },
            5,
            &auth(),
        )
        .unwrap()
    else {
        panic!("restore")
    };
    let fence = c.claim(T, job, 6, 80).unwrap();
    c.transition(
        T,
        fence,
        Transition::PublishRestore {
            copy: CompleteCopy {
                identity: view.metadata.identity,
                checksums: view.metadata.checksums,
                location: format!("fixture/{}/{}/retained", T.0, view.generation.0),
                receipt: "fixture/verified".into(),
            },
        },
        7,
        &auth(),
    )
    .unwrap();
}
fn source(result: &CommitResult, name: &str) -> CopySource {
    CopySource {
        reference: reference(name),
        generation: result.generation,
        conditions: s3::Conditions::default(),
    }
}

#[test]
fn put_empty_binary_overwrite_and_atomic_archival_obligation() {
    let mut m = model();
    let first = put(&mut m, "key", b"");
    let a = m.catalogue().lookup(T, "key", 2, &auth()).unwrap();
    assert_eq!(a.metadata.identity.length, 0);
    assert_eq!(a.availability_until, None);
    assert_eq!(m.catalogue().outbox(T).len(), 1);
    restore(&mut m, "key");
    let second = m
        .put(prepare(&m, "key"), body(&[0, 255, 128]), 8, &auth())
        .unwrap();
    let b = m.catalogue().lookup(T, "key", 8, &auth()).unwrap();
    assert_ne!(first.generation, second.generation);
    assert_ne!(first.etag, second.etag);
    assert_eq!(
        b.metadata.identity.sha256,
        <[u8; 32]>::from(Sha256::digest([0, 255, 128]))
    );
    assert_eq!(b.availability_until, None);
    assert_eq!(b.metadata.headers, metadata().headers);
    assert_eq!(second.put_response().status, 200);
}

#[test]
fn failed_commit_rolls_back_begin_intent_and_generation_reservation() {
    struct DenyCommit(std::cell::Cell<usize>);
    impl Authority for DenyCommit {
        fn is_current(&self) -> bool {
            true
        }
        fn permits(&self, _: &Reference, action: Action) -> bool {
            assert_eq!(action, Action::Write);
            let call = self.0.get() + 1;
            self.0.set(call);
            // Final target and write_target, then BeginUpload; deny CommitUpload.
            call <= 3
        }
    }
    let mut m = model();
    let authority = DenyCommit(std::cell::Cell::new(0));
    assert_eq!(
        m.put(prepare(&m, "key"), body(b"data"), 2, &authority),
        Err(s3::ErrorCode::AccessDenied)
    );
    assert_eq!(authority.0.get(), 4);
    // A fresh catalogue allocates generation 1, begin 2 and commit 3.
    for operation in [OperationId(2), OperationId(3)] {
        assert_eq!(
            m.catalogue().reconcile(T, operation, &auth()),
            Ok(Reconciliation::Absent)
        );
    }
    assert!(m.catalogue().outbox(T).is_empty());
    assert!(m.catalogue().lookup(T, "key", 2, &auth()).is_err());
    assert_eq!(
        m.catalogue_worker().transact(
            T,
            OperationId(4),
            Mutation::BeginUpload {
                name: "key".into(),
                expected_revision: 0,
                generation: GenerationId(1),
                metadata: CiphertextMetadata {
                    identity: CiphertextIdentity {
                        length: 4,
                        sha256: Sha256::digest(b"data").into()
                    },
                    validator: "fixture-retry".into(),
                    modified_at: 2,
                    headers: metadata().headers,
                    checksums: vec![],
                    recovery_ref: metadata().recovery_ref,
                },
                archive_deadline: 202,
            },
            2,
            &auth(),
        ),
        Ok(Outcome::UploadIntent(OperationId(4)))
    );
}

#[test]
fn late_completion_gets_a_fresh_archive_window_and_invalid_windows_never_publish() {
    let mut m = model();
    let id = initiate(&mut m, "archive/key", MultipartChecksum::None);
    let p = part(&mut m, "archive/key", id, 1, b"late");
    let result = m
        .complete(&reference("archive/key"), id, vec![p], None, 100, &auth())
        .unwrap();
    let job = m
        .catalogue()
        .outbox(T)
        .into_iter()
        .find_map(|e| match e.effect {
            Effect::RunJob(j) if j.generation == result.generation => Some(j),
            _ => None,
        })
        .unwrap();
    assert_eq!(job.deadline, 300);
    m.catalogue_worker().claim(T, job.id, 102, 150).unwrap();

    let mut p = mutation_policy();
    p.archive_window = 0;
    assert!(MemoryMutations::new(p).is_err());
    let mut p = mutation_policy();
    p.archive_window = u64::MAX;
    let mut m = MemoryMutations::new(p).unwrap();
    assert_eq!(
        m.put(prepare(&m, "key"), body(b"no"), 2, &auth()),
        Err(s3::ErrorCode::InvalidArgument)
    );
    assert!(m.catalogue().outbox(T).is_empty());
    assert!(m.catalogue().lookup(T, "key", 2, &auth()).is_err());
}

#[test]
fn worker_deletion_reclaims_only_dispatched_retained_bytes() {
    let mut m = model();
    let first = put(&mut m, "source", b"retained");
    let other = put(&mut m, "other", b"keep");
    restore(&mut m, "source");
    assert_eq!(m.retained_bytes(T), 12);
    assert_eq!(
        m.catalogue().candidate(
            T,
            first.generation,
            DeletionKind::UnreferencedGeneration,
            38,
            39,
            &auth()
        ),
        Err(Error::Unsafe)
    );
    m.delete(
        &reference("source"),
        &DestinationConditions::default(),
        38,
        &auth(),
    )
    .unwrap();
    let candidate = m
        .catalogue()
        .candidate(
            T,
            first.generation,
            DeletionKind::UnreferencedGeneration,
            38,
            39,
            &auth(),
        )
        .unwrap();
    let event = m
        .catalogue_worker()
        .finalize_deletion(candidate, 39, &auth())
        .unwrap();
    assert!(m.delete_retained(TenantId(2), event, 40, &auth()).is_err());
    assert!(m.delete_retained(T, event, 90, &auth()).is_err());
    assert!(m
        .delete_retained(
            T,
            event,
            40,
            &Auth {
                active: false,
                ..auth()
            }
        )
        .is_err());
    assert_eq!(m.retained_bytes(T), 12);
    m.delete_retained(T, event, 40, &auth()).unwrap();
    assert_eq!(m.retained_bytes(T), 4);
    assert_eq!(
        m.catalogue()
            .generation(T, first.generation)
            .unwrap()
            .cache_location,
        None
    );
    assert!(m
        .catalogue()
        .generation(T, other.generation)
        .unwrap()
        .cache_location
        .is_some());
    assert!(m.delete_retained(T, event, 41, &auth()).is_err());
    assert_eq!(m.retained_bytes(T), 4);
}

#[test]
fn decoded_xml_forbidden_destinations_never_publish_or_complete() {
    for path in [
        "/archive/a%00b",
        "/archive/a%01b",
        "/archive/a%0Bb",
        "/archive/a%1Fb",
        "/archive/a%EF%BF%BEb",
        "/archive/a%EF%BF%BFb",
    ] {
        let mut m = model();
        let target = s3::Target::parse(path, &policy()).unwrap();
        let name = format!("{}/{}", target.bucket, target.key.as_ref().unwrap());
        let attempt = (|| -> s3::Result<s3::Response> {
            let prepared = m.prepare(
                reference(&name),
                metadata(),
                DestinationConditions::default(),
                None,
                1,
                &auth(),
            )?;
            let id = m.initiate(prepared, MultipartChecksum::None, 2, &auth())?;
            let evidence = part(&mut m, &name, id, 1, b"data");
            m.complete(&reference(&name), id, vec![evidence], None, 4, &auth())?
                .complete_response(&target, &policy())
        })();
        assert_eq!(attempt, Err(s3::ErrorCode::InvalidArgument), "{path}");
        assert!(m.catalogue().lookup(T, &name, 4, &auth()).is_err());
        assert!(m.catalogue().outbox(T).is_empty());
        assert_eq!(m.retained_bytes(T), 0);
        let cleanup = m.cleanup(200, mutation_policy().sessions).unwrap();
        assert_eq!(cleanup.examined, 0);
        assert_eq!(cleanup.removed, 0);
    }
}

#[test]
fn operation_specific_xml_round_trips_destination_and_commit_time() {
    let mut m = model();
    let first = put(&mut m, "source", b"source");
    restore(&mut m, "source");
    let name = "archive/a<&\t\n\r/雪\u{fffd}\u{10000}";
    let result = m
        .copy_object(
            prepare(&m, name),
            source(&first, "source"),
            MetadataDirective::Copy,
            8,
            &auth(),
        )
        .unwrap();
    let response = result.copy_response();
    let text = String::from_utf8(response.body).unwrap();
    assert!(text.contains("<LastModified>1970-01-01T00:00:08Z</LastModified>"));
    assert!(!text.contains("<Bucket>"));
    let target = s3::Target::parse(
        "/archive/a%3C%26%09%0A%0D/%E9%9B%AA%EF%BF%BD%F0%90%80%80?uploadId=1",
        &policy(),
    )
    .unwrap();
    let response = result.complete_response(&target, &policy()).unwrap();
    let mut reader = quick_xml::Reader::from_reader(response.body.as_slice());
    let mut fields = BTreeMap::new();
    let mut tag = String::new();
    let mut value = String::new();
    loop {
        match reader.read_event().unwrap() {
            quick_xml::events::Event::Start(e) => {
                tag = e.name().as_ref().to_owned();
                value.clear();
            }
            quick_xml::events::Event::Text(e) => value.push_str(&e.xml10_content()),
            quick_xml::events::Event::GeneralRef(e) => {
                let entity = e.as_ref();
                let decoded = quick_xml::escape::unescape(&format!("&{entity};"))
                    .unwrap()
                    .into_owned();
                value.push_str(&decoded);
            }
            quick_xml::events::Event::End(_) => {
                fields.insert(tag.clone(), value.clone());
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
    }
    assert_eq!(fields["Bucket"], "archive");
    assert_eq!(fields["Key"], "a<&\t\n\r/雪\u{fffd}\u{10000}");
    assert_eq!(
        fields["Location"],
        "https://s3.example.invalid/archive/a%3C%26%09%0A%0D/%E9%9B%AA%EF%BF%BD%F0%90%80%80"
    );
    assert_eq!(fields["ETag"], result.etag);
    let wrong = s3::Target::parse("/archive/wrong", &policy()).unwrap();
    assert_eq!(
        result.complete_response(&wrong, &policy()).unwrap_err(),
        s3::ErrorCode::InvalidArgument
    );
}

#[test]
fn decoded_validation_rejects_integrity_framing_and_encryption_before_commit() {
    for extra in [
        vec![("content-md5", "AAAA")],
        vec![("transfer-encoding", "chunked")],
        vec![("content-encoding", "aws-chunked")],
        vec![("x-amz-server-side-encryption", "AES256")],
        vec![("x-amz-checksum-crc64nvme", "AAAA")],
        vec![("x-amz-checksum-type", "COMPOSITE")],
    ] {
        assert!(body_with(b"abc", None, &extra).is_err(), "{extra:?}");
    }
    assert_eq!(
        body_with(b"abc", None, &[("content-md5", "AAAAAAAAAAAAAAAAAAAAAA==")]).unwrap_err(),
        s3::ErrorCode::BadDigest
    );
    let mut m = model();
    let result = m
        .put(
            prepare(&m, "checked"),
            body_with(b"abc", Some(s3::ChecksumAlgorithm::Crc32), &[]).unwrap(),
            2,
            &auth(),
        )
        .unwrap();
    let view = m.catalogue().lookup(T, "checked", 2, &auth()).unwrap();
    assert_eq!(view.metadata.checksums[0].algorithm, "CRC32");
    assert_eq!(result.checksum.unwrap().kind, ChecksumType::FullObject);
}

#[test]
fn predicates_fail_412_but_competing_unconditional_commit_fails_409() {
    let mut m = model();
    let pending = prepare(&m, "key");
    let first = put(&mut m, "key", b"first");
    assert_eq!(
        m.put(pending, body(b"stale"), 3, &auth()),
        Err(s3::ErrorCode::ConditionalRequestConflict)
    );
    assert_eq!(s3::ErrorCode::ConditionalRequestConflict.status(), 409);
    let condition = DestinationConditions {
        if_match: Some(first.etag),
        if_none_match: false,
    };
    let pending = m
        .prepare(reference("key"), metadata(), condition, None, 3, &auth())
        .unwrap();
    put(&mut m, "key", b"next");
    assert_eq!(
        m.put(pending, body(b"stale"), 4, &auth()),
        Err(s3::ErrorCode::PreconditionFailed)
    );
    assert_eq!(s3::ErrorCode::PreconditionFailed.status(), 412);
    assert!(m
        .prepare(
            reference("key"),
            metadata(),
            DestinationConditions {
                if_match: None,
                if_none_match: true
            },
            None,
            3,
            &auth()
        )
        .is_err());
}

#[test]
fn tombstones_preserve_revision_and_write_only_authority() {
    let mut m = model();
    let write_only = Auth {
        read: false,
        ..auth()
    };
    let p = m
        .prepare(
            reference("key"),
            metadata(),
            DestinationConditions::default(),
            None,
            1,
            &write_only,
        )
        .unwrap();
    m.put(p, body(b"one"), 2, &write_only).unwrap();
    assert!(m.catalogue().lookup(T, "key", 3, &write_only).is_err());
    let (revision, target) = m
        .catalogue()
        .write_target(T, "key", 3, &write_only)
        .unwrap();
    assert_eq!(revision, 1);
    // Exhaustive destructuring keeps this public write-only projection narrow.
    let WriteTarget { validator } = target.unwrap();
    let current = m.catalogue().lookup(T, "key", 3, &auth()).unwrap();
    assert_eq!(validator, current.metadata.validator);
    let matched = DestinationConditions {
        if_match: Some(validator),
        if_none_match: false,
    };
    assert!(m
        .prepare(
            reference("key"),
            metadata(),
            matched.clone(),
            None,
            3,
            &write_only
        )
        .is_ok());
    assert_eq!(
        m.prepare(
            reference("key"),
            metadata(),
            DestinationConditions {
                if_match: Some("\"wrong\"".into()),
                if_none_match: false,
            },
            None,
            3,
            &write_only
        )
        .err(),
        Some(s3::ErrorCode::PreconditionFailed)
    );
    assert_eq!(
        m.delete(&reference("key"), &matched, 3, &write_only)
            .unwrap()
            .status,
        204
    );
    let (revision, view) = m
        .catalogue()
        .write_target(T, "key", 3, &write_only)
        .unwrap();
    assert_eq!(revision, 2);
    assert!(view.is_none());
    let p = m
        .prepare(
            reference("key"),
            metadata(),
            DestinationConditions::default(),
            None,
            4,
            &write_only,
        )
        .unwrap();
    m.put(p, body(b"two"), 5, &write_only).unwrap();
    assert_eq!(
        m.catalogue().lookup(T, "key", 5, &auth()).unwrap().revision,
        3
    );
    assert_eq!(
        m.delete(
            &reference("missing"),
            &DestinationConditions::default(),
            5,
            &auth()
        )
        .unwrap()
        .status,
        204
    );
}

#[test]
fn revoked_authority_and_moderation_never_become_absence() {
    let mut m = model();
    let p = prepare(&m, "key");
    assert_eq!(
        m.put(
            p,
            body(b"no"),
            2,
            &Auth {
                active: false,
                ..auth()
            }
        ),
        Err(s3::ErrorCode::AccessDenied)
    );
    assert!(m.catalogue().outbox(T).is_empty());
    let r = put(&mut m, "key", b"yes");
    m.catalogue_worker()
        .set_moderation(T, r.generation, 1, true)
        .unwrap();
    assert!(m.catalogue().write_target(T, "key", 3, &auth()).is_err());
    assert!(m
        .prepare(
            reference("key"),
            metadata(),
            DestinationConditions::default(),
            None,
            3,
            &auth()
        )
        .is_err());
}

#[test]
fn out_of_order_arrival_replaced_and_duplicate_part_evidence() {
    let mut m = model();
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p2 = part(&mut m, "key", id, 2, b"two");
    let stale = part(&mut m, "key", id, 1, b"old");
    let p1 = part(&mut m, "key", id, 1, b"new");
    assert_ne!(stale.etag, p1.etag);
    assert_eq!(
        m.complete(
            &reference("key"),
            id,
            vec![stale, p2.clone()],
            None,
            4,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidPart)
    );
    assert_eq!(
        m.complete(
            &reference("key"),
            id,
            vec![p2.clone(), p1.clone()],
            None,
            4,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidPartOrder)
    );
    assert_eq!(
        m.complete(
            &reference("key"),
            id,
            vec![p1.clone(), p1.clone()],
            None,
            4,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidPartOrder)
    );
    let result = m
        .complete(&reference("key"), id, vec![p1, p2], None, 4, &auth())
        .unwrap();
    assert_eq!(
        m.catalogue()
            .generation(T, result.generation)
            .unwrap()
            .metadata
            .identity
            .sha256,
        <[u8; 32]>::from(Sha256::digest(b"newtwo"))
    );
}

#[test]
fn concurrent_parts_are_serializable_and_completion_never_splices_replacements() {
    let m = std::sync::Arc::new(std::sync::Mutex::new(model()));
    let id = initiate(&mut m.lock().unwrap(), "key", MultipartChecksum::None);
    let mut threads = vec![];
    for number in [3, 1, 2] {
        let m = m.clone();
        threads.push(std::thread::spawn(move || {
            part(
                &mut m.lock().unwrap(),
                "key",
                id,
                number,
                &[number as u8; 2],
            )
        }));
    }
    let mut evidence: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    evidence.sort_by_key(|p| p.number);
    let mut m = m.lock().unwrap();
    let result = m
        .complete(&reference("key"), id, evidence, None, 4, &auth())
        .unwrap();
    assert_eq!(
        m.catalogue()
            .generation(T, result.generation)
            .unwrap()
            .metadata
            .identity
            .sha256,
        <[u8; 32]>::from(Sha256::digest([1, 1, 2, 2, 3, 3]))
    );
}

#[test]
fn completion_abort_and_overwrite_have_one_publication_winner() {
    let mut m = model();
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p = part(&mut m, "key", id, 1, b"bytes");
    assert_eq!(
        m.abort(&reference("key"), id, 4, &auth()).unwrap().status,
        204
    );
    assert_eq!(
        m.complete(&reference("key"), id, vec![p], None, 5, &auth()),
        Err(s3::ErrorCode::NoSuchUpload)
    );
    assert!(m.catalogue().outbox(T).is_empty());
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p = part(&mut m, "key", id, 1, b"parts");
    let winner = put(&mut m, "key", b"overwrite");
    assert_eq!(
        m.complete(&reference("key"), id, vec![p], None, 5, &auth()),
        Err(s3::ErrorCode::ConditionalRequestConflict)
    );
    assert_eq!(
        m.catalogue()
            .lookup(T, "key", 5, &auth())
            .unwrap()
            .generation,
        winner.generation
    );
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p = part(&mut m, "key", id, 1, b"complete");
    let winner = m
        .complete(&reference("key"), id, vec![p], None, 6, &auth())
        .unwrap();
    assert_eq!(
        m.abort(&reference("key"), id, 7, &auth()).unwrap_err(),
        s3::ErrorCode::NoSuchUpload
    );
    assert_eq!(
        m.catalogue()
            .lookup(T, "key", 7, &auth())
            .unwrap()
            .generation,
        winner.generation
    );
}

#[test]
fn lost_completion_response_reconciles_exact_request_after_overwrite() {
    let mut m = model();
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p = part(&mut m, "key", id, 1, b"complete");
    let accepted = m
        .complete(&reference("key"), id, vec![p.clone()], None, 4, &auth())
        .unwrap();
    let mut recovered = m.clone();
    let successor = put(&mut recovered, "key", b"successor");
    assert_eq!(
        recovered
            .complete(&reference("key"), id, vec![p.clone()], None, 6, &auth())
            .unwrap(),
        accepted
    );
    assert_eq!(
        recovered
            .catalogue()
            .lookup(T, "key", 6, &auth())
            .unwrap()
            .generation,
        successor.generation
    );
    let mut changed = p;
    changed.etag = "\"wrong\"".into();
    assert_eq!(
        recovered.complete(&reference("key"), id, vec![changed], None, 6, &auth()),
        Err(s3::ErrorCode::InvalidPart)
    );
}

#[test]
fn full_and_composite_integrity_preserve_algorithm_and_part_evidence() {
    for mode in [
        MultipartChecksum::Full(s3::ChecksumAlgorithm::Sha256),
        MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32),
        MultipartChecksum::CompositeSha256,
    ] {
        let mut m = model();
        let id = initiate(&mut m, "archive/key", mode);
        let algorithm = if mode == MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32) {
            s3::ChecksumAlgorithm::Crc32
        } else {
            s3::ChecksumAlgorithm::Sha256
        };
        let p1 = m
            .upload_part(
                &reference("archive/key"),
                id,
                1,
                body_with(b"ab", Some(algorithm), &[]).unwrap(),
                3,
                &auth(),
            )
            .unwrap();
        let p2 = m
            .upload_part(
                &reference("archive/key"),
                id,
                2,
                body_with(b"cd", Some(algorithm), &[]).unwrap(),
                3,
                &auth(),
            )
            .unwrap();
        let full = match mode {
            MultipartChecksum::Full(s3::ChecksumAlgorithm::Sha256) => {
                Some(Sha256::digest(b"abcd").to_vec())
            }
            MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32) => {
                Some(crc32fast::hash(b"abcd").to_be_bytes().to_vec())
            }
            _ => None,
        };
        let result = m
            .complete(
                &reference("archive/key"),
                id,
                vec![p1.clone(), p2.clone()],
                full.clone(),
                4,
                &auth(),
            )
            .unwrap();
        let c = result.checksum.as_ref().unwrap();
        assert_eq!(c.parts, vec![p1.checksum.unwrap(), p2.checksum.unwrap()]);
        if mode == MultipartChecksum::CompositeSha256 {
            assert_eq!(c.kind, ChecksumType::Composite);
            let mut expected = Sha256::new();
            expected.update(Sha256::digest(b"ab"));
            expected.update(Sha256::digest(b"cd"));
            assert_eq!(c.value, expected.finalize().to_vec());
        } else {
            assert_eq!(c.kind, ChecksumType::FullObject);
            assert_eq!(Some(&c.value), full.as_ref());
        }
        let response = result
            .complete_response(
                &s3::Target::parse("/archive/key", &policy()).unwrap(),
                &policy(),
            )
            .unwrap();
        assert_eq!(
            completion_result(response.status, &response.body, &policy()).unwrap(),
            result.etag
        );
        assert_eq!(
            m.catalogue()
                .lookup(T, "archive/key", 4, &auth())
                .unwrap()
                .metadata
                .checksums,
            vec![c.clone()]
        );
    }
}

#[test]
fn typed_delete_rejects_all_invalid_keys_before_any_mutation() {
    for bad in [
        "bad\0key",
        "bad\u{1}key",
        "bad\u{b}key",
        "bad\u{fffe}key",
        "bad\u{ffff}key",
    ] {
        for quiet in [false, true] {
            let mut m = model();
            put(&mut m, "archive/keep", b"keep");
            let before = m.catalogue().lookup(T, "archive/keep", 4, &auth()).unwrap();
            let events = m.catalogue().outbox(T);
            for authority in [
                auth(),
                Auth {
                    denied: Some(format!("archive/{bad}")),
                    ..auth()
                },
            ] {
                assert_eq!(
                    m.delete_objects(
                        T,
                        &bucket(),
                        DeleteRequest {
                            keys: vec!["keep".into(), bad.into()],
                            quiet,
                        },
                        4,
                        &authority
                    )
                    .err(),
                    Some(s3::ErrorCode::InvalidRequest)
                );
                assert_eq!(
                    m.catalogue().lookup(T, "archive/keep", 4, &auth()).unwrap(),
                    before
                );
                assert_eq!(m.catalogue().outbox(T), events);
            }
        }
    }
    for key in ["雪�😀", "tab\tkey", "line\nkey", "carriage\rkey"] {
        let mut m = model();
        put(&mut m, &format!("archive/{key}"), b"keep");
        let response = m
            .delete_objects(
                T,
                &bucket(),
                DeleteRequest {
                    keys: vec![key.into()],
                    quiet: false,
                },
                4,
                &auth(),
            )
            .unwrap();
        assert_eq!(response.status, 200);
        let xml = String::from_utf8(response.body).unwrap();
        let delete = xml
            .replace("DeleteResult", "Delete")
            .replace("Deleted", "Object");
        assert_eq!(
            parse_delete(delete.as_bytes(), &policy(), mutation_policy().batch_keys)
                .unwrap()
                .keys,
            vec![key]
        );
        assert!(m
            .catalogue()
            .lookup(T, &format!("archive/{key}"), 4, &auth())
            .is_err());
    }
}

impl s3::archive::Session for Auth {
    fn tenant(&self) -> TenantId {
        T
    }
    fn principal(&self) -> &str {
        "fixture"
    }
    fn allows(&self, _: s3::archive::Operation, _: &str) -> bool {
        self.active
    }
}
struct ReadClock;
impl s3::archive::Clock for ReadClock {
    fn now(&self) -> u64 {
        8
    }
}
struct NoCapacity;
impl s3::archive::CapacityPort for NoCapacity {
    fn reserve(
        &mut self,
        _: TenantId,
        _: &str,
        _: OperationId,
        _: GenerationId,
        _: u64,
    ) -> s3::Result<CapacityReservation> {
        panic!("read must not reserve restore capacity")
    }
}
struct ReadCache {
    generation: GenerationId,
    calls: usize,
}
impl s3::archive::QualifiedCache for ReadCache {
    fn read(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        identity: &CiphertextIdentity,
        location: &str,
        _: PinId,
        range: Option<s3::ByteRange>,
    ) -> s3::Result<Vec<u8>> {
        self.calls += 1;
        assert_eq!(tenant, T);
        assert_eq!(generation, self.generation);
        assert_eq!(identity.sha256, <[u8; 32]>::from(Sha256::digest(b"abcd")));
        assert_eq!(
            location,
            format!("fixture/{}/{}/retained", T.0, generation.0)
        );
        let range = range.unwrap();
        Ok(b"abcd"[range.start as usize..=range.end as usize].to_vec())
    }
}

#[test]
fn full_checksum_projection_preserves_and_validates_part_evidence() {
    for algorithm in [s3::ChecksumAlgorithm::Sha256, s3::ChecksumAlgorithm::Crc32] {
        let size = if algorithm == s3::ChecksumAlgorithm::Sha256 {
            32
        } else {
            4
        };
        let full = STANDARD.encode(vec![0; size]);
        let parts = vec![
            STANDARD.encode(vec![1; size]),
            STANDARD.encode(vec![2; size]),
        ];
        let stored =
            s3::StoredChecksum::full_with_parts(algorithm, full.clone(), parts.clone()).unwrap();
        assert_eq!(stored.parts(), parts);
        assert_eq!(stored.value(), full);
        assert_eq!(stored.checksum_type(), "FULL_OBJECT");
        assert!(s3::StoredChecksum::full_with_parts(
            algorithm,
            full.clone(),
            vec![STANDARD.encode(vec![0; size - 1])]
        )
        .is_err());
        assert!(s3::StoredChecksum::full_with_parts(
            algorithm,
            full.clone(),
            vec!["not base64".into()]
        )
        .is_err());
        assert!(s3::StoredChecksum::full_with_parts(
            algorithm,
            full.clone(),
            vec![parts[0].clone(); 10_001]
        )
        .is_err());
        assert!(s3::StoredChecksum::full_with_parts(
            algorithm,
            STANDARD.encode(vec![0; size - 1]),
            parts
        )
        .is_err());
    }
}

#[test]
fn full_multipart_completion_round_trips_through_archive_reads() {
    for algorithm in [s3::ChecksumAlgorithm::Sha256, s3::ChecksumAlgorithm::Crc32] {
        let mut m = model();
        m.catalogue_worker()
            .create_bucket(T, "archive", "fixture", 1)
            .unwrap();
        let id = initiate(&mut m, "archive/key", MultipartChecksum::Full(algorithm));
        let mut parts = Vec::new();
        for (number, bytes) in [(1, b"ab"), (2, b"cd")] {
            parts.push(
                m.upload_part(
                    &reference("archive/key"),
                    id,
                    number,
                    body_with(bytes, Some(algorithm), &[]).unwrap(),
                    3,
                    &auth(),
                )
                .unwrap(),
            );
        }
        let full = match algorithm {
            s3::ChecksumAlgorithm::Sha256 => Sha256::digest(b"abcd").to_vec(),
            s3::ChecksumAlgorithm::Crc32 => crc32fast::hash(b"abcd").to_be_bytes().to_vec(),
        };
        let result = m
            .complete(
                &reference("archive/key"),
                id,
                parts,
                Some(full.clone()),
                4,
                &auth(),
            )
            .unwrap();
        let evidence = result.checksum.unwrap();
        assert_eq!(evidence.parts.len(), 2);
        for restored in [false, true] {
            if restored {
                restore(&mut m, "archive/key");
            }
            let mut reader = s3::archive::Adapter::new(
                m.catalogue().clone(),
                s3::archive::MemoryTokens::new(8, 30).unwrap(),
                policy(),
                s3::archive::AdapterLimits {
                    read_bytes: 32,
                    serving_seconds: 10,
                    restore_job_seconds: 100,
                    scan_batch: 10,
                    scan_entries: 10,
                },
            )
            .unwrap();
            let mut cache = ReadCache {
                generation: result.generation,
                calls: 0,
            };
            for enabled in [false, true] {
                let fields = if enabled {
                    vec![("x-amz-checksum-mode", "ENABLED")]
                } else {
                    vec![]
                };
                let headers = s3::Headers::new(&fields, &policy()).unwrap();
                for method in ["HEAD", "GET"] {
                    let response = reader.handle(
                        method,
                        &s3::Target::parse("/archive/key", &policy()).unwrap(),
                        &headers,
                        b"",
                        &auth(),
                        OperationId(20_000 + u64::from(enabled)),
                        &ReadClock,
                        "fixture-read",
                        &mut cache,
                        &mut NoCapacity,
                    );
                    let expected = if method == "GET" && !restored {
                        403
                    } else {
                        200
                    };
                    assert_eq!(
                        response.status, expected,
                        "{algorithm:?} {method} restored={restored} checksum={enabled}"
                    );
                    if expected == 200 {
                        let header = |name| {
                            response
                                .headers
                                .iter()
                                .find(|(k, _)| k == name)
                                .map(|(_, v)| v.as_str())
                        };
                        assert_eq!(header("etag"), Some(result.etag.as_str()));
                        assert_eq!(
                            header(algorithm.header()),
                            enabled.then(|| STANDARD.encode(&full)).as_deref()
                        );
                        assert_eq!(
                            header("x-amz-checksum-type"),
                            enabled.then_some("FULL_OBJECT")
                        );
                        if method == "GET" {
                            assert_eq!(response.body, b"abcd");
                        }
                    } else {
                        assert!(String::from_utf8(response.body)
                            .unwrap()
                            .contains("InvalidObjectState"));
                    }
                }
            }
            assert_eq!(cache.calls, if restored { 2 } else { 0 });
            assert_eq!(
                reader
                    .catalogue
                    .lookup(T, "archive/key", 8, &auth())
                    .unwrap()
                    .metadata
                    .checksums,
                vec![evidence.clone()]
            );
        }
    }
}

#[test]
fn checksum_missing_wrong_parts_and_wrong_full_digest_never_publish() {
    let mut m = model();
    let id = initiate(
        &mut m,
        "key",
        MultipartChecksum::Full(s3::ChecksumAlgorithm::Sha256),
    );
    assert_eq!(
        m.upload_part(&reference("key"), id, 1, body(b"ab"), 3, &auth())
            .unwrap_err(),
        s3::ErrorCode::InvalidRequest
    );
    let p = m
        .upload_part(
            &reference("key"),
            id,
            1,
            body_with(b"ab", Some(s3::ChecksumAlgorithm::Sha256), &[]).unwrap(),
            3,
            &auth(),
        )
        .unwrap();
    let mut wrong = p.clone();
    wrong.checksum = Some(vec![0; 32]);
    assert_eq!(
        m.complete(
            &reference("key"),
            id,
            vec![wrong],
            Some(vec![0; 32]),
            4,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidPart)
    );
    assert_eq!(
        m.complete(
            &reference("key"),
            id,
            vec![p.clone()],
            Some(vec![0; 32]),
            4,
            &auth()
        ),
        Err(s3::ErrorCode::BadDigest)
    );
    assert_eq!(
        m.complete(&reference("key"), id, vec![p], None, 4, &auth()),
        Err(s3::ErrorCode::BadDigest)
    );
    assert!(m.catalogue().outbox(T).is_empty());
}

#[test]
fn bounded_geometry_pages_retry_budget_and_expiry_cleanup() {
    let mut p = mutation_policy();
    p.max_attempts = 1;
    let mut m = MemoryMutations::new(p).unwrap();
    let id = initiate(&mut m, "key", MultipartChecksum::None);
    let p1 = part(&mut m, "key", id, 1, b"a");
    let p2 = part(&mut m, "key", id, 2, b"bb");
    let page = m
        .list_parts(&reference("key"), id, 0, 1, 4, &auth())
        .unwrap();
    assert_eq!(page.entries[0].evidence, p1);
    assert_eq!(page.next, Some(1));
    assert_eq!(
        m.list_parts(&reference("key"), id, 1, 1, 4, &auth())
            .unwrap()
            .entries[0]
            .evidence,
        p2
    );
    assert_eq!(
        m.complete(&reference("key"), id, vec![p1, p2], None, 4, &auth()),
        Err(s3::ErrorCode::EntityTooSmall)
    );
    assert_eq!(
        m.complete(&reference("key"), id, vec![], None, 4, &auth()),
        Err(s3::ErrorCode::SlowDown)
    );
    assert_eq!(
        m.list_uploads(T, "", 0, 8, 5, &auth())
            .unwrap()
            .entries
            .len(),
        1
    );
    assert!(m
        .list_uploads(
            T,
            "",
            0,
            8,
            5,
            &Auth {
                denied: Some("key".into()),
                ..auth()
            }
        )
        .unwrap()
        .entries
        .is_empty());
    assert_eq!(m.cleanup(101, 1).unwrap().removed, 1);
    assert_eq!(
        m.abort(&reference("key"), id, 102, &auth()).unwrap_err(),
        s3::ErrorCode::NoSuchUpload
    );
    let mut p = mutation_policy();
    p.parts = 0;
    assert!(MemoryMutations::new(p).is_err());
}

#[test]
fn copy_requires_active_source_and_owns_new_generation_metadata_and_archive() {
    let mut m = model();
    let first = put(&mut m, "source", b"source");
    assert_eq!(
        m.copy_object(
            prepare(&m, "dest"),
            source(&first, "source"),
            MetadataDirective::Copy,
            3,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidObjectState)
    );
    restore(&mut m, "source");
    let copied = m
        .copy_object(
            prepare(&m, "dest"),
            source(&first, "source"),
            MetadataDirective::Copy,
            8,
            &auth(),
        )
        .unwrap();
    assert_ne!(copied.generation, first.generation);
    let view = m.catalogue().lookup(T, "dest", 8, &auth()).unwrap();
    assert_eq!(view.availability_until, None);
    assert_eq!(view.metadata.headers, metadata().headers);
    let archive = m.catalogue().outbox(T).into_iter().filter(|e| matches!(&e.effect, Effect::RunJob(j) if j.kind == JobKind::Archive && j.generation == copied.generation)).count();
    assert_eq!(archive, 1);
    let mut replacement = metadata();
    replacement
        .headers
        .insert("x-amz-meta-fixture".into(), "replaced".into());
    replacement.recovery_ref = "own-recovery".into();
    let p = m
        .prepare(
            reference("replacement"),
            replacement.clone(),
            DestinationConditions::default(),
            None,
            8,
            &auth(),
        )
        .unwrap();
    m.copy_object(
        p,
        source(&first, "source"),
        MetadataDirective::Replace,
        8,
        &auth(),
    )
    .unwrap();
    let view = m.catalogue().lookup(T, "replacement", 8, &auth()).unwrap();
    assert_eq!(view.metadata.headers, replacement.headers);
    assert_eq!(view.metadata.recovery_ref, "own-recovery");
}

#[test]
fn copy_source_generation_predicates_context_and_both_authorizations_are_final() {
    let mut m = model();
    let first = put(&mut m, "source", b"source");
    restore(&mut m, "source");
    let mut s = source(&first, "source");
    s.conditions.if_match = Some("\"wrong\"".into());
    assert_eq!(
        m.copy_object(prepare(&m, "dest"), s, MetadataDirective::Copy, 8, &auth()),
        Err(s3::ErrorCode::PreconditionFailed)
    );
    for denied in ["source", "dest"] {
        assert_eq!(
            m.copy_object(
                prepare(&m, "dest"),
                source(&first, "source"),
                MetadataDirective::Copy,
                8,
                &Auth {
                    denied: Some(denied.into()),
                    ..auth()
                }
            ),
            Err(s3::ErrorCode::AccessDenied)
        );
    }
    let mut different = metadata();
    different.encryption_context = "other".into();
    let p = m
        .prepare(
            reference("dest"),
            different,
            DestinationConditions::default(),
            None,
            8,
            &auth(),
        )
        .unwrap();
    assert_eq!(
        m.copy_object(
            p,
            source(&first, "source"),
            MetadataDirective::Copy,
            8,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidRequest)
    );
    put(&mut m, "source", b"successor");
    assert_eq!(
        m.copy_object(
            prepare(&m, "dest"),
            source(&first, "source"),
            MetadataDirective::Copy,
            8,
            &auth()
        ),
        Err(s3::ErrorCode::PreconditionFailed)
    );
    assert!(m.catalogue().lookup(T, "dest", 8, &auth()).is_err());
}

#[test]
fn part_copy_uses_exact_source_range_and_negotiated_part_checksum() {
    let mut m = model();
    let first = put(&mut m, "source", b"012345");
    restore(&mut m, "source");
    let id = initiate(&mut m, "dest", MultipartChecksum::CompositeSha256);
    let p = m
        .upload_part_copy(
            &reference("dest"),
            id,
            1,
            source(&first, "source"),
            Some((1, 3)),
            8,
            &auth(),
        )
        .unwrap();
    assert_eq!(p.checksum, Some(Sha256::digest(b"123").to_vec()));
    let result = m
        .complete(&reference("dest"), id, vec![p], None, 9, &auth())
        .unwrap();
    assert_eq!(
        m.catalogue()
            .lookup(T, "dest", 9, &auth())
            .unwrap()
            .metadata
            .identity
            .sha256,
        <[u8; 32]>::from(Sha256::digest(b"123"))
    );
    assert_eq!(
        m.catalogue()
            .lookup(T, "dest", 9, &auth())
            .unwrap()
            .generation,
        result.generation
    );
}

#[test]
fn deletion_is_per_key_quiet_and_never_erases_referenced_generation() {
    let mut m = model();
    let original = put(&mut m, "archive/source", b"retained");
    m.catalogue_worker()
        .transact(
            T,
            OperationId(9000),
            Mutation::Link {
                source: "archive/source".into(),
                destination: "alias".into(),
                expected_revision: 0,
            },
            3,
            &auth(),
        )
        .unwrap();
    let response = m
        .delete_objects(
            T,
            &bucket(),
            DeleteRequest {
                keys: vec!["source".into(), "denied".into(), "missing".into()],
                quiet: true,
            },
            4,
            &Auth {
                denied: Some("archive/denied".into()),
                ..auth()
            },
        )
        .unwrap();
    let text = String::from_utf8(response.body).unwrap();
    assert!(!text.contains("<Deleted>"));
    assert!(text.contains("<Key>denied</Key><Code>AccessDenied</Code>"));
    assert_eq!(
        m.catalogue()
            .lookup(T, "alias", 4, &auth())
            .unwrap()
            .generation,
        original.generation
    );
    assert!(m
        .catalogue()
        .generation(T, original.generation)
        .unwrap()
        .cache_location
        .is_some());
}

#[test]
fn strict_control_xml_handles_entities_and_rejects_unknown_evidence() {
    let p = policy();
    let delete = parse_delete(
        b"<Delete><Object><Key> a&amp;&lt;&#x96ea; </Key></Object><Quiet>true</Quiet></Delete>",
        &p,
        10,
    )
    .unwrap();
    assert_eq!(delete.keys, [" a&<雪 "]);
    assert!(delete.quiet);
    for bytes in [
        b"<!DOCTYPE Delete><Delete></Delete>".as_slice(),
        b"<Delete><Object><Key>a</Key><VersionId>1</VersionId></Object></Delete>",
        b"<Delete><Quiet>true</Quiet><Quiet>false</Quiet></Delete>",
        b"<Delete><Object><Key>&evil;</Key></Object></Delete>",
        b"<Delete><Object><Key>&#0;</Key></Object></Delete>",
    ] {
        assert!(parse_delete(bytes, &p, 10).is_err());
    }
    let parts = parse_complete(b"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;opaque&quot;</ETag></Part></CompleteMultipartUpload>", &p, 10, MultipartChecksum::None).unwrap();
    assert_eq!(parts[0].etag, "\"opaque\"");
    assert!(parse_complete(b"<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>x</ETag><ChecksumCRC64NVME>x</ChecksumCRC64NVME></Part></CompleteMultipartUpload>", &p, 10, MultipartChecksum::None).is_err());
}

#[test]
fn batch_delete_qualifies_references_without_changing_wire_keys() {
    let mut m = model();
    put(&mut m, "archive/report", b"target");
    put(&mut m, "archive/other/secret", b"nested");
    let unrelated = put(&mut m, "other/secret", b"keep");
    let response = m
        .delete_objects(
            T,
            &bucket(),
            DeleteRequest {
                keys: vec!["report".into(), "other/secret".into()],
                quiet: false,
            },
            4,
            &auth(),
        )
        .unwrap();
    assert!(m
        .catalogue()
        .lookup(T, "archive/report", 4, &auth())
        .is_err());
    assert!(m
        .catalogue()
        .lookup(T, "archive/other/secret", 4, &auth())
        .is_err());
    assert_eq!(
        m.catalogue()
            .lookup(T, "other/secret", 4, &auth())
            .unwrap()
            .generation,
        unrelated.generation
    );
    let xml = String::from_utf8(response.body).unwrap();
    assert!(xml.contains("<Key>report</Key>"));
    assert!(xml.contains("<Key>other/secret</Key>"));
    assert!(!xml.contains("<Key>archive/"));
}

#[test]
fn catalogue_and_adapter_share_collision_free_operation_identity_allocation() {
    let mut m = model();
    put(&mut m, "source", b"first");
    m.catalogue_worker()
        .transact(
            T,
            OperationId(5),
            Mutation::Link {
                source: "source".into(),
                destination: "alias".into(),
                expected_revision: 0,
            },
            3,
            &auth(),
        )
        .unwrap();
    put(&mut m, "destination", b"second");
    // An arbitrary later infrastructure operation must not cause a false 409.
    m.catalogue_worker()
        .transact(
            T,
            OperationId(1_000_000),
            Mutation::Tombstone {
                name: "unused".into(),
                expected_revision: 0,
            },
            3,
            &auth(),
        )
        .unwrap();
    assert_eq!(
        m.delete(
            &reference("destination"),
            &DestinationConditions::default(),
            4,
            &auth()
        )
        .unwrap()
        .status,
        204
    );
    put(&mut m, "destination", b"third");
}

#[test]
fn xml_line_endings_and_explicit_cr_references_target_distinct_correct_keys() {
    let request = parse_delete(b"<Delete><Object><Key>a\r\nb\rc</Key></Object><Object><Key>a&#13;b</Key></Object></Delete>", &policy(), 10).unwrap();
    assert_eq!(request.keys, ["a\nb\nc", "a\rb"]);
    let mut m = model();
    put(&mut m, "archive/a\nb\nc", b"literal");
    put(&mut m, "archive/a\rb", b"reference");
    let response = m.delete_objects(T, &bucket(), request, 4, &auth()).unwrap();
    assert!(m
        .catalogue()
        .lookup(T, "archive/a\nb\nc", 4, &auth())
        .is_err());
    assert!(m.catalogue().lookup(T, "archive/a\rb", 4, &auth()).is_err());
    let xml = String::from_utf8(response.body).unwrap();
    assert!(xml.contains("<Key>a&#13;b</Key>"));
    assert!(!xml.contains('\r'));
}

#[test]
fn expiry_index_bounds_cleanup_inspection_even_with_many_active_tenants() {
    struct AllTenants;
    impl Authority for AllTenants {
        fn is_current(&self) -> bool {
            true
        }
        fn permits(&self, _: &Reference, _: Action) -> bool {
            true
        }
    }
    let mut m = model();
    for tenant in 1..=32 {
        let p = m
            .prepare(
                Reference {
                    tenant: TenantId(tenant),
                    name: "archive/key".into(),
                },
                metadata(),
                DestinationConditions::default(),
                None,
                10,
                &AllTenants,
            )
            .unwrap();
        m.initiate(p, MultipartChecksum::None, 11, &AllTenants)
            .unwrap();
    }
    let p = m
        .prepare(
            Reference {
                tenant: TenantId(100),
                name: "archive/expired".into(),
            },
            metadata(),
            DestinationConditions::default(),
            None,
            1,
            &AllTenants,
        )
        .unwrap();
    m.initiate(p, MultipartChecksum::None, 2, &AllTenants)
        .unwrap();
    let pass = m.cleanup(101, 1).unwrap();
    assert_eq!(pass.examined, 1);
    assert_eq!(pass.removed, 1);
    let pass = m.cleanup(101, 1).unwrap();
    assert_eq!(pass.examined, 1);
    assert_eq!(pass.removed, 0);
    assert_eq!(
        m.list_uploads(TenantId(100), "", 0, 8, 101, &AllTenants)
            .unwrap()
            .entries
            .len(),
        0
    );
}

#[test]
fn typed_deletes_reject_empty_names_and_validate_entire_batch_before_mutation() {
    let mut m = model();
    assert_eq!(
        m.delete(
            &reference(""),
            &DestinationConditions::default(),
            4,
            &auth()
        ),
        Err(s3::ErrorCode::InvalidRequest)
    );
    assert_eq!(m.catalogue().write_target(T, "", 4, &auth()).unwrap().0, 0);
    let original = put(&mut m, "archive/keep", b"retained");
    for quiet in [false, true] {
        assert_eq!(
            m.delete_objects(
                T,
                &bucket(),
                DeleteRequest {
                    keys: vec!["keep".into(), "".into()],
                    quiet
                },
                4,
                &auth(),
            ),
            Err(s3::ErrorCode::InvalidRequest)
        );
        assert_eq!(
            m.catalogue()
                .lookup(T, "archive/keep", 4, &auth())
                .unwrap()
                .generation,
            original.generation
        );
        assert_eq!(
            m.catalogue()
                .write_target(T, "archive/", 4, &auth())
                .unwrap()
                .0,
            0
        );
    }
}

#[test]
fn control_xml_rejects_non_xml_container_space_and_signed_character_references() {
    let p = policy();
    for space in ['\u{a0}', '\u{2003}'] {
        for xml in [
            format!("<Delete>{space}<Object><Key>a</Key></Object></Delete>"),
            format!("<Delete><Object>{space}<Key>a</Key></Object></Delete>"),
            format!("{space}<Delete><Object><Key>a</Key></Object></Delete>"),
            format!("<Delete><Object><Key>a</Key></Object></Delete>{space}"),
        ] {
            assert_eq!(
                parse_delete(xml.as_bytes(), &p, 10).unwrap_err(),
                s3::ErrorCode::MalformedXML
            );
        }
    }
    for entity in [
        "&#x+41;", "&#+65;", "&#x-41;", "&#-65;", "&#x;", "&#;", "&#xGG;", "&#6a;",
    ] {
        let xml = format!("<Delete><Object><Key>{entity}</Key></Object></Delete>");
        assert!(parse_delete(xml.as_bytes(), &p, 10).is_err(), "{entity}");
    }
    let valid = " \t\n<Delete>\r\n<Object>\t<Key>\u{a0}&#x0041;&#00065;\u{2003}</Key>\n</Object></Delete> \n";
    assert_eq!(
        parse_delete(valid.as_bytes(), &p, 10).unwrap().keys,
        ["\u{a0}AA\u{2003}"]
    );
}

#[test]
fn completion_result_preserves_size_and_digest_errors() {
    for error in [s3::ErrorCode::EntityTooSmall, s3::ErrorCode::BadDigest] {
        let response = error.response(false, "fixture");
        for status in [200, response.status] {
            let result = completion_result(status, &response.body, &policy());
            assert_eq!(result, Err(error));
            assert_eq!(result.unwrap_err().status(), 400);
        }
    }
}

#[test]
fn completion_success_rejects_unknown_nested_and_duplicate_fields() {
    let p = policy();
    for fields in [
        "<Error><Code>BadDigest</Code></Error>",
        "<Unknown>ignored</Unknown>",
        "<Key>a</Key><Key>b</Key>",
        "<Bucket>a</Bucket><Bucket>b</Bucket>",
        "<Location>a</Location><Location>b</Location>",
        "<ChecksumSHA256>a</ChecksumSHA256><ChecksumSHA256>b</ChecksumSHA256>",
        "<ChecksumCRC32>a</ChecksumCRC32><ChecksumCRC32>b</ChecksumCRC32>",
        "<ChecksumType>FULL_OBJECT</ChecksumType><ChecksumType>COMPOSITE</ChecksumType>",
        "<Key><Nested>bad</Nested></Key>",
        "<ETag>duplicate</ETag>",
    ] {
        let xml = format!(
            "<CompleteMultipartUploadResult><ETag>committed</ETag>{fields}</CompleteMultipartUploadResult>"
        );
        assert_eq!(
            completion_result(200, xml.as_bytes(), &p),
            Err(s3::ErrorCode::MalformedXML),
            "{fields}"
        );
    }
    for checksum in ["ChecksumSHA256", "ChecksumCRC32"] {
        let xml = format!(
            "<CompleteMultipartUploadResult><Location>https://s3.example.invalid/archive/key</Location><Bucket>archive</Bucket><Key>key</Key><ETag>committed</ETag><{checksum}>evidence</{checksum}><ChecksumType>FULL_OBJECT</ChecksumType></CompleteMultipartUploadResult>"
        );
        assert_eq!(
            completion_result(200, xml.as_bytes(), &p),
            Ok("committed".into())
        );
    }
}

#[test]
fn embedded_completion_error_is_failure_even_in_http_200() {
    assert_eq!(
        completion_result(
            200,
            b"<Error><Code>InvalidPart</Code><Message>bad</Message></Error>",
            &policy()
        ),
        Err(s3::ErrorCode::InvalidPart)
    );
    assert_eq!(
        completion_result(
            200,
            b"<CompleteMultipartUploadResult></CompleteMultipartUploadResult>",
            &policy()
        ),
        Err(s3::ErrorCode::MalformedXML)
    );
    assert!(completion_result(500, b"<CompleteMultipartUploadResult><ETag>&quot;tag&quot;</ETag></CompleteMultipartUploadResult>", &policy()).is_err());
}
