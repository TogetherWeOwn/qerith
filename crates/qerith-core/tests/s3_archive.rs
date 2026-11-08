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
}
impl qerith_core::catalogue::Authority for Access {
    fn is_current(&self) -> bool {
        self.current.get()
    }
    fn permits(&self, reference: &Reference, _: Action) -> bool {
        reference.tenant == self.tenant && self.denied.as_deref() != Some(&reference.name)
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
        op != Operation::ListObjects || self.list
    }
}
fn access() -> Access {
    Access {
        tenant: TENANT,
        principal: "fixture-principal".into(),
        current: Rc::new(Cell::new(true)),
        list: true,
        denied: None,
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
    Adapter::new(
        MemoryCatalogue::default(),
        MemoryTokens::new(128, 300).unwrap(),
        policy(),
        AdapterLimits {
            read_bytes: 1024,
            serving_seconds: 10,
            restore_job_seconds: 200000,
            scan_batch: 73,
        },
    )
    .unwrap()
}
struct Cache {
    calls: usize,
    revoke: Option<Rc<Cell<bool>>>,
    wrong_length: bool,
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
                wrong_length: false,
            },
            capacity: Capacity::default(),
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
        self.adapter.handle(
            method,
            &Target::parse(target, &policy()).unwrap(),
            &Headers::new(fields, &policy()).unwrap(),
            body,
            &self.access,
            OperationId(self.op),
            now,
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
