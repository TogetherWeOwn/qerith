//! Generated provider restore -> native/REST/MCP authorization and cache delivery.
//! Reference checkpoints are not durable restart or provider qualification.
use super::*;

struct Cache<'a> {
    io: &'a Io,
    auth: &'a Auth,
    revoke: bool,
    reads: usize,
}
impl qerith_core::s3::archive::QualifiedCache for Cache<'_> {
    fn read(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        identity: &CiphertextIdentity,
        location: &str,
        _: PinId,
        range: Option<qerith_core::s3::ByteRange>,
    ) -> std::result::Result<Vec<u8>, qerith_core::s3::ErrorCode> {
        self.reads += 1;
        assert_eq!(tenant, TENANT);
        assert_eq!(generation, GENERATION);
        assert_eq!(identity, &self.io.identity());
        assert_eq!(range, None, "native delivery cannot silently widen ranges");
        if self.revoke {
            self.auth.denied.borrow_mut().insert("key_ref".into());
        }
        self.io
            .copies
            .get(location)
            .cloned()
            .ok_or(qerith_core::s3::ErrorCode::InternalError)
    }
}

async fn restored(
    backend: a::Backend,
) -> (s::Service<Access>, Io, o::Transfer, Rc<Auth>, n::Selection) {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let selection = negotiate(&mut service, &mut io).await;
    let time = Time(Cell::new(60));
    // Unchanged synthetic NNTP qualification permits this fixture's eviction.
    // The separate inventory below is never S3 archive/eviction evidence.
    evict(service.catalogue_mut(), &mut io, &time, auth.as_ref());
    io.assert_cold();
    io.provider_record = Some(record(&io, backend));
    let mut storage = bridge(io, backend, auth.clone(), Fault::None);
    service.set_now(60).unwrap();
    let allocations = service.allocations();
    assert!(parity(
        &mut service,
        &scope(),
        o::Operation::AuthorizeDownload,
        vec![
            text("reference", upload.target.reference.as_str()),
            text("generation", upload.target.generation.as_str()),
            text("identity", "provider_still_cold"),
        ],
    )
    .is_err());
    assert_eq!(service.allocations(), allocations);
    parity(
        &mut service,
        &scope(),
        o::Operation::Restore,
        vec![
            text("reference", upload.target.reference.as_str()),
            text("generation", upload.target.generation.as_str()),
            text("identity", "provider_native_restore"),
            ("availability_seconds".into(), o::Value::Number(50)),
        ],
    )
    .unwrap();
    let mut service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        60,
    )
    .unwrap();
    let job = service
        .catalogue()
        .outbox(TENANT)
        .into_iter()
        .rev()
        .find_map(|event| match event.effect {
            Effect::RunJob(job) if job.kind == JobKind::Restore => Some(job.id),
            _ => None,
        })
        .unwrap();
    let event = job_event(service.catalogue(), job);
    run_once(
        service.catalogue_mut(),
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
        service.catalogue().job(TENANT, job).unwrap().state,
        JobState::Complete
    );
    assert_eq!(storage.nntp.reads, usize::from(backend == a::Backend::Nntp));
    assert_eq!(storage.s3.reads, usize::from(backend == a::Backend::S3));
    (service, storage.cache, upload, auth, selection)
}

