use super::*;
use qerith_core::s3::{self, mutation as m};

#[path = "../support/s3_body.rs"]
mod signed_body;

fn mutations() -> m::MemoryMutations {
    m::MemoryMutations::new(m::MutationPolicy {
        object_bytes: 64,
        part_bytes: 32,
        min_part_bytes: 2,
        parts: 4,
        sessions: 4,
        staged_bytes: 128,
        batch_keys: 4,
        lifetime: 100,
        archive_window: 200,
        result_retention: 30,
        max_attempts: 4,
    })
    .unwrap()
}
fn destination() -> Reference {
    Reference {
        tenant: TENANT,
        name: "object".into(),
    }
}
fn prepare(model: &m::MemoryMutations, auth: &Auth) -> m::PreparedWrite {
    model
        .prepare(
            destination(),
            m::UploadMetadata {
                headers: BTreeMap::from([(
                    "content-type".into(),
                    "application/octet-stream".into(),
                )]),
                recovery_ref: "synthetic-s3-upload-recovery".into(),
                encryption_context: "synthetic_C".into(),
            },
            m::DestinationConditions::default(),
            None,
            10,
            auth,
        )
        .unwrap()
}
fn body(bytes: &[u8]) -> m::ValidatedBody {
    signed_body::body_with(bytes, Some(s3::ChecksumAlgorithm::Sha256), &[]).unwrap()
}

