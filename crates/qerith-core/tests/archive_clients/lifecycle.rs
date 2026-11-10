//! SDK-free glue regression; client normalization cannot replace raw vector tests.
use super::{http::Request, router::State};
use hmac::{Hmac, KeyInit, Mac};
use qerith_core::s3::Response;
use sha2::{Digest, Sha256};

fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Fixture {
    state: State,
    secret: String,
    token: String,
}
impl Fixture {
    fn new() -> Self {
        use std::io::Read;
        let mut bytes = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut bytes)
            .unwrap();
        let secret = hex(&bytes);
        Self {
            state: State::new(secret.clone()),
            secret,
            token: "fixture-control".into(),
        }
    }
    async fn control_response(&mut self, command: &str, body: &[u8]) -> Response {
        self.state
            .handle(
                Request {
                    method: "POST".into(),
                    target: format!("/__fixture/{command}"),
                    fields: vec![("authorization".into(), format!("Bearer {}", self.token))],
                    body: body.to_vec(),
                },
                &self.token,
            )
            .await
    }
    async fn control(&mut self, command: &str, body: &[u8]) -> serde_json::Value {
        let response = self.control_response(command, body).await;
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        serde_json::from_slice(&response.body).unwrap()
    }
    async fn call(
        &mut self,
        method: &str,
        target: &str,
        body: &[u8],
        extra: &[(&str, &str)],
    ) -> Response {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let date = chrono::DateTime::from_timestamp(now as i64, 0).unwrap();
        let timestamp = date.format("%Y%m%dT%H%M%SZ").to_string();
        let day = date.format("%Y%m%d").to_string();
        let payload = extra
            .iter()
            .find(|(name, _)| *name == "x-amz-content-sha256")
            .map_or_else(
                || hex(&Sha256::digest(body)),
                |(_, value)| value.to_string(),
            );
        // Deliberately independent signer construction for this simple target.
        // The broader escaped-path/raw-signature corpus remains a separate test.
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let query = if query.is_empty() {
            String::new()
        } else if query.contains('=') {
            query.into()
        } else {
            format!("{query}=")
        };
        let mut fields = std::collections::BTreeMap::from([
            ("host".to_owned(), "localhost:443".to_owned()),
            ("x-amz-content-sha256".into(), payload.clone()),
            ("x-amz-date".into(), timestamp.clone()),
            ("content-length".into(), body.len().to_string()),
        ]);
        fields.extend(extra.iter().map(|(n, v)| (n.to_string(), v.to_string())));
        let signed = fields.keys().cloned().collect::<Vec<_>>().join(";");
        let canonical_headers: String = fields.iter().map(|(n, v)| format!("{n}:{v}\n")).collect();
        let canonical =
            format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed}\n{payload}");
        let scope = format!("{day}/us-east-1/s3/aws4_request");
        let string = format!(
            "AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
            hex(&Sha256::digest(canonical.as_bytes()))
        );
        let key = hmac(
            &hmac(
                &hmac(
                    &hmac(format!("AWS4{}", self.secret).as_bytes(), day.as_bytes()),
                    b"us-east-1",
                ),
                b"s3",
            ),
            b"aws4_request",
        );
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential=fixture/{scope}, SignedHeaders={signed}, Signature={}",
            hex(&hmac(&key, string.as_bytes()))
        );
        fields.insert("authorization".into(), authorization);
        self.state
            .handle(
                Request {
                    method: method.into(),
                    target: target.into(),
                    fields: fields.into_iter().collect(),
                    body: body.to_vec(),
                },
                &self.token,
            )
            .await
    }
}
fn header<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
    response
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}
fn error(response: &Response, status: u16, name: &str) {
    assert_eq!(
        response.status,
        status,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    assert!(String::from_utf8_lossy(&response.body).contains(&format!("<Code>{name}</Code>")));
}

#[tokio::test]
async fn retained_restore_reuses_version_then_both_cache_kinds_can_be_evicted() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    assert_eq!(
        f.call("PUT", "/archive/key", b"exact retained bytes", &[])
            .await
            .status,
        200
    );
    f.control("post", b"").await;
    let restore = b"<RestoreRequest><Days>1</Days></RestoreRequest>";
    assert_eq!(
        f.call("POST", "/archive/key?restore", restore, &[])
            .await
            .status,
        202
    );
    // A pending job makes eviction unlawful: refusal must not panic or dispatch.
    error(
        &f.control_response("evict", b"").await,
        403,
        "InvalidObjectState",
    );
    assert_eq!(f.control("restore", b"").await["cold_retrievals"], 0);
    assert_eq!(
        f.call("GET", "/archive/key", b"", &[]).await.body,
        b"exact retained bytes"
    );
    f.control("expire", b"").await;
    assert_eq!(f.control("evict", b"").await["retained_bytes"], 0);
    // Repeated archive control on an already cold generation is idempotent.
    f.control("archive", b"").await;
    assert_eq!(
        f.call("POST", "/archive/key?restore", restore, &[])
            .await
            .status,
        202
    );
    assert_eq!(f.control("restore", b"").await["cold_retrievals"], 1);
    assert_eq!(
        f.call("GET", "/archive/key", b"", &[]).await.body,
        b"exact retained bytes"
    );
    // A restored delivery cache is deleted through its own exact storage fence.
    f.control("expire", b"").await;
    f.control("evict", b"").await;
}

