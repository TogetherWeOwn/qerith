//! Synthetic reference tests only: not client, encryption or backbone certification.
use base64::{engine::general_purpose::STANDARD, Engine};
use qerith_core::{
    catalogue::*,
    s3::{self, archive::*, *},
};
use sha2::{Digest, Sha256};
use std::{cell::Cell, collections::BTreeMap, rc::Rc};

const TENANT: TenantId = TenantId(1);
const G: GenerationId = GenerationId(10);
const C: &[u8] = b"\x00synthetic encrypted octets\xff\r\n";

struct Access {
    tenant: TenantId,
    principal: String,
    current: Rc<Cell<bool>>,
    list: bool,
    denied: Option<String>,
    read: bool,
    bucket_read: Rc<Cell<bool>>,
    bucket_restore: Rc<Cell<bool>>,
}
impl qerith_core::catalogue::Authority for Access {
    fn is_current(&self) -> bool {
        self.current.get()
    }
    fn permits(&self, reference: &Reference, action: Action) -> bool {
        reference.tenant == self.tenant
            && self.denied.as_deref() != Some(&reference.name)
            && (action != Action::Read || self.read)
    }
}
impl Session for Access {
    fn tenant(&self) -> TenantId {
        self.tenant
    }
    fn principal(&self) -> &str {
        &self.principal
    }
    fn allows(&self, op: Operation, _: &str) -> bool {
        (op != Operation::ListObjects || self.list)
            && (op != Operation::Read || self.bucket_read.get())
            && (op != Operation::Restore || self.bucket_restore.get())
    }
}
fn access() -> Access {
    Access {
        tenant: TENANT,
        principal: "fixture-principal".into(),
        current: Rc::new(Cell::new(true)),
        list: true,
        denied: None,
        read: true,
        bucket_read: Rc::new(Cell::new(true)),
        bucket_restore: Rc::new(Cell::new(true)),
    }
}
fn policy() -> s3::Policy {
    s3::Policy::new(
        "s3.test".into(),
        "fixture-1".into(),
        Limits {
            target_bytes: 8192,
            control_xml_bytes: 2048,
            header_bytes: 4096,
            header_count: 32,
            query_pairs: 32,
            upload_bytes: 1024,
            min_restore_days: 1,
            max_restore_days: 7,
            clock_skew_seconds: 300,
            presign_seconds: 60,
        },
    )
    .unwrap()
}
type TestAdapter = Adapter<MemoryCatalogue, MemoryTokens>;
fn adapter() -> TestAdapter {
    adapter_with_scan_budget(2048)
}
fn adapter_with_scan_budget(scan_entries: usize) -> TestAdapter {
    Adapter::new(
        MemoryCatalogue::default(),
        MemoryTokens::new(128, 300).unwrap(),
        policy(),
        AdapterLimits {
            read_bytes: 1024,
            serving_seconds: 10,
            restore_job_seconds: 200000,
            scan_batch: 73,
            scan_entries,
        },
    )
    .unwrap()
}
struct Cache {
    calls: usize,
    revoke: Option<Rc<Cell<bool>>>,
    advance: Option<(Rc<Cell<u64>>, u64)>,
    wrong_length: bool,
}
struct TestClock(Rc<Cell<u64>>);
impl Clock for TestClock {
    fn now(&self) -> u64 {
        self.0.get()
    }
}
impl QualifiedCache for Cache {
    fn read(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        identity: &CiphertextIdentity,
        location: &str,
        _: PinId,
        range: Option<ByteRange>,
    ) -> s3::Result<Vec<u8>> {
        self.calls += 1;
        assert_eq!(tenant, TENANT);
        assert_eq!(generation, G);
        assert_eq!(identity, &metadata(G).identity);
        assert_eq!(location, "fixture-copy/10");
        if let Some(current) = &self.revoke {
            current.set(false);
        }
        if let Some((clock, until)) = &self.advance {
            clock.set(*until);
        }
        if self.wrong_length {
            return Ok(vec![]);
        }
        Ok(range.map_or(Vec::new(), |r| {
            C[r.start as usize..=r.end as usize].to_vec()
        }))
    }
}
#[derive(Default)]
struct Capacity {
    deny: bool,
    revoke: Option<Rc<Cell<bool>>>,
    reservations: Vec<CapacityReservation>,
}
impl CapacityPort for Capacity {
    fn reserve(
        &mut self,
        tenant: TenantId,
        name: &str,
        operation: OperationId,
        generation: GenerationId,
        until: u64,
    ) -> s3::Result<CapacityReservation> {
        if self.deny {
            return Err(ErrorCode::SlowDown);
        }
        let receipt = CapacityReservation {
            tenant,
            name: name.into(),
            operation,
            generation,
            until,
            receipt: "fixture-capacity-committed".into(),
        };
        self.reservations.push(receipt.clone());
        if let Some(current) = &self.revoke {
            current.set(false);
        }
        Ok(receipt)
    }
}
fn metadata(g: GenerationId) -> CiphertextMetadata {
    CiphertextMetadata {
        identity: CiphertextIdentity {
            length: C.len() as u64,
            sha256: Sha256::digest(C).into(),
        },
        validator: format!("\"opaque-not-md5-{}\"", g.0),
        modified_at: 1,
        headers: BTreeMap::from([
            ("content-type".into(), "application/octet-stream".into()),
            ("content-encoding".into(), "gzip".into()),
            ("x-amz-meta-note".into(), "kept-verbatim".into()),
        ]),
        checksums: vec![Checksum {
            algorithm: "SHA256".into(),
            kind: ChecksumType::FullObject,
            value: Sha256::digest(C).to_vec(),
            parts: vec![],
        }],
        recovery_ref: "private-fixture-recovery".into(),
    }
}
fn copy(g: GenerationId) -> CompleteCopy {
    let m = metadata(g);
    CompleteCopy {
        identity: m.identity,
        checksums: m.checksums,
        location: format!("fixture-copy/{}", g.0),
        receipt: "synthetic-full-generation-verified".into(),
    }
}
fn upload(
    c: &mut MemoryCatalogue,
    a: &Access,
    key: &str,
    g: GenerationId,
    revision: u64,
    op: u64,
) -> JobId {
    c.transact(
        a.tenant,
        OperationId(op),
        Mutation::BeginUpload {
            name: format!("bucket/{key}"),
            expected_revision: revision,
            generation: g,
            metadata: metadata(g),
            archive_deadline: 200000,
        },
        1,
        a,
    )
    .unwrap();
    match c
        .transact(
            a.tenant,
            OperationId(op + 1),
            Mutation::CommitUpload {
                intent: OperationId(op),
                copy: copy(g),
            },
            2,
            a,
        )
        .unwrap()
    {
        Outcome::Committed { archive, .. } => archive,
        _ => panic!("commit"),
    }
}
fn qualify(c: &mut MemoryCatalogue, a: &Access, job: JobId, g: GenerationId) {
    for backbone in [BackboneId(1), BackboneId(2)] {
        c.record_verification(
            a.tenant,
            VerificationEvidence {
                generation: g,
                backbone,
                reconstructed: metadata(g).identity,
                verified_at: 3,
                valid_until: 900000,
                verifier_version: "synthetic-only".into(),
                provenance_ref: "fixture".into(),
                readability_ref: "fixture-not-cryptographic-proof".into(),
            },
            IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "fixture".into(),
                decision_ref: "not-real-backbone-qualification".into(),
                valid_until: 900000,
            },
            3,
        )
        .unwrap();
    }
    let fence = c.claim(a.tenant, job, 4, 100).unwrap();
    c.transition(a.tenant, fence, Transition::CompleteArchive, 5, a)
        .unwrap();
}
fn restore_job(c: &MemoryCatalogue, a: &Access) -> JobId {
    c.outbox(a.tenant)
        .into_iter()
        .find_map(|e| match e.effect {
            Effect::RunJob(j) if j.kind == JobKind::Restore => Some(j.id),
            _ => None,
        })
        .unwrap()
}
fn publish(c: &mut MemoryCatalogue, a: &Access, job: JobId, g: GenerationId, now: u64) {
    let fence = c.claim(a.tenant, job, now, now + 20).unwrap();
    c.transition(
        a.tenant,
        fence,
        Transition::PublishRestore { copy: copy(g) },
        now,
        a,
    )
    .unwrap();
}
struct Fixture {
    adapter: TestAdapter,
    access: Access,
    cache: Cache,
    capacity: Capacity,
    clock: TestClock,
    op: u64,
}
impl Fixture {
    fn new() -> Self {
        Self {
            adapter: adapter(),
            access: access(),
            cache: Cache {
                calls: 0,
                revoke: None,
                advance: None,
                wrong_length: false,
            },
            capacity: Capacity::default(),
            clock: TestClock(Rc::new(Cell::new(0))),
            op: 100000,
        }
    }
    fn call(
        &mut self,
        method: &str,
        target: &str,
        fields: &[(&str, &str)],
        body: &[u8],
        now: u64,
    ) -> Response {
        self.op += 1;
        self.clock.0.set(now);
        self.adapter.handle(
            method,
            &Target::parse(target, &policy()).unwrap(),
            &Headers::new(fields, &policy()).unwrap(),
            body,
            &self.access,
            OperationId(self.op),
            &self.clock,
            "fixture-request<&>",
            &mut self.cache,
            &mut self.capacity,
        )
    }
    fn seed(&mut self) -> JobId {
        assert_eq!(self.call("PUT", "/bucket", &[], b"", 0).status, 200);
        upload(&mut self.adapter.catalogue, &self.access, "key", G, 0, 1)
    }
    fn restore(&mut self, days: u32, now: u64) -> Response {
        self.call(
            "POST",
            "/bucket/key?restore",
            &[],
            format!("<RestoreRequest><Days>{days}</Days></RestoreRequest>").as_bytes(),
            now,
        )
    }
}
fn header<'a>(r: &'a Response, key: &str) -> Option<&'a str> {
    r.headers
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}
fn text(r: &Response) -> String {
    String::from_utf8(r.body.clone()).unwrap()
}
fn error(r: &Response, code: &str) {
    assert!(text(r).contains(&format!("<Code>{code}</Code>")), "{r:?}");
}
fn element(body: &str, tag: &str) -> Option<String> {
    body.split_once(&format!("<{tag}>"))?
        .1
        .split_once(&format!("</{tag}>"))
        .map(|(v, _)| v.into())
}