#[tokio::test]
async fn s3_put_and_multipart_commits_feed_exact_retained_bytes_to_each_provider() {
    for backend in [a::Backend::Nntp, a::Backend::S3] {
        for multipart in [false, true] {
            let auth = Rc::new(Auth::default());
            let bytes: Vec<_> = (0..24u8).map(|n| n.wrapping_mul(17)).collect();
            let mut model = mutations();
            let prepared = prepare(&model, &auth);
            let committed = if multipart {
                let id = model
                    .initiate(prepared, m::MultipartChecksum::None, 10, auth.as_ref())
                    .unwrap();
                let parts: Vec<_> = bytes
                    .chunks(12)
                    .enumerate()
                    .map(|(n, part)| {
                        model
                            .upload_part(
                                &destination(),
                                id,
                                n as u16 + 1,
                                signed_body::body(part),
                                10,
                                auth.as_ref(),
                            )
                            .unwrap()
                    })
                    .collect();
                assert!(model.catalogue().outbox(TENANT).is_empty());
                assert_eq!(model.retained_bytes(TENANT), 0);
                let mut invalid = parts.clone();
                invalid[0].etag.push_str("-different");
                assert_eq!(
                    model
                        .complete(&destination(), id, invalid, None, 10, auth.as_ref())
                        .unwrap_err(),
                    s3::ErrorCode::InvalidPart
                );
                assert!(model.catalogue().outbox(TENANT).is_empty());
                assert_eq!(model.retained_bytes(TENANT), 0);
                let result = model
                    .complete(&destination(), id, parts.clone(), None, 10, auth.as_ref())
                    .unwrap();
                let outbox = model.catalogue().outbox(TENANT);
                let replay = model
                    .complete(&destination(), id, parts, None, 10, auth.as_ref())
                    .unwrap();
                assert_eq!(replay.generation, result.generation);
                assert_eq!(replay.etag, result.etag);
                assert_eq!(model.catalogue().outbox(TENANT), outbox);
                result
            } else {
                model
                    .put(prepared, body(&bytes), 10, auth.as_ref())
                    .unwrap()
            };
            assert_eq!(committed.generation, GENERATION);
            let view = model
                .catalogue()
                .generation(TENANT, committed.generation)
                .unwrap();
            let metadata = view.metadata.clone();
            assert_eq!(metadata.validator, committed.etag);
            assert_eq!(metadata.identity.length, bytes.len() as u64);
            assert_eq!(
                metadata.identity.sha256,
                <[u8; 32]>::from(Sha256::digest(&bytes))
            );
            if multipart {
                assert!(metadata.checksums.is_empty());
            } else {
                assert_eq!(metadata.checksums[0].kind, ChecksumType::FullObject);
            }
            let retained = model
                .retained_for_archive(TENANT, committed.generation)
                .unwrap();
            assert_eq!(retained, bytes);
            assert!(model
                .retained_for_archive(TenantId(2), committed.generation)
                .is_err());
            let location = view.cache_location.clone().unwrap();
            // Explicit reference-cache handoff, not a durable transaction or a
            // second generated byte source. The mutation model keeps its safety copy.
            let mut io = Io::new(committed.generation.0).await;
            io.fixture = FixtureC::committed(
                Key {
                    object: 1,
                    generation: committed.generation.0,
                },
                retained.to_vec(),
            );
            io.copies.insert(location.clone(), retained.to_vec());
            let mut storage = write_storage(io, backend, WriteFault::Qualify, auth.clone());
            let archive = model
                .catalogue()
                .outbox(TENANT)
                .into_iter()
                .find_map(|event| match event.effect {
                    Effect::RunJob(job) if job.kind == JobKind::Archive => Some(job.id),
                    _ => None,
                })
                .unwrap();
            let result = qualified_attempt(
                model.catalogue_worker(),
                &mut storage,
                archive,
                &auth,
                &Time(Cell::new(10)),
                0,
            )
            .await;
            assert_eq!(writer(&storage, backend).calls, ["begin", "part", "commit"]);
            let record = storage.cache.provider_record.as_ref().unwrap();
            assert_eq!(record.identity.target.backend, backend);
            assert_eq!(record.identity.sha256, metadata.identity.sha256);
            assert_eq!(record.identity.bytes, metadata.identity.length);
            assert_eq!(storage.cache.copies[&location], bytes);
            assert_eq!(
                model
                    .retained_for_archive(TENANT, committed.generation)
                    .unwrap(),
                bytes
            );
            assert_eq!(
                model
                    .catalogue()
                    .generation(TENANT, GENERATION)
                    .unwrap()
                    .metadata,
                metadata
            );
            assert!(storage.cache.pending.is_empty());
            assert!(storage.cache.trace.0.is_empty());
            if backend == a::Backend::Nntp {
                assert_eq!(result, Err(Failure::Io(IoError::RepairUnavailable)));
                assert_retained(model.catalogue(), &storage, archive, backend);
                assert_eq!(storage.s3.inner.reads, 0);
            } else {
                result.unwrap();
                assert_eq!(
                    model.catalogue().job(TENANT, archive).unwrap().state,
                    JobState::Complete
                );
                assert!(storage.nntp.calls.is_empty());
                assert_eq!(storage.nntp.inner.reads, 0);
                assert_eq!(storage.s3.inner.reads, 1);
            }
        }
    }
}

#[test]
fn s3_aborted_or_revoked_upload_never_creates_archive_work_or_retained_bytes() {
    let auth = Auth::default();
    let mut model = mutations();
    let prepared = prepare(&model, &auth);
    let id = model
        .initiate(prepared, m::MultipartChecksum::None, 10, &auth)
        .unwrap();
    let part = model
        .upload_part(
            &destination(),
            id,
            1,
            signed_body::body(&[0, 255, 128]),
            10,
            &auth,
        )
        .unwrap();
    model.abort(&destination(), id, 10, &auth).unwrap();
    assert_eq!(
        model
            .complete(&destination(), id, vec![part], None, 10, &auth)
            .unwrap_err(),
        s3::ErrorCode::NoSuchUpload
    );
    assert!(model.catalogue().outbox(TENANT).is_empty());
    assert_eq!(model.retained_bytes(TENANT), 0);
    let prepared = prepare(&model, &auth);
    auth.denied.borrow_mut().insert("object:Write".into());
    assert_eq!(
        model
            .put(prepared, body(&[0, 255, 128]), 10, &auth)
            .unwrap_err(),
        s3::ErrorCode::AccessDenied
    );
    assert!(model.catalogue().outbox(TENANT).is_empty());
    assert_eq!(model.retained_bytes(TENANT), 0);
}