#[tokio::test]
async fn delete_objects_validates_selected_sha256_before_mutation() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    assert_eq!(
        f.call("PUT", "/archive/key", b"retained", &[]).await.status,
        200
    );
    let body = b"<Delete><Object><Key>key</Key></Object></Delete>";
    error(
        &f.call(
            "POST",
            "/archive?delete",
            body,
            &[
                ("x-amz-sdk-checksum-algorithm", "SHA256"),
                (
                    "x-amz-checksum-sha256",
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                ),
            ],
        )
        .await,
        400,
        "BadDigest",
    );
    assert_eq!(f.call("HEAD", "/archive/key", b"", &[]).await.status, 200);
    let checksum = STANDARD.encode(Sha256::digest(body));
    assert_eq!(
        f.call(
            "POST",
            "/archive?delete",
            body,
            &[
                ("x-amz-sdk-checksum-algorithm", "SHA256"),
                ("x-amz-checksum-sha256", &checksum),
            ],
        )
        .await
        .status,
        200
    );
    assert_eq!(f.call("HEAD", "/archive/key", b"", &[]).await.status, 404);
}

#[tokio::test]
async fn part_copy_validates_body_receipts_before_changing_inventory() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    assert_eq!(
        f.call("PUT", "/archive/source", b"source", &[])
            .await
            .status,
        200
    );
    f.control("post", b"").await;
    assert_eq!(
        f.call(
            "POST",
            "/archive/source?restore",
            b"<RestoreRequest><Days>1</Days></RestoreRequest>",
            &[]
        )
        .await
        .status,
        202
    );
    f.control("restore", b"").await;
    let init = f
        .call("POST", "/archive/destination?uploads", b"", &[])
        .await;
    assert_eq!(init.status, 200);
    let xml = String::from_utf8(init.body).unwrap();
    let id = xml
        .split("<UploadId>")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    let target = format!("/archive/destination?partNumber=1&uploadId={id}");
    assert_eq!(
        f.call("PUT", &target, b"original part", &[]).await.status,
        200
    );
    let inventory_target = format!("/archive/destination?uploadId={id}");
    let before = f.call("GET", &inventory_target, b"", &[]).await;
    assert_eq!(before.status, 200);
    let wrong_payload = hex(&Sha256::digest(b"not the empty received body"));
    for (body, extra, code) in [
        (b"ignored".as_slice(), vec![], "InvalidRequest"),
        (
            b"".as_slice(),
            vec![("x-amz-content-sha256", wrong_payload.as_str())],
            "BadDigest",
        ),
        (
            b"".as_slice(),
            vec![(
                "x-amz-checksum-sha256",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            )],
            "BadDigest",
        ),
        (
            b"".as_slice(),
            vec![("x-amz-checksum-crc32", "AQIDBA==")],
            "BadDigest",
        ),
        (
            b"".as_slice(),
            vec![("content-md5", "AAAAAAAAAAAAAAAAAAAAAA==")],
            "BadDigest",
        ),
        (
            b"".as_slice(),
            vec![("x-amz-checksum-algorithm", "SHA256")],
            "InvalidRequest",
        ),
        (
            b"".as_slice(),
            vec![("x-amz-sdk-checksum-algorithm", "CRC32")],
            "InvalidRequest",
        ),
        (
            b"".as_slice(),
            vec![("x-amz-checksum-algorithm", "CRC64NVME")],
            "InvalidRequest",
        ),
        (
            b"".as_slice(),
            vec![("x-amz-checksum-type", "COMPOSITE")],
            "InvalidRequest",
        ),
    ] {
        let mut fields = vec![("x-amz-copy-source", "archive/source")];
        fields.extend(extra);
        error(&f.call("PUT", &target, body, &fields).await, 400, code);
        let after = f.call("GET", &inventory_target, b"", &[]).await;
        assert_eq!(after.status, 200);
        assert_eq!(after.body, before.body);
        assert_eq!(
            f.call("HEAD", "/archive/destination", b"", &[])
                .await
                .status,
            404
        );
    }
    let empty_checksum = STANDARD.encode(Sha256::digest(b""));
    assert_eq!(
        f.call(
            "PUT",
            &target,
            b"",
            &[
                ("x-amz-copy-source", "archive/source"),
                ("x-amz-checksum-sha256", &empty_checksum),
            ]
        )
        .await
        .status,
        200
    );
    let after = f.call("GET", &inventory_target, b"", &[]).await;
    assert_eq!(after.status, 200);
    assert_ne!(after.body, before.body);
    assert!(String::from_utf8_lossy(&after.body).contains("<Size>6</Size>"));
}