#[test]
fn bucket_operations_are_tenant_safe_and_reject_unqualified_guarantees() {
    let mut f = Fixture::new();
    assert_eq!(f.call("PUT", "/bucket", &[], b"<CreateBucketConfiguration><LocationConstraint>wrong</LocationConstraint></CreateBucketConfiguration>", 0).status, 400);
    assert_eq!(f.call("GET", "/", &[], b"", 0).body, b"<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Buckets></Buckets></ListAllMyBucketsResult>");
    assert_eq!(f.call("PUT", "/bucket", &[], b"", 0).status, 200);
    error(
        &f.call("PUT", "/bucket", &[], b"", 0),
        "BucketAlreadyOwnedByYou",
    );
    assert!(text(&f.call("GET", "/", &[], b"", 0)).contains("<Name>bucket</Name>"));
    assert_eq!(
        header(
            &f.call("HEAD", "/bucket", &[], b"", 0),
            "x-amz-bucket-region"
        ),
        Some("fixture-1")
    );
    assert!(text(&f.call("GET", "/bucket?location", &[], b"", 0)).contains(">fixture-1<"));
    for query in ["versioning", "acl", "policy", "object-lock"] {
        assert_eq!(
            f.call("PUT", &format!("/bucket?{query}"), &[], b"", 0)
                .status,
            400
        );
    }
    for h in [
        "x-amz-acl",
        "x-amz-server-side-encryption",
        "x-amz-object-lock-mode",
    ] {
        assert_eq!(
            f.call("PUT", "/another", &[(h, "unqualified")], b"", 0)
                .status,
            400
        );
    }
    f.access.tenant = TenantId(2);
    let foreign = f.call("HEAD", "/bucket", &[], b"", 0);
    let absent = f.call("HEAD", "/absent", &[], b"", 0);
    assert_eq!(foreign, absent);
    assert!(foreign.body.is_empty());
    assert_eq!(f.call("PUT", "/bucket", &[], b"", 0).status, 403);
    assert!(!text(&f.call("GET", "/", &[], b"", 0)).contains("<Name>bucket</Name>"));
    f.access.tenant = TENANT;
    assert_eq!(f.call("DELETE", "/bucket", &[], b"", 0).status, 204);
}

