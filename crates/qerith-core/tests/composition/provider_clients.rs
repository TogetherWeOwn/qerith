//! Generated provider restore -> actual S3 read adapter. Not HTTP/SigV4,
//! cryptographic readability, public sharing or physical archive qualification.
use super::*;
use qerith_core::s3::{self, archive as client};

type Reader = client::Adapter<MemoryCatalogue, client::MemoryTokens>;

struct Session {
    auth: Rc<Auth>,
    tenant: TenantId,
}
impl Authority for Session {
    fn is_current(&self) -> bool {
        self.auth.is_current()
    }
    fn permits(&self, reference: &Reference, action: Action) -> bool {
        reference.tenant == self.tenant && self.auth.permits(reference, action)
    }
}
impl client::Session for Session {
    fn tenant(&self) -> TenantId {
        self.tenant
    }
    fn principal(&self) -> &str {
        "generated-provider-consumer"
    }
    fn allows(&self, _: client::Operation, _: &str) -> bool {
        true
    }
}
struct Now;
impl client::Clock for Now {
    fn now(&self) -> u64 {
        60
    }
}
struct NoCapacity;
impl client::CapacityPort for NoCapacity {
    fn reserve(
        &mut self,
        _: TenantId,
        _: &str,
        _: OperationId,
        _: GenerationId,
        _: u64,
    ) -> s3::Result<CapacityReservation> {
        panic!("cache reads must not reserve or restore");
    }
}
struct Cache<'a> {
    io: &'a Io,
    calls: usize,
    requests: u64,
    revoke: Option<Rc<Auth>>,
}
impl client::QualifiedCache for Cache<'_> {
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
        assert_eq!(tenant, TENANT);
        assert_eq!(generation, GENERATION);
        assert_eq!(identity, &self.io.identity());
        let bytes = self
            .io
            .copies
            .get(location)
            .ok_or(s3::ErrorCode::InternalError)?;
        if let Some(auth) = self.revoke.take() {
            auth.denied.borrow_mut().insert("bucket/object".into());
        }
        let range = range.expect("GET plans an exact inclusive ciphertext range");
        Ok(bytes[range.start as usize..=range.end as usize].to_vec())
    }
}
fn policy() -> s3::Policy {
    s3::Policy::new(
        "s3.test".into(),
        "generated-1".into(),
        s3::Limits {
            target_bytes: 8192,
            control_xml_bytes: 2048,
            header_bytes: 4096,
            header_count: 32,
            query_pairs: 32,
            upload_bytes: 1024 * 1024,
            min_restore_days: 1,
            max_restore_days: 7,
            clock_skew_seconds: 300,
            presign_seconds: 60,
        },
    )
    .unwrap()
}
fn call(
    reader: &mut Reader,
    session: &Session,
    cache: &mut Cache<'_>,
    method: &str,
    fields: &[(&str, &str)],
) -> s3::Response {
    cache.requests += 1;
    reader.handle(
        method,
        &s3::Target::parse("/bucket/object", &policy()).unwrap(),
        &s3::Headers::new(fields, &policy()).unwrap(),
        &[],
        session,
        OperationId(2000 + cache.requests),
        &Now,
        "generated-provider-read",
        cache,
        &mut NoCapacity,
    )
}
async fn restored(backend: a::Backend) -> (Reader, Io, Session) {
    restored_profile(backend, false).await
}
async fn restored_profile(backend: a::Backend, native: bool) -> (Reader, Io, Session) {
    let (mut catalogue, mut io, auth) = if native {
        let (mut service, io, _, _, auth) = hot_upload().await;
        (std::mem::take(service.catalogue_mut()), io, auth)
    } else {
        let mut catalogue = MemoryCatalogue::default();
        let mut io = Io::new(1).await;
        let auth = Rc::new(Auth::default());
        let time = Time(Cell::new(10));
        let mut upload = io.upload();
        // Choose the S3 byte/metadata profile BEFORE ingest. Never rewrite a
        // native object's unquoted C validator or arbitrary user metadata.
        upload.metadata.headers = BTreeMap::from([
            ("content-type".into(), "application/octet-stream".into()),
            ("x-amz-meta-label".into(), "synthetic-opaque-C".into()),
        ]);
        let archive = commit_job(
            ingest(
                &mut catalogue,
                &mut io,
                &upload,
                &budget(),
                &time,
                &Rules::default(),
                auth.as_ref(),
            )
            .await
            .unwrap(),
        );
        run(
            &mut catalogue,
            &mut io,
            archive,
            &time,
            &Rules::default(),
            auth.as_ref(),
        )
        .await
        .unwrap();
        let hot = request_restore(&mut catalogue, "object", 1700, 1000, 50, 10, auth.as_ref());
        run(
            &mut catalogue,
            &mut io,
            hot,
            &time,
            &Rules::default(),
            auth.as_ref(),
        )
        .await
        .unwrap();
        (catalogue, io, auth)
    };
    let time = Time(Cell::new(60));
    // Prior eviction is still the existing synthetic NNTP proof. This separate
    // restore inventory never qualifies S3 archival completion or eviction.
    evict(&mut catalogue, &mut io, &time, auth.as_ref());
    io.provider_record = Some(record(&io, backend));
    let mut storage = bridge(io, backend, auth.clone(), Fault::None);
    catalogue
        .create_bucket(TENANT, "bucket", "generated-1", 60)
        .unwrap();
    assert!(matches!(
        catalogue
            .transact(
                TENANT,
                OperationId(1900),
                Mutation::Link {
                    source: "object".into(),
                    destination: "bucket/object".into(),
                    expected_revision: 0,
                },
                60,
                auth.as_ref(),
            )
            .unwrap(),
        Outcome::Reference {
            generation: GENERATION,
            ..
        }
    ));
    let restore = request_restore(&mut catalogue, "object", 900, 1000, 50, 60, auth.as_ref());
    let alias_restore = request_restore(
        &mut catalogue,
        "bucket/object",
        901,
        1000,
        50,
        60,
        auth.as_ref(),
    );
    assert_eq!(
        alias_restore, restore,
        "same-generation subscribers coalesce"
    );
    let event = job_event(&catalogue, restore);
    run_once(
        &mut catalogue,
        &mut storage,
        TENANT,
        event,
        &budget(),
        &time,
        &Rules::default(),
        &MockQualification,
        auth.as_ref(),
    )
    .await
    .unwrap();
    assert_eq!(
        catalogue.job(TENANT, restore).unwrap().state,
        JobState::Complete
    );
    assert_eq!(storage.nntp.reads, usize::from(backend == a::Backend::Nntp));
    assert_eq!(storage.s3.reads, usize::from(backend == a::Backend::S3));
    let reader = client::Adapter::new(
        catalogue,
        client::MemoryTokens::new(16, 300).unwrap(),
        policy(),
        client::AdapterLimits {
            read_bytes: budget().max_bytes(),
            serving_seconds: 10,
            restore_job_seconds: 1000,
            scan_batch: 16,
            scan_entries: 32,
        },
    )
    .unwrap();
    (
        reader,
        storage.cache,
        Session {
            auth,
            tenant: TENANT,
        },
    )
}