#[tokio::test]
async fn incompatible_selectors_never_publish_or_change_upload_inventory() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    let init = f.call("POST", "/archive/key?uploads", b"", &[]).await;
    assert_eq!(init.status, 200);
    let xml = String::from_utf8(init.body).unwrap();
    let id = xml
        .split("<UploadId>")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    assert_eq!(
        f.call(
            "PUT",
            &format!("/archive/key?partNumber=1&uploadId={id}"),
            b"original",
            &[]
        )
        .await
        .status,
        200
    );
    let parts_target = format!("/archive/key?uploadId={id}");
    let uploads = f.call("GET", "/archive?uploads", b"", &[]).await;
    let parts = f.call("GET", &parts_target, b"", &[]).await;
    assert_eq!(uploads.status, 200);
    assert_eq!(parts.status, 200);
    for (method, suffix) in [
        ("PUT", "/key?restore"),
        ("DELETE", "/key?restore"),
        ("PUT", "/key?partNumber=1"),
        ("PUT", "/key?uploads"),
        ("GET", "/key?uploads"),
        ("POST", "?uploads"),
        ("POST", "/key?delete"),
        ("POST", "?restore"),
        ("PUT", "/key?location"),
        ("PUT", "/key?max-parts=1"),
        ("PUT", "/key?list-type=2"),
        ("DELETE", "?uploads"),
    ] {
        error(
            &f.call(method, &format!("/archive{suffix}"), b"", &[]).await,
            400,
            "InvalidRequest",
        );
        assert_eq!(f.call("HEAD", "/archive/key", b"", &[]).await.status, 404);
        assert_eq!(
            f.call("GET", "/archive?uploads", b"", &[]).await.body,
            uploads.body
        );
        assert_eq!(
            f.call("GET", &parts_target, b"", &[]).await.body,
            parts.body
        );
    }
    for (method, target) in [
        ("POST", format!("/archive/key?partNumber=1&uploadId={id}")),
        ("DELETE", format!("/archive/key?partNumber=1&uploadId={id}")),
        ("GET", format!("/archive?uploadId={id}")),
        ("PUT", format!("/archive/key?uploadId={id}")),
        ("DELETE", format!("/archive/key?max-parts=1&uploadId={id}")),
    ] {
        error(
            &f.call(method, &target, b"", &[]).await,
            400,
            "InvalidRequest",
        );
        assert_eq!(f.call("HEAD", "/archive/key", b"", &[]).await.status, 404);
        assert_eq!(
            f.call("GET", "/archive?uploads", b"", &[]).await.body,
            uploads.body
        );
        assert_eq!(
            f.call("GET", &parts_target, b"", &[]).await.body,
            parts.body
        );
    }
}

