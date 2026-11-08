use super::*;
use qerith_core::s3::{archive::QualifiedCache, read::ByteRange, ErrorCode};

#[derive(Clone, Copy)]
enum CacheFault {
    None,
    Short,
    Long,
    Corrupt,
    Missing,
    Revoke(&'static str),
    RevokeAndFail,
    Expire,
    Rollback,
}

struct Cache<'a> {
    io: &'a Io,
    auth: &'a Auth,
    time: &'a Time,
    fault: CacheFault,
    reads: usize,
}
impl QualifiedCache for Cache<'_> {
    fn read(
        &mut self,
        tenant: TenantId,
        generation: GenerationId,
        identity: &CiphertextIdentity,
        location: &str,
        _pin: PinId,
        range: Option<ByteRange>,
    ) -> std::result::Result<Vec<u8>, ErrorCode> {
        self.reads += 1;
        assert_eq!(tenant, TENANT);
        assert_eq!(generation, GenerationId(1));
        assert_eq!(identity, &self.io.identity());
        assert_eq!(range, None);
        let mut bytes = self.io.copies.get(location).unwrap().clone();
        assert_eq!(bytes, self.io.fixture.bytes());
        match self.fault {
            CacheFault::None => {}
            CacheFault::Short => {
                bytes.pop();
            }
            CacheFault::Long => bytes.push(0),
            CacheFault::Corrupt => bytes[0] ^= 1,
            CacheFault::Missing => return Err(ErrorCode::InternalError),
            CacheFault::Revoke(name) => {
                self.auth.denied.borrow_mut().insert(name.into());
            }
            CacheFault::RevokeAndFail => {
                self.auth.denied.borrow_mut().insert("object".into());
                return Err(ErrorCode::InternalError);
            }
            CacheFault::Expire => self.time.0.set(60),
            CacheFault::Rollback => self.time.0.set(9),
        }
        Ok(bytes)
    }
}

#[tokio::test]
async fn delivery_sanitizes_cache_failure_after_reference_revocation() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    let time = Time(Cell::new(10));
    let mut cache = Cache {
        io: &io,
        auth: &auth,
        time: &time,
        fault: CacheFault::RevokeAndFail,
        reads: 0,
    };
    assert_eq!(
        service
            .read_download(&scope(), &transfer.handle, &mut cache, &time)
            .unwrap_err()
            .code,
        o::ErrorCode::Denied
    );
    assert_eq!(cache.reads, 1);
}

fn authorize(service: &mut s::Service<Access>, target: &o::LogicalReference) -> o::Transfer {
    let o::Output::Download(transfer) = parity(
        service,
        &scope(),
        o::Operation::AuthorizeDownload,
        vec![
            text("reference", target.reference.as_str()),
            text("generation", target.generation.as_str()),
            text("identity", "delivery"),
        ],
    )
    .unwrap() else {
        panic!("download");
    };
    transfer
}

#[tokio::test]
async fn native_rest_mcp_handles_deliver_exact_generated_ciphertext_after_reconnect() {
    let (mut service, mut io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    let selection = negotiate(&mut service, &mut io).await;
    let target = n::Target {
        object: nid(upload.target.reference.as_str()),
        g: nid(upload.target.generation.as_str()),
    };
    let n::ResponseBody::Download(native_transfer) = native(
        &mut service,
        &request(
            "delivery_native",
            Some(&selection.session),
            n::Action::Download(n::Download {
                target,
                range: None,
                max_bytes: io.identity().length,
            }),
        ),
        &mut io,
        &Time(Cell::new(10)),
        &Rules::default(),
    )
    .await
    else {
        panic!("native download");
    };
    let mut reconnected = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    let mut mcp_service = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        limits(),
        profile(),
        10,
    )
    .unwrap();
    let arguments = serde_json::to_vec(&serde_json::json!({
        "reference": upload.target.reference.as_str(),
        "generation": upload.target.generation.as_str(),
        "identity": "delivery_mcp",
    }))
    .unwrap();
    let o::Output::Download(mcp_transfer) = o::mcp_request(
        &mut mcp_service,
        Some(&scope()),
        o::McpSession::default(),
        o::TaskMode::Baseline,
        o::Operation::AuthorizeDownload.definition().name,
        &arguments,
    )
    .outcome
    .unwrap() else {
        panic!("mcp download");
    };
    let time = Time(Cell::new(11));
    let mut cache = Cache {
        io: &io,
        auth: &auth,
        time: &time,
        fault: CacheFault::None,
        reads: 0,
    };
    for handle in [transfer.handle, id(native_transfer.handle.as_str())] {
        assert_eq!(
            reconnected
                .read_download(&scope(), &handle, &mut cache, &time)
                .unwrap(),
            io.fixture.bytes()
        );
        // Cache delivery neither consumes nor extends the original transfer pin.
        assert!(reconnected.redeem(&scope(), &handle).is_ok());
    }
    assert_eq!(
        mcp_service
            .read_download(&scope(), &mcp_transfer.handle, &mut cache, &time)
            .unwrap(),
        io.fixture.bytes()
    );
    assert_eq!(cache.reads, 3);
    assert_eq!(time.0.get(), 11);
    evidence(
        "service-delivery.json",
        serde_json::json!({
            "kind": "synthetic_full_ciphertext_delivery",
            "head_sha": std::env::var("QERITH_EVIDENCE_HEAD").ok(),
            "native_rest_mcp_handles": true,
            "generated_bytes": io.identity().length,
            "cache_reads": cache.reads,
            "reconnect_is_non_durable": true,
            "physical_provider_qualification": false,
        }),
    );
}