#[tokio::test]
async fn provider_restored_cache_serves_s3_full_range_head_and_validator_without_refetch() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut reader, io, session) = restored(backend).await;
        let mut cache = Cache {
            io: &io,
            calls: 0,
            requests: 0,
            revoke: None,
        };
        let full = call(&mut reader, &session, &mut cache, "GET", &[]);
        assert_eq!(full.status, 200);
        assert_eq!(full.body, io.fixture.bytes());
        let validator = full
            .headers
            .iter()
            .find(|(k, _)| k == "etag")
            .unwrap()
            .1
            .clone();
        let head = call(&mut reader, &session, &mut cache, "HEAD", &[]);
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        let unchanged = call(
            &mut reader,
            &session,
            &mut cache,
            "GET",
            &[("if-none-match", &validator)],
        );
        assert_eq!(unchanged.status, 304);
        assert!(unchanged.body.is_empty());
        assert_eq!(cache.calls, 1, "HEAD and validators must not read bytes");
        for (header, expected) in [
            ("bytes=0-0", io.fixture.bytes()[..1].to_vec()),
            ("bytes=2-7", io.fixture.bytes()[2..8].to_vec()),
            (
                "bytes=-3",
                io.fixture.bytes()[io.fixture.bytes().len() - 3..].to_vec(),
            ),
        ] {
            let response = call(
                &mut reader,
                &session,
                &mut cache,
                "GET",
                &[("range", header)],
            );
            assert_eq!(response.status, 206);
            assert_eq!(response.body, expected);
            assert!(response.headers.iter().any(|(k, _)| k == "content-range"));
        }
        let invalid = call(
            &mut reader,
            &session,
            &mut cache,
            "GET",
            &[("range", "bytes=999999999-")],
        );
        assert_eq!(invalid.status, 416);
        assert_eq!(cache.calls, 4);
        // No archive transport is even present in the client adapter/cache.
        evidence(
            if backend == a::Backend::S3 {
                "provider-s3-client-read.json"
            } else {
                "provider-nntp-client-read.json"
            },
            serde_json::json!({
                "head_sha": std::env::var("QERITH_EVIDENCE_HEAD").ok(),
                "kind": "synthetic_provider_restore_to_s3_adapter",
                "whole_generation_publication": true,
                "full_range_head_validator": true,
                "http_or_sigv4_qualification": false,
                "s3_archive_or_eviction_qualification": false,
            }),
        );
    }
}