#[test]
fn nonempty_delete_checks_hidden_references_and_pending_intents() {
    let mut f = Fixture::new();
    f.seed();
    f.access.denied = Some("bucket/key".into());
    error(&f.call("DELETE", "/bucket", &[], b"", 6), "BucketNotEmpty");
    f.access.denied = None;
    f.adapter
        .catalogue
        .transact(
            TENANT,
            OperationId(8),
            Mutation::Tombstone {
                name: "bucket/key".into(),
                expected_revision: 1,
            },
            6,
            &f.access,
        )
        .unwrap();
    f.adapter
        .catalogue
        .transact(
            TENANT,
            OperationId(9),
            Mutation::BeginUpload {
                name: "bucket/pending".into(),
                expected_revision: 0,
                generation: GenerationId(11),
                metadata: metadata(GenerationId(11)),
                archive_deadline: 100,
            },
            6,
            &f.access,
        )
        .unwrap();
    error(&f.call("DELETE", "/bucket", &[], b"", 6), "BucketNotEmpty");
    f.adapter
        .catalogue
        .transact(
            TENANT,
            OperationId(10),
            Mutation::AbortUpload {
                intent: OperationId(9),
            },
            7,
            &f.access,
        )
        .unwrap();
    assert_eq!(f.call("DELETE", "/bucket", &[], b"", 7).status, 204);
}

#[test]
fn predicate_range_and_head_semantics_precede_cold_without_work() {
    let mut f = Fixture::new();
    f.seed();
    let before = f.adapter.catalogue.outbox(TENANT);
    let head = f.call(
        "HEAD",
        "/bucket/key",
        &[("x-amz-checksum-mode", "ENABLED")],
        b"",
        6,
    );
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(header(&head, "x-amz-restore"), None);
    assert_eq!(header(&head, "content-encoding"), Some("gzip"));
    assert_eq!(
        header(&head, "x-amz-checksum-sha256"),
        Some(STANDARD.encode(Sha256::digest(C)).as_str())
    );
    let head_range = f.call("HEAD", "/bucket/key", &[("range", "bytes=1-3")], b"", 6);
    assert_eq!(head_range.status, 200);
    assert_eq!(header(&head_range, "content-length"), Some("3"));
    assert_eq!(header(&head_range, "content-range"), None);
    assert!(head_range.body.is_empty());
    for method in ["GET", "HEAD"] {
        let r = f.call(
            method,
            "/bucket/key",
            &[("if-none-match", "\"opaque-not-md5-10\"")],
            b"",
            6,
        );
        assert_eq!(r.status, 304);
        assert!(r.body.is_empty());
        let r = f.call(method, "/bucket/key", &[("if-match", "\"other\"")], b"", 6);
        assert_eq!(r.status, 412);
        if method == "HEAD" {
            assert!(r.body.is_empty());
        }
        let r = f.call(method, "/bucket/key", &[("range", "bytes=999-")], b"", 6);
        assert_eq!(r.status, 416);
        if method == "HEAD" {
            assert!(r.body.is_empty());
        }
    }
    assert_eq!(
        f.call("GET", "/bucket/key", &[("range", "bytes=0-1,3-4")], b"", 6)
            .status,
        400
    );
    error(
        &f.call("GET", "/bucket/key", &[], b"", 6),
        "InvalidObjectState",
    );
    assert_eq!(f.cache.calls, 0);
    assert_eq!(before, f.adapter.catalogue.outbox(TENANT));
    f.access.denied = Some("bucket/key".into());
    assert_eq!(
        f.call("GET", "/bucket/key", &[("if-none-match", "*")], b"", 6)
            .status,
        403
    );
    f.access.denied = None;
    f.access.list = false;
    assert_eq!(f.call("GET", "/bucket/missing", &[], b"", 6).status, 403);
    f.access.list = true;
    error(&f.call("GET", "/bucket/missing", &[], b"", 6), "NoSuchKey");
}