#[tokio::test]
async fn copy_rejects_ignored_body_and_checksum_selection_without_publication() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    assert_eq!(
        f.call("PUT", "/archive/source", b"source", &[])
            .await
            .status,
        200
    );
    f.control("post", b"").await;
    assert_eq!(
        f.call(
            "POST",
            "/archive/source?restore",
            b"<RestoreRequest><Days>1</Days></RestoreRequest>",
            &[]
        )
        .await
        .status,
        202
    );
    f.control("restore", b"").await;
    for (body, extra) in [
        (b"ignored".as_slice(), vec![]),
        (b"".as_slice(), vec![("x-amz-checksum-algorithm", "CRC32")]),
        (b"".as_slice(), vec![("x-amz-checksum-algorithm", "SHA256")]),
        (
            b"".as_slice(),
            vec![("x-amz-sdk-checksum-algorithm", "CRC32")],
        ),
    ] {
        let mut headers = vec![("x-amz-copy-source", "archive/source")];
        headers.extend(extra);
        error(
            &f.call("PUT", "/archive/destination", body, &headers).await,
            400,
            "InvalidRequest",
        );
        assert_eq!(
            f.call("HEAD", "/archive/destination", b"", &[])
                .await
                .status,
            404
        );
    }
    assert_eq!(
        f.call(
            "PUT",
            "/archive/destination",
            b"",
            &[("x-amz-copy-source", "archive/source")]
        )
        .await
        .status,
        200
    );
}

#[tokio::test]
async fn multipart_selectors_and_checksum_types_are_fail_closed() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    error(
        &f.call("POST", "/archive/key?uploadId=1&uploads=", b"", &[])
            .await,
        400,
        "InvalidRequest",
    );
    for (algorithm, kind) in [
        ("CRC32", "COMPOSITE"),
        ("SHA256", "FULL_OBJECT"),
        ("CRC32", "invalid"),
    ] {
        error(
            &f.call(
                "POST",
                "/archive/key?uploads",
                b"",
                &[
                    ("x-amz-checksum-algorithm", algorithm),
                    ("x-amz-checksum-type", kind),
                ],
            )
            .await,
            400,
            "InvalidRequest",
        );
    }
    let inventory = f.call("GET", "/archive?uploads", b"", &[]).await;
    assert_eq!(inventory.status, 200);
    assert!(!String::from_utf8_lossy(&inventory.body).contains("<Upload>"));
    let init = f
        .call(
            "POST",
            "/archive/key?uploads",
            b"",
            &[
                ("x-amz-checksum-algorithm", "CRC32"),
                ("x-amz-checksum-type", "FULL_OBJECT"),
            ],
        )
        .await;
    assert_eq!(init.status, 200);
    let xml = String::from_utf8(init.body).unwrap();
    let id = xml
        .split("<UploadId>")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    let part = f
        .call(
            "PUT",
            &format!("/archive/key?partNumber=1&uploadId={id}"),
            b"part",
            &[("x-amz-checksum-crc32", "SQ9wxg==")],
        )
        .await;
    assert_eq!(part.status, 200);
    let body = format!("<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{}</ETag><ChecksumCRC32>SQ9wxg==</ChecksumCRC32></Part></CompleteMultipartUpload>", header(&part, "etag").unwrap());
    let target = format!("/archive/key?uploadId={id}");
    for kind in ["COMPOSITE", "invalid"] {
        error(
            &f.call(
                "POST",
                &target,
                body.as_bytes(),
                &[
                    ("x-amz-checksum-crc32", "SQ9wxg=="),
                    ("x-amz-checksum-type", kind),
                ],
            )
            .await,
            400,
            "InvalidRequest",
        );
        assert_eq!(f.call("HEAD", "/archive/key", b"", &[]).await.status, 404);
    }
    assert_eq!(
        f.call(
            "POST",
            &target,
            body.as_bytes(),
            &[
                ("x-amz-checksum-crc32", "SQ9wxg=="),
                ("x-amz-checksum-type", "FULL_OBJECT")
            ]
        )
        .await
        .status,
        200
    );
}