#[tokio::test]
async fn provider_restored_native_profile_is_not_silently_rewritten_for_s3_clients() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut reader, io, session) = restored_profile(backend, true).await;
        let metadata = reader
            .catalogue
            .lookup(TENANT, "bucket/object", 60, session.auth.as_ref())
            .unwrap()
            .metadata;
        assert!(
            !metadata.validator.is_empty() && !metadata.validator.starts_with('"'),
            "native service commits an unquoted validator, not an S3 wire ETag"
        );
        assert_eq!(
            reader
                .catalogue
                .lookup(TENANT, "object", 60, session.auth.as_ref())
                .unwrap()
                .metadata,
            metadata,
            "the alias retains the native source's committed metadata"
        );
        let mut cache = Cache {
            io: &io,
            calls: 0,
            requests: 0,
            revoke: None,
        };
        for method in ["GET", "HEAD"] {
            let response = call(&mut reader, &session, &mut cache, method, &[]);
            assert_eq!(response.status, 500);
            assert_ne!(response.body, io.fixture.bytes());
        }
        assert_eq!(
            cache.calls, 0,
            "incompatible metadata fails before byte I/O"
        );
        assert_eq!(
            reader
                .catalogue
                .lookup(TENANT, "bucket/object", 60, session.auth.as_ref())
                .unwrap()
                .metadata,
            metadata,
            "a protocol adapter cannot rewrite committed native identity/metadata"
        );
    }
}

#[tokio::test]
async fn provider_restored_s3_alias_rechecks_revocation_and_tenant_before_returning_bytes() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut reader, io, mut session) = restored(backend).await;
        let mut cache = Cache {
            io: &io,
            calls: 0,
            requests: 0,
            revoke: None,
        };
        session.tenant = TenantId(TENANT.0 + 1);
        let foreign = call(&mut reader, &session, &mut cache, "GET", &[]);
        assert_ne!(foreign.status, 200);
        assert_eq!(cache.calls, 0, "foreign tenant must not read shared bytes");
        session.tenant = TENANT;
        cache.revoke = Some(session.auth.clone());
        let revoked = call(
            &mut reader,
            &session,
            &mut cache,
            "GET",
            &[("range", "bytes=2-7")],
        );
        assert_eq!(revoked.status, 403);
        assert_ne!(revoked.body, io.fixture.bytes()[2..8]);
        assert_eq!(cache.calls, 1);
        assert_eq!(
            call(&mut reader, &session, &mut cache, "GET", &[]).status,
            403
        );
        assert_eq!(
            cache.calls, 1,
            "already revoked alias must fail before cache I/O"
        );
        assert!(reader
            .catalogue
            .lookup(TENANT, "object", 60, session.auth.as_ref())
            .is_ok());
        assert!(
            !io.copies.is_empty(),
            "alias revocation never deletes retained bytes"
        );
        session.auth.denied.borrow_mut().remove("bucket/object");
        let revision = reader
            .catalogue
            .lookup(TENANT, "bucket/object", 60, session.auth.as_ref())
            .unwrap()
            .revision;
        reader
            .catalogue
            .transact(
                TENANT,
                OperationId(2100),
                Mutation::Tombstone {
                    name: "bucket/object".into(),
                    expected_revision: revision,
                },
                60,
                session.auth.as_ref(),
            )
            .unwrap();
        assert_ne!(
            call(&mut reader, &session, &mut cache, "GET", &[]).status,
            200
        );
        assert_eq!(
            cache.calls, 1,
            "deleted alias must not redeem old immutable bytes"
        );
        assert!(reader
            .catalogue
            .lookup(TENANT, "object", 60, session.auth.as_ref())
            .is_ok());
    }
}