#[test]
fn explicit_restore_verified_publication_restart_renewal_and_expiry() {
    let mut f = Fixture::new();
    let archive = f.seed();
    assert_eq!(f.restore(0, 6).status, 400);
    assert_eq!(f.restore(8, 6).status, 400);
    assert_eq!(f.restore(2, 6).status, 202);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    assert_eq!(f.restore(3, 7).status, 409);
    assert_eq!(restore_job(&f.adapter.catalogue, &f.access), job);
    assert_eq!(
        header(&f.call("HEAD", "/bucket/key", &[], b"", 7), "x-amz-restore"),
        Some("ongoing-request=\"true\"")
    );
    let fence = f.adapter.catalogue.claim(TENANT, job, 8, 9).unwrap();
    assert!(f
        .adapter
        .catalogue
        .transition(
            TENANT,
            fence,
            Transition::PublishRestore { copy: copy(G) },
            8,
            &f.access
        )
        .is_err());
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    // New adapter state, same catalogue snapshot: no local adapter job/lease map.
    let saved = f.adapter.catalogue.clone();
    f.adapter = adapter();
    f.adapter.catalogue = saved;
    assert_eq!(f.restore(2, 10).status, 409);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 86401);
    let expiry = 345600;
    assert_eq!(
        f.adapter
            .catalogue
            .lookup(TENANT, "bucket/key", 86401, &f.access)
            .unwrap()
            .availability_until,
        Some(expiry)
    );
    let get = f.call(
        "GET",
        "/bucket/key",
        &[("x-amz-checksum-mode", "ENABLED")],
        b"",
        86402,
    );
    assert_eq!(get.status, 200);
    assert_eq!(get.body, C);
    assert_eq!(header(&get, "etag"), Some("\"opaque-not-md5-10\""));
    assert_eq!(
        header(&get, "x-amz-restore"),
        Some("ongoing-request=\"false\", expiry-date=\"Mon, 05 Jan 1970 00:00:00 GMT\"")
    );
    for (range, start, end) in [
        ("bytes=2-5", 2, 5),
        ("bytes=-3", C.len() - 3, C.len() - 1),
        ("bytes=4-", 4, C.len() - 1),
    ] {
        let r = f.call(
            "GET",
            "/bucket/key",
            &[("range", range), ("x-amz-checksum-mode", "ENABLED")],
            b"",
            86402,
        );
        assert_eq!(r.status, 206);
        assert_eq!(r.body, &C[start..=end]);
        assert_eq!(header(&r, "x-amz-checksum-sha256"), None);
        assert_eq!(
            header(&r, "content-range"),
            Some(format!("bytes {start}-{end}/{}", C.len()).as_str())
        );
    }
    f.capacity.deny = true;
    assert_eq!(f.restore(7, 86403).status, 503);
    assert_eq!(
        f.adapter
            .catalogue
            .lookup(TENANT, "bucket/key", 86403, &f.access)
            .unwrap()
            .availability_until,
        Some(expiry)
    );
    f.capacity.deny = false;
    assert_eq!(f.restore(1, 86404).status, 200);
    assert_eq!(f.capacity.reservations.last().unwrap().until, expiry);
    assert_eq!(f.restore(7, 86404).status, 200);
    let extended = archive_expiry(86404, 7).unwrap();
    assert_eq!(
        f.adapter
            .catalogue
            .lookup(TENANT, "bucket/key", 86404, &f.access)
            .unwrap()
            .availability_until,
        Some(extended)
    );
    assert_eq!(
        header(
            &f.call("HEAD", "/bucket/key", &[], b"", extended),
            "x-amz-restore"
        ),
        None
    );
    error(
        &f.call("GET", "/bucket/key", &[], b"", extended),
        "InvalidObjectState",
    );
    assert_eq!(f.restore(1, extended).status, 202);
}