#[tokio::test]
async fn delivery_checks_scope_key_policy_and_budget_before_cache_io() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    let time = Time(Cell::new(10));
    let mut cache = Cache {
        io: &io,
        auth: &auth,
        time: &time,
        fault: CacheFault::None,
        reads: 0,
    };
    for foreign in [
        o::Scope {
            tenant: id("other"),
            principal: id("principal"),
        },
        o::Scope {
            tenant: id("tenant"),
            principal: id("other"),
        },
    ] {
        assert_eq!(
            service
                .read_download(&foreign, &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied
        );
    }
    for name in ["object", "key_ref", "envelope_ref"] {
        auth.denied.borrow_mut().insert(name.into());
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied
        );
        auth.denied.borrow_mut().clear();
    }
    let mut tight = limits();
    tight.bytes = io.identity().length - 1;
    let mut reconnected = s::Service::reconnect(
        service.checkpoint(),
        Access(auth.clone()),
        tight,
        profile(),
        10,
    )
    .unwrap();
    assert_eq!(
        reconnected
            .read_download(&scope(), &transfer.handle, &mut cache, &time)
            .unwrap_err()
            .code,
        o::ErrorCode::QuotaExceeded
    );
    assert_eq!(cache.reads, 0);
}

#[tokio::test]
async fn delivery_withholds_bytes_on_cache_identity_failure_without_archive_fallback() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    let time = Time(Cell::new(10));
    let mut cache = Cache {
        io: &io,
        auth: &auth,
        time: &time,
        fault: CacheFault::None,
        reads: 0,
    };
    for (fault, code) in [
        (CacheFault::Short, o::ErrorCode::IntegrityFailed),
        (CacheFault::Long, o::ErrorCode::IntegrityFailed),
        (CacheFault::Corrupt, o::ErrorCode::IntegrityFailed),
        (CacheFault::Missing, o::ErrorCode::Unavailable),
    ] {
        cache.fault = fault;
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            code
        );
    }
    assert_eq!(cache.reads, 4);
}

#[tokio::test]
async fn delivery_rechecks_live_grants_and_advancing_clock_after_cache_io() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    for name in ["object", "key_ref", "envelope_ref"] {
        let time = Time(Cell::new(10));
        let mut cache = Cache {
            io: &io,
            auth: &auth,
            time: &time,
            fault: CacheFault::Revoke(name),
            reads: 0,
        };
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            o::ErrorCode::Denied
        );
        assert_eq!(cache.reads, 1);
        auth.denied.borrow_mut().clear();
    }
    for (fault, code) in [
        (CacheFault::Rollback, o::ErrorCode::Unavailable),
        (CacheFault::Expire, o::ErrorCode::NotAvailable),
    ] {
        let time = Time(Cell::new(10));
        let mut cache = Cache {
            io: &io,
            auth: &auth,
            time: &time,
            fault,
            reads: 0,
        };
        assert_eq!(
            service
                .read_download(&scope(), &transfer.handle, &mut cache, &time)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(cache.reads, 1);
    }
}

#[tokio::test]
async fn delivery_moderation_and_expiry_deny_even_with_retained_cache_bytes() {
    let (mut service, io, upload, _, auth) = hot_upload().await;
    let transfer = authorize(&mut service, &upload.target);
    let time = Time(Cell::new(10));
    let mut cache = Cache {
        io: &io,
        auth: &auth,
        time: &time,
        fault: CacheFault::None,
        reads: 0,
    };
    let (generation, _) = service.redeem(&scope(), &transfer.handle).unwrap();
    service
        .catalogue_mut()
        .set_moderation(TENANT, generation, 1, true)
        .unwrap();
    assert_eq!(
        service
            .read_download(&scope(), &transfer.handle, &mut cache, &time)
            .unwrap_err()
            .code,
        o::ErrorCode::Denied
    );
    service
        .catalogue_mut()
        .set_moderation(TENANT, generation, 2, false)
        .unwrap();
    // Moderation epoch changes fence the old pin even when the object is unbanned.
    assert!(service
        .read_download(&scope(), &transfer.handle, &mut cache, &time)
        .is_err());
    assert_eq!(cache.reads, 0);
    assert!(!io.copies.is_empty());
}