#[tokio::test]
async fn completion_sha256_header_is_rejected_not_ignored() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    let init = f
        .call(
            "POST",
            "/archive/key?uploads",
            b"",
            &[("x-amz-checksum-algorithm", "SHA256")],
        )
        .await;
    assert_eq!(init.status, 200);
    let xml = String::from_utf8(init.body).unwrap();
    let id = xml
        .split("<UploadId>")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    let target = format!("/archive/key?uploadId={id}");
    error(
        &f.call(
            "POST",
            &target,
            b"<CompleteMultipartUpload/>",
            &[(
                "x-amz-checksum-sha256",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            )],
        )
        .await,
        400,
        "InvalidRequest",
    );
}

#[tokio::test]
async fn multipart_inventory_and_part_copy_use_the_restored_generation() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    assert_eq!(
        f.call("PUT", "/archive/source", b"exact bytes", &[])
            .await
            .status,
        200
    );
    f.control("archive", b"").await;
    let start = f
        .call("POST", "/archive/destination?uploads", b"", &[])
        .await;
    assert_eq!(start.status, 200);
    let start = String::from_utf8(start.body).unwrap();
    let id = start
        .split("<UploadId>")
        .nth(1)
        .unwrap()
        .split('<')
        .next()
        .unwrap();
    let inventory = f.call("GET", "/archive?uploads", b"", &[]).await;
    assert_eq!(inventory.status, 200);
    assert!(String::from_utf8_lossy(&inventory.body).contains("<Key>destination</Key>"));
    let target = format!("/archive/destination?partNumber=1&uploadId={id}");
    error(
        &f.call(
            "PUT",
            &target,
            b"",
            &[("x-amz-copy-source", "archive/source")],
        )
        .await,
        403,
        "InvalidObjectState",
    );
    assert_eq!(
        f.call(
            "POST",
            "/archive/source?restore",
            b"<RestoreRequest><Days>1</Days></RestoreRequest>",
            &[]
        )
        .await
        .status,
        202
    );
    assert_eq!(f.control("restore", b"").await["cold_retrievals"], 1);
    error(
        &f.call(
            "PUT",
            &target,
            b"",
            &[
                ("x-amz-copy-source", "archive/source"),
                ("x-amz-copy-source-range", "bytes=9-99"),
            ],
        )
        .await,
        416,
        "InvalidRange",
    );
    let copied = f
        .call(
            "PUT",
            &target,
            b"",
            &[
                ("x-amz-copy-source", "archive/source"),
                ("x-amz-copy-source-range", "bytes=1-4"),
            ],
        )
        .await;
    assert_eq!(copied.status, 200);
    let copied = String::from_utf8(copied.body).unwrap();
    assert!(copied.contains("<CopyPartResult>"));
    let etag = copied
        .split("<ETag>")
        .nth(1)
        .unwrap()
        .split("</ETag>")
        .next()
        .unwrap();
    let body = format!("<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{etag}</ETag></Part></CompleteMultipartUpload>");
    let complete = f
        .call(
            "POST",
            &format!("/archive/destination?uploadId={id}"),
            body.as_bytes(),
            &[],
        )
        .await;
    assert_eq!(complete.status, 200);
    let head = f.call("HEAD", "/archive/destination", b"", &[]).await;
    assert_eq!(header(&head, "content-length"), Some("4"));
    error(
        &f.call("GET", "/archive/destination", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    let inventory = f.call("GET", "/archive?uploads", b"", &[]).await;
    assert!(!String::from_utf8_lossy(&inventory.body).contains("<Upload>"));
}

#[tokio::test]
async fn atomic_s3_commit_real_post_cold_restore_and_failed_expiry_states() {
    let mut f = Fixture::new();
    f.control("configure", br#"{"host":"localhost:443"}"#).await;
    assert_eq!(f.call("PUT", "/archive", b"", &[]).await.status, 200);
    let c: Vec<_> = (0..2057).map(|n| (n * 7) as u8).collect();
    let put = f
        .call(
            "PUT",
            "/archive/opaque",
            &c,
            &[
                ("content-type", "application/octet-stream"),
                ("x-amz-meta-fixture", "preserved"),
            ],
        )
        .await;
    assert_eq!(put.status, 200);
    let etag = header(&put, "etag").unwrap().to_owned();
    error(
        &f.call("GET", "/archive/opaque", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    let head = f.call("HEAD", "/archive/opaque", b"", &[]).await;
    assert_eq!(head.status, 200);
    assert_eq!(header(&head, "etag"), Some(etag.as_str()));
    assert_eq!(header(&head, "x-amz-restore"), None);
    assert!(head.body.is_empty());
    let cold = f.control("archive", b"").await;
    assert_eq!(cold["retained_bytes"], 0);
    assert_eq!(cold["cold_retrievals"], 0);
    error(
        &f.call("GET", "/archive/opaque", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    let restore = b"<RestoreRequest><Days>1</Days><GlacierJobParameters><Tier>Standard</Tier></GlacierJobParameters></RestoreRequest>";
    assert_eq!(
        f.call("POST", "/archive/opaque?restore", restore, &[])
            .await
            .status,
        202
    );
    error(
        &f.call("POST", "/archive/opaque?restore", restore, &[])
            .await,
        409,
        "RestoreAlreadyInProgress",
    );
    assert_eq!(
        header(
            &f.call("HEAD", "/archive/opaque", b"", &[]).await,
            "x-amz-restore"
        ),
        Some("ongoing-request=\"true\"")
    );
    error(
        &f.call("GET", "/archive/opaque", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    assert_eq!(f.control("restore", b"").await["cold_retrievals"], 1);
    f.control("restart", b"").await;
    let get = f.call("GET", "/archive/opaque", b"", &[]).await;
    assert_eq!(get.status, 200);
    assert_eq!(get.body, c);
    assert_eq!(header(&get, "etag"), Some(etag.as_str()));
    assert_eq!(header(&get, "x-amz-meta-fixture"), Some("preserved"));
    let range = f
        .call(
            "GET",
            "/archive/opaque",
            b"",
            &[("range", "bytes=1020-1030")],
        )
        .await;
    assert_eq!(range.status, 206);
    assert_eq!(range.body, c[1020..=1030]);
    let head = f.call("HEAD", "/archive/opaque", b"", &[]).await;
    assert!(header(&head, "x-amz-restore")
        .unwrap()
        .starts_with("ongoing-request=\"false\""));
    let copied = f
        .call(
            "PUT",
            "/archive/copy",
            b"",
            &[("x-amz-copy-source", "/archive/opaque")],
        )
        .await;
    assert_eq!(
        copied.status,
        200,
        "{}",
        String::from_utf8_lossy(&copied.body)
    );
    let copy_head = f.call("HEAD", "/archive/copy", b"", &[]).await;
    assert_eq!(header(&copy_head, "x-amz-meta-fixture"), Some("preserved"));
    error(
        &f.call("GET", "/archive/copy", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    f.control("expire", b"").await;
    error(
        &f.call("GET", "/archive/opaque", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    f.control("fail", b"").await;
    assert_eq!(
        f.call("POST", "/archive/opaque?restore", restore, &[])
            .await
            .status,
        202
    );
    f.control("restore", b"").await;
    error(
        &f.call("GET", "/archive/opaque", b"", &[]).await,
        403,
        "InvalidObjectState",
    );
    assert_eq!(
        header(
            &f.call("HEAD", "/archive/opaque", b"", &[]).await,
            "x-amz-restore"
        ),
        None
    );
}