#[test]
fn renewal_rechecks_bucket_restore_after_capacity_without_changing_lease() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    assert_eq!(f.restore(1, 6).status, 202);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 7);
    let before = f
        .adapter
        .catalogue
        .lookup(TENANT, "bucket/key", 8, &f.access)
        .unwrap();
    let outbox = f.adapter.catalogue.outbox(TENANT);
    f.capacity.revoke = Some(f.access.bucket_restore.clone());
    error(&f.restore(7, 8), "AccessDenied");
    assert!(f.access.current.get());
    for action in [Action::Restore, Action::Read] {
        assert!(qerith_core::catalogue::Authority::permits(
            &f.access,
            &Reference {
                tenant: TENANT,
                name: "bucket/key".into()
            },
            action,
        ));
    }
    assert_eq!(
        f.adapter
            .catalogue
            .lookup(TENANT, "bucket/key", 8, &f.access)
            .unwrap(),
        before
    );
    assert_eq!(f.adapter.catalogue.outbox(TENANT), outbox);
    // Committed capacity stays available for reconciliation, not silently freed.
    assert_eq!(f.capacity.reservations.len(), 1);
    let reserved = &f.capacity.reservations[0];
    assert_eq!(reserved.tenant, TENANT);
    assert_eq!(reserved.name, "bucket/key");
    assert_eq!(reserved.generation, G);
    assert_eq!(reserved.operation, OperationId(f.op));
    assert_eq!(reserved.until, archive_expiry(8, 7).unwrap());
    assert_eq!(f.call("GET", "/bucket/key", &[], b"", 9).body, C);
    error(
        &f.call(
            "GET",
            "/bucket/key",
            &[],
            b"",
            before.availability_until.unwrap(),
        ),
        "InvalidObjectState",
    );
    // A later newly authorized renewal can still use the normal commit path.
    f.capacity.revoke = None;
    f.access.bucket_restore.set(true);
    assert_eq!(f.restore(7, 10).status, 200);
    assert_eq!(
        f.adapter
            .catalogue
            .lookup(TENANT, "bucket/key", 10, &f.access)
            .unwrap()
            .availability_until,
        Some(archive_expiry(10, 7).unwrap())
    );
}

#[test]
fn if_range_is_explicitly_rejected_without_cache_or_restore_work() {
    let mut f = Fixture::new();
    let archive = f.seed();
    let outbox = f.adapter.catalogue.outbox(TENANT);
    for validator in [
        "\"stale\"",
        "\"opaque-not-md5-10\"",
        "Thu, 01 Jan 1970 00:00:01 GMT",
    ] {
        for method in ["GET", "HEAD"] {
            let r = f.call(
                method,
                "/bucket/key",
                &[("range", "bytes=0-3"), ("if-range", validator)],
                b"",
                6,
            );
            assert_eq!(r.status, 400);
            if method == "HEAD" {
                assert!(r.body.is_empty());
            } else {
                error(&r, "InvalidRequest");
            }
        }
    }
    assert_eq!(f.cache.calls, 0);
    assert!(f.capacity.reservations.is_empty());
    assert_eq!(f.adapter.catalogue.outbox(TENANT), outbox);
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    assert_eq!(f.restore(1, 6).status, 202);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 7);
    let outbox = f.adapter.catalogue.outbox(TENANT);
    let r = f.call(
        "GET",
        "/bucket/key",
        &[("range", "bytes=0-3"), ("if-range", "\"stale\"")],
        b"",
        8,
    );
    assert_eq!(r.status, 400);
    error(&r, "InvalidRequest");
    assert_eq!(f.cache.calls, 0);
    assert_eq!(f.adapter.catalogue.outbox(TENANT), outbox);
    let range = f.call("GET", "/bucket/key", &[("range", "bytes=0-3")], b"", 8);
    assert_eq!(range.status, 206);
    assert_eq!(range.body, &C[..4]);
}

#[test]
fn bucket_region_decodes_xml_references_before_validation() {
    let mut f = Fixture::new();
    for region in [
        "fixture&#45;1",
        "fixture&#x2D;1",
        "&#102;ixture-1",
        "fixture-&#49;",
    ] {
        let config = format!("<CreateBucketConfiguration><LocationConstraint>{region}</LocationConstraint></CreateBucketConfiguration>");
        assert_eq!(
            f.call("PUT", "/bucket", &[], config.as_bytes(), 0).status,
            200
        );
        assert_eq!(
            header(
                &f.call("HEAD", "/bucket", &[], b"", 0),
                "x-amz-bucket-region"
            ),
            Some("fixture-1")
        );
        assert_eq!(f.call("DELETE", "/bucket", &[], b"", 0).status, 204);
    }
    for region in [
        "fixture&#0;1",
        "fixture&#x110000;1",
        "fixture&unknown;1",
        "fixture&#no;1",
        "fixture&amp;1",
        "wrong&#45;1",
    ] {
        let config = format!("<CreateBucketConfiguration><LocationConstraint>{region}</LocationConstraint></CreateBucketConfiguration>");
        assert_eq!(
            f.call("PUT", "/bucket", &[], config.as_bytes(), 0).status,
            400
        );
        assert!(f.adapter.catalogue.buckets(TENANT).is_empty());
    }
}