#[tokio::test]
async fn provider_restore_rest_mcp_and_native_handles_deliver_after_reference_reconnect() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, upload, auth, selection) = restored(backend).await;
        let time = Time(Cell::new(60));
        let target = n::Target {
            object: nid(upload.target.reference.as_str()),
            g: nid(upload.target.generation.as_str()),
        };
        let n::ResponseBody::Download(native_transfer) = native(
            &mut service,
            &request(
                "provider_native_download",
                Some(&selection.session),
                n::Action::Download(n::Download {
                    target,
                    range: None,
                    max_bytes: io.identity().length,
                }),
            ),
            &mut io,
            &time,
            &Rules::default(),
        )
        .await
        else {
            panic!("native download");
        };
        let arguments = serde_json::to_vec(&serde_json::json!({
            "reference": upload.target.reference.as_str(),
            "generation": upload.target.generation.as_str(),
            "identity": "provider_protocol_delivery",
        }))
        .unwrap();
        let mut mcp_service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            limits(),
            profile(),
            60,
        )
        .unwrap();
        let o::Output::Download(rest_transfer) = o::rest_request(
            &mut service,
            Some(&scope()),
            "POST",
            &format!(
                "/v1/operations/{}",
                o::Operation::AuthorizeDownload.definition().name
            ),
            &arguments,
        )
        .outcome
        .unwrap() else {
            panic!("REST download");
        };
        let mcp = o::mcp_request(
            &mut mcp_service,
            Some(&scope()),
            o::McpSession::default(),
            o::TaskMode::Baseline,
            o::Operation::AuthorizeDownload.definition().name,
            &arguments,
        );
        assert!(!mcp.is_error);
        let o::Output::Download(mcp_transfer) = mcp.outcome.unwrap() else {
            panic!("MCP download");
        };
        assert_eq!(rest_transfer, mcp_transfer);
        let mut service = s::Service::reconnect(
            service.checkpoint(),
            Access(auth.clone()),
            limits(),
            profile(),
            60,
        )
        .unwrap();
        // No provider transport is available to either cache delivery path.
        let mut cache = Cache {
            io: &io,
            auth: &auth,
            revoke: false,
            reads: 0,
        };
        for handle in [id(native_transfer.handle.as_str()), rest_transfer.handle] {
            assert_eq!(
                service
                    .read_download(&scope(), &handle, &mut cache, &time)
                    .unwrap(),
                io.fixture.bytes(),
            );
        }
        assert_eq!(
            mcp_service
                .read_download(&scope(), &mcp_transfer.handle, &mut cache, &time)
                .unwrap(),
            io.fixture.bytes(),
        );
        assert_eq!(cache.reads, 3);
        evidence(
            if backend == a::Backend::S3 {
                "provider-s3-native-delivery.json"
            } else {
                "provider-nntp-native-delivery.json"
            },
            serde_json::json!({
                "head_sha": std::env::var("QERITH_EVIDENCE_HEAD").ok(),
                "kind": "synthetic_provider_restore_to_native_rest_mcp_delivery",
                "cold_denial_before_explicit_restore": true,
                "actual_rest_and_mcp_handles_redeemed": true,
                "full_ciphertext_cache_reads": cache.reads,
                "durable_restart_or_physical_qualification": false,
                "s3_archive_or_eviction_qualification": false,
            }),
        );
    }
}

#[tokio::test]
async fn provider_restored_native_cache_rechecks_keys_scope_and_unsupported_ranges() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        let (mut service, mut io, upload, auth, selection) = restored(backend).await;
        let time = Time(Cell::new(60));
        let allocations = service.allocations();
        assert_eq!(
            native(
                &mut service,
                &request(
                    "provider_native_range",
                    Some(&selection.session),
                    n::Action::Download(n::Download {
                        target: n::Target {
                            object: nid(upload.target.reference.as_str()),
                            g: nid(upload.target.generation.as_str()),
                        },
                        range: Some(n::ByteRange { first: 2, last: 7 }),
                        max_bytes: io.identity().length,
                    }),
                ),
                &mut io,
                &time,
                &Rules::default(),
            )
            .await,
            n::ResponseBody::Error(n::ErrorCode::InvalidRange),
        );
        assert_eq!(service.allocations(), allocations);
        let o::Output::Download(transfer) = parity(
            &mut service,
            &scope(),
            o::Operation::AuthorizeDownload,
            vec![
                text("reference", upload.target.reference.as_str()),
                text("generation", upload.target.generation.as_str()),
                text("identity", "provider_bound_delivery"),
            ],
        )
        .unwrap() else {
            panic!("download");
        };
        let mut cache = Cache {
            io: &io,
            auth: &auth,
            revoke: false,
            reads: 0,
        };
        let foreign = o::Scope {
            tenant: id("other"),
            principal: id("principal"),
        };
        assert!(service
            .read_download(&foreign, &transfer.handle, &mut cache, &time)
            .is_err());
        assert_eq!(cache.reads, 0);
        auth.denied.borrow_mut().insert("envelope_ref".into());
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied,
        );
        assert_eq!(
            cache.reads, 0,
            "missing envelope grant fails before byte I/O"
        );
        auth.denied.borrow_mut().remove("envelope_ref");
        cache.revoke = true;
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied,
        );
        assert_eq!(cache.reads, 1, "revocation after I/O withholds all bytes");
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied,
        );
        assert_eq!(cache.reads, 1);
        assert!(
            !io.copies.is_empty(),
            "key revocation is not cache deletion authority"
        );
    }
}