#[test]
fn generation_isolation_revocation_and_bad_cache_never_return_success() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    f.restore(1, 6);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 7);
    f.cache.wrong_length = true;
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "InternalError");
    f.cache.wrong_length = false;
    f.cache.revoke = Some(f.access.current.clone());
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "AccessDenied");
    f.access.current.set(true);
    f.cache.revoke = None;
    upload(
        &mut f.adapter.catalogue,
        &f.access,
        "key",
        GenerationId(11),
        1,
        20,
    );
    error(
        &f.call("GET", "/bucket/key", &[], b"", 8),
        "InvalidObjectState",
    );
    assert_eq!(
        header(&f.call("HEAD", "/bucket/key", &[], b"", 8), "etag"),
        Some("\"opaque-not-md5-11\"")
    );
    f.access.tenant = TenantId(2);
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "AccessDenied");
}

#[test]
fn calendar_boundaries_and_overflow_are_explicit_not_production_limits() {
    assert_eq!(archive_expiry(0, 1), Ok(86400));
    assert_eq!(archive_expiry(1, 1), Ok(172800));
    assert_eq!(archive_expiry(86399, 1), Ok(172800));
    assert_eq!(archive_expiry(86400, 1), Ok(172800));
    assert!(archive_expiry(u64::MAX, 1).is_err());
    assert!(archive_expiry(0, 0).is_err());
}

#[test]
fn listing_prefix_delimiter_start_after_xml_url_and_scoped_tokens() {
    let mut f = Fixture::new();
    f.seed();
    for (i, key) in ["a/one", "a/two", "b&<\"", "z space+%/é", "é", "\u{1}"]
        .iter()
        .enumerate()
    {
        upload(
            &mut f.adapter.catalogue,
            &f.access,
            key,
            GenerationId(20 + i as u64),
            0,
            20 + 2 * i as u64,
        );
    }
    let r = f.call(
        "GET",
        "/bucket?list-type=2&prefix=a%2F&delimiter=%2F",
        &[],
        b"",
        6,
    );
    assert!(text(&r).contains("<Key>a/one</Key>"));
    assert!(!text(&r).contains("<Key>key</Key>"));
    let r = f.call(
        "GET",
        "/bucket?list-type=2&encoding-type=url&delimiter=%2F&max-keys=1&start-after=a",
        &[],
        b"",
        6,
    );
    assert!(text(&r).contains("<CommonPrefixes><Prefix>a%2F</Prefix>"));
    assert!(text(&r).contains("<KeyCount>1</KeyCount>"));
    let token = element(&text(&r), "NextContinuationToken").unwrap();
    let next=format!("/bucket?list-type=2&encoding-type=url&delimiter=%2F&max-keys=1&start-after=a&continuation-token={token}");
    let r = f.call("GET", &next, &[], b"", 6);
    assert!(text(&r).contains("<Key>b%26%3C%22</Key>"));
    f.access.principal = "another-principal".into();
    assert_eq!(f.call("GET", &next, &[], b"", 6).status, 400);
    f.access.principal = "fixture-principal".into();
    assert_eq!(
        f.call(
            "GET",
            &next.replace("start-after=a", "start-after=b"),
            &[],
            b"",
            6
        )
        .status,
        400
    );
    assert_eq!(f.call("GET", &next, &[], b"", 307).status, 400);
    let escaped = f.call("GET", "/bucket?list-type=2&prefix=b", &[], b"", 6);
    assert!(text(&escaped).contains("<Key>b&amp;&lt;&quot;</Key>"));
    let encoded = f.call("GET", "/bucket?list-type=2&encoding-type=url", &[], b"", 6);
    assert!(text(&encoded).contains("<Key>%01</Key>"));
    assert!(text(&encoded).contains("<Key>z%20space%2B%25%2F%C3%A9</Key>"));
    assert_eq!(
        f.call("GET", "/bucket?list-type=2", &[], b"", 6).status,
        400
    );
    assert_eq!(
        f.call("GET", "/bucket?list-type=2&max-keys=1001", &[], b"", 6)
            .status,
        400
    );
    let zero = f.call("GET", "/bucket?list-type=2&max-keys=0", &[], b"", 6);
    assert!(text(&zero).contains("<KeyCount>0</KeyCount>"));
}

#[test]
fn listing_traverses_over_1000_in_byte_order_and_is_not_snapshot_consistent() {
    let mut f = Fixture::new();
    f.seed();
    for i in 0..1003 {
        upload(
            &mut f.adapter.catalogue,
            &f.access,
            &format!("item-{i:04}"),
            GenerationId(100 + i),
            0,
            1000 + 2 * i,
        );
    }
    let first = f.call("GET", "/bucket?list-type=2&max-keys=1000", &[], b"", 6);
    assert_eq!(first.status, 200);
    assert!(text(&first).contains("<KeyCount>1000</KeyCount>"));
    assert!(text(&first).contains("<Key>item-0000</Key>"));
    assert!(text(&first).contains("<Key>item-0999</Key>"));
    let token = element(&text(&first), "NextContinuationToken").unwrap();
    // New keys behind the cursor need not reappear, while those ahead may appear.
    upload(
        &mut f.adapter.catalogue,
        &f.access,
        "aaa-new",
        GenerationId(8000),
        0,
        8000,
    );
    upload(
        &mut f.adapter.catalogue,
        &f.access,
        "zzz-new",
        GenerationId(8001),
        0,
        8002,
    );
    let next = f.call(
        "GET",
        &format!("/bucket?list-type=2&max-keys=1000&continuation-token={token}"),
        &[],
        b"",
        6,
    );
    assert!(text(&next).contains("<KeyCount>5</KeyCount>"));
    assert!(!text(&next).contains("<Key>aaa-new</Key>"));
    assert!(text(&next).contains("<Key>zzz-new</Key>"));
    assert!(text(&next).contains("<IsTruncated>false</IsTruncated>"));
}

#[test]
fn service_root_is_only_list_buckets_and_has_no_mutation_alias() {
    let mut f = Fixture::new();
    for method in ["PUT", "HEAD", "DELETE", "POST"] {
        let r = f.call(method, "/", &[], b"", 0);
        assert_eq!(r.status, 501);
        if method == "HEAD" {
            assert!(r.body.is_empty());
        }
        assert!(f.adapter.catalogue.buckets(TENANT).is_empty());
    }
    assert_eq!(f.call("GET", "/", &[], b"", 0).status, 200);
}

#[test]
fn bucket_configuration_accepts_one_valid_leading_xml_declaration() {
    let mut f = Fixture::new();
    let config = "<CreateBucketConfiguration><LocationConstraint>fixture-1</LocationConstraint></CreateBucketConfiguration>";
    for declaration in [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>",
    ] {
        assert_eq!(
            f.call(
                "PUT",
                "/bucket",
                &[],
                format!("{declaration}{config}").as_bytes(),
                0
            )
            .status,
            200
        );
        assert_eq!(f.call("DELETE", "/bucket", &[], b"", 0).status, 204);
    }
    for bad in [
        format!("<?xml version=\"1.1\"?>{config}"),
        format!("<?xml version=\"1.0\" encoding=\"UTF-16\"?>{config}"),
        format!("<?xml version=\"1.0\"?><?xml version=\"1.0\"?>{config}"),
        config.replace(
            "<LocationConstraint>",
            "<?xml version=\"1.0\"?><LocationConstraint>",
        ),
        format!("{config}<?xml version=\"1.0\"?>"),
        format!("<!DOCTYPE CreateBucketConfiguration>{config}"),
    ] {
        assert_eq!(f.call("PUT", "/bucket", &[], bad.as_bytes(), 0).status, 400);
        assert!(f.adapter.catalogue.buckets(TENANT).is_empty());
    }
}

#[test]
fn bucket_read_revocation_is_rechecked_independently_of_reference_authority() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    assert_eq!(f.restore(1, 6).status, 202);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 7);
    f.cache.revoke = Some(f.access.bucket_read.clone());
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "AccessDenied");
    assert_eq!(f.cache.calls, 1);
    assert!(f.access.current.get());
    assert!(qerith_core::catalogue::Authority::permits(
        &f.access,
        &Reference {
            tenant: TENANT,
            name: "bucket/key".into()
        },
        Action::Read
    ));
    f.cache.revoke = None;
    f.access.bucket_read.set(true);
    assert_eq!(f.call("GET", "/bucket/key", &[], b"", 8).body, C);
}

#[test]
fn fresh_clock_fences_buffered_reads_at_pin_and_lease_expiry() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    assert_eq!(f.restore(1, 6).status, 202);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 7);
    // An I/O delay past the 10-second pin must not return buffered bytes.
    f.cache.advance = Some((f.clock.0.clone(), 18));
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "AccessDenied");
    let expiry = archive_expiry(7, 1).unwrap();
    f.cache.advance = Some((f.clock.0.clone(), expiry));
    error(
        &f.call(
            "GET",
            "/bucket/key",
            &[("range", "bytes=1-3")],
            b"",
            expiry - 1,
        ),
        "AccessDenied",
    );
    f.cache.advance = Some((f.clock.0.clone(), 17));
    assert_eq!(f.call("GET", "/bucket/key", &[], b"", 8).body, C);
    // A broken infrastructure clock also fails closed rather than extending a pin.
    f.cache.advance = Some((f.clock.0.clone(), 7));
    error(&f.call("GET", "/bucket/key", &[], b"", 8), "AccessDenied");
}

#[test]
fn metadata_head_and_predicates_survive_delivery_cache_eviction() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    let candidate = f
        .adapter
        .catalogue
        .candidate(TENANT, G, DeletionKind::DeliveryCache, 6, 7, &f.access)
        .unwrap();
    let event = f
        .adapter
        .catalogue
        .finalize_deletion(candidate, 7, &f.access)
        .unwrap();
    for dispatched in [false, true] {
        if dispatched {
            f.adapter
                .catalogue
                .dispatch_deletion(TENANT, event, 8, &f.access)
                .unwrap();
            f.adapter
                .catalogue
                .acknowledge_deletion(TENANT, event)
                .unwrap();
        }
        let head = f.call("HEAD", "/bucket/key", &[], b"", 8);
        assert_eq!(head.status, 200);
        assert_eq!(header(&head, "etag"), Some("\"opaque-not-md5-10\""));
        assert_eq!(
            f.call("HEAD", "/bucket/key", &[("if-none-match", "*")], b"", 8)
                .status,
            304
        );
        assert_eq!(
            f.call("HEAD", "/bucket/key", &[("range", "bytes=999-")], b"", 8)
                .status,
            416
        );
        error(
            &f.call("GET", "/bucket/key", &[], b"", 8),
            "InvalidObjectState",
        );
    }
    assert_eq!(f.cache.calls, 0);
}

#[test]
fn restore_authority_does_not_imply_or_require_read_authority() {
    let mut f = Fixture::new();
    let archive = f.seed();
    qualify(&mut f.adapter.catalogue, &f.access, archive, G);
    f.access.read = false;
    f.access.bucket_read.set(false);
    assert_eq!(f.restore(1, 6).status, 202);
    assert_eq!(f.restore(1, 7).status, 409);
    let job = restore_job(&f.adapter.catalogue, &f.access);
    publish(&mut f.adapter.catalogue, &f.access, job, G, 8);
    assert_eq!(f.restore(2, 9).status, 200);
    assert_eq!(f.capacity.reservations.len(), 1);
    assert_eq!(f.call("GET", "/bucket/key", &[], b"", 9).status, 403);
    let head = f.call("HEAD", "/bucket/key", &[], b"", 9);
    assert_eq!(head.status, 403);
    assert!(head.body.is_empty());
}

fn parsed_keys(xml: &[u8]) -> Vec<String> {
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(xml);
    let mut keys = Vec::new();
    let mut key = None::<String>;
    loop {
        match reader.read_event().unwrap() {
            Event::Start(e) if e.name().as_ref() == "Key" => key = Some(String::new()),
            Event::End(e) if e.name().as_ref() == "Key" => keys.push(key.take().unwrap()),
            Event::Text(e) => {
                if let Some(key) = &mut key {
                    key.push_str(&e.xml10_content());
                }
            }
            Event::GeneralRef(e) => {
                if let Some(key) = &mut key {
                    key.push(e.resolve_char_ref().unwrap().unwrap());
                }
            }
            Event::Eof => return keys,
            _ => {}
        }
    }
}

#[test]
fn listing_carriage_returns_round_trip_through_xml_parser() {
    let mut f = Fixture::new();
    f.seed();
    let key = "line\r\nnext\rtab\tend";
    upload(
        &mut f.adapter.catalogue,
        &f.access,
        key,
        GenerationId(20),
        0,
        20,
    );
    let r = f.call("GET", "/bucket?list-type=2&prefix=line", &[], b"", 6);
    assert_eq!(r.status, 200);
    assert_eq!(parsed_keys(&r.body), vec![key]);
    let r = f.call(
        "GET",
        "/bucket?list-type=2&prefix=line&encoding-type=url",
        &[],
        b"",
        6,
    );
    assert_eq!(parsed_keys(&r.body), vec!["line%0D%0Anext%0Dtab%09end"]);
}

#[test]
fn failed_listing_does_not_consume_undelivered_token_capacity() {
    let mut f = Fixture::new();
    f.adapter.tokens = MemoryTokens::new(1, 300).unwrap();
    f.seed();
    upload(
        &mut f.adapter.catalogue,
        &f.access,
        "\u{1}",
        GenerationId(20),
        0,
        20,
    );
    for _ in 0..3 {
        error(
            &f.call("GET", "/bucket?list-type=2&max-keys=1", &[], b"", 6),
            "InvalidArgument",
        );
    }
    let valid = f.call(
        "GET",
        "/bucket?list-type=2&max-keys=1&encoding-type=url",
        &[],
        b"",
        6,
    );
    assert_eq!(valid.status, 200);
    assert!(element(&text(&valid), "NextContinuationToken").is_some());
}

#[test]
fn delimiter_scan_budget_advances_even_on_empty_truncated_pages() {
    let mut f = Fixture::new();
    f.adapter = adapter_with_scan_budget(3);
    f.seed();
    for i in 0..10 {
        upload(
            &mut f.adapter.catalogue,
            &f.access,
            &format!("directory/{i:02}"),
            GenerationId(20 + i),
            0,
            20 + 2 * i,
        );
    }
    let base = "/bucket?list-type=2&delimiter=%2F&max-keys=1";
    let first = f.call("GET", base, &[], b"", 6);
    assert!(text(&first).contains("<CommonPrefixes><Prefix>directory/</Prefix>"));
    let mut token = element(&text(&first), "NextContinuationToken").unwrap();
    let mut empty_pages = 0;
    let mut keys = Vec::new();
    for _ in 0..10 {
        let r = f.call(
            "GET",
            &format!("{base}&continuation-token={token}"),
            &[],
            b"",
            6,
        );
        assert_eq!(r.status, 200);
        assert!(!text(&r).contains("<CommonPrefixes>"));
        if text(&r).contains("<KeyCount>0</KeyCount>") {
            empty_pages += 1;
        }
        keys.extend(parsed_keys(&r.body));
        match element(&text(&r), "NextContinuationToken") {
            Some(next) => token = next,
            None => {
                assert_eq!(keys, vec!["key"]);
                assert_eq!(empty_pages, 2);
                return;
            }
        }
    }
    panic!("scan cursor did not make progress");
}
