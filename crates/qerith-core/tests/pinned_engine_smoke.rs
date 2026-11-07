//! Consumer-boundary smoke test for the pinned velmora engine.
//!
//! Cargo never runs a dependency's tests, so the engine suites only gate
//! velmora's own CI. These tests keep a representative assertion for each
//! non-crypto engine area Qerith builds on in this repository's required
//! gate: NZB parse, NNTP fetch against the synthetic `velmora-test-nntp`
//! server, and a yEnc round trip. A pin bump that regresses any of them
//! fails here, not only in velmora.
//!
//! Deliberately absent: `velmora::decrypt` (rclone-crypt), which Qerith does
//! not build on.

#![cfg(feature = "native-tls")]

use std::time::Duration;

use qerith_core::nntp::{NntpClient, NntpConfig};
use qerith_core::transports::{connect_native, NativeTlsTransport};
use qerith_core::{nzb, yenc, Error};
use velmora_test_nntp::{default_corpus, generate_wav_bytes, nzb_for_multipart, TestNntpServer};

const GROUP: &str = "alt.binaries.nntune.test";

async fn connect(server: &TestNntpServer) -> NntpClient<NativeTlsTransport> {
    let config = NntpConfig {
        host: "127.0.0.1".into(),
        port: server.addr().port(),
        tls: false,
        username: Some("testuser".into()),
        password: Some("testpass".into()),
        timeout: Duration::from_secs(5),
        max_pipelined: 4,
        ..NntpConfig::default()
    };
    let transport = connect_native(&config)
        .await
        .expect("connect to fixture server");
    NntpClient::connect(transport, &config)
        .await
        .expect("NNTP handshake")
}

/// NZB parse -> NNTP fetch of every segment -> yEnc decode at the decoded
/// offset reassembles the reference file byte for byte.
#[tokio::test]
async fn nzb_driven_fetch_reassembles_multipart_file() {
    let corpus = default_corpus();
    let parts: Vec<_> = (1..=3)
        .map(|n| {
            let id = format!("<multi-660-part{n}-of-3@nntune.test>");
            corpus
                .iter()
                .find(|a| a.message_id == id)
                .expect("multipart fixture article")
        })
        .collect();
    let expected = generate_wav_bytes(660.0, 210, 8000);

    let doc = nzb::parse(nzb_for_multipart(&parts, GROUP).as_bytes()).expect("NZB parses");
    assert_eq!(doc.files.len(), 1, "one logical file");
    let file = &doc.files[0];
    assert_eq!(file.filename.as_deref(), Some("sine-660.wav"));
    assert_eq!(file.segments.len(), 3);
    for (segment, article) in file.segments.iter().zip(&parts) {
        assert_eq!(
            format!("<{}>", segment.message_id),
            article.message_id,
            "segment {} identity",
            segment.number
        );
    }

    let server = TestNntpServer::spawn_for_test().await;
    let mut client = connect(&server).await;
    let mut file_bytes = vec![0; expected.len()];
    let mut placed = 0;
    for segment in &file.segments {
        let mut article = Vec::new();
        client
            .article_to(&segment.message_id, &mut article)
            .await
            .expect("fetch segment");
        let mut part = vec![0; expected.len()];
        let decoded = yenc::decode_part_to(&segment.message_id, &article, &mut part)
            .expect("yEnc part decodes");
        assert!(decoded.multipart);
        assert_eq!(decoded.file_size, expected.len() as u64);
        let start = decoded.offset as usize;
        file_bytes[start..start + decoded.written].copy_from_slice(&part[..decoded.written]);
        placed += decoded.written;
    }
    client.quit().await;

    assert_eq!(placed, expected.len(), "segments cover the file");
    assert_eq!(file_bytes, expected);
}

/// The fixture server answers `430` for an unknown article and the client
/// surfaces that as `ArticleNotFound` rather than an empty body.
#[tokio::test]
async fn missing_article_is_not_found() {
    let server = TestNntpServer::spawn_for_test().await;
    let mut client = connect(&server).await;
    let mut article = Vec::new();
    let err = client
        .article_to("no-such-article@qerith.test", &mut article)
        .await
        .expect_err("unknown article must not fetch");
    assert!(
        matches!(err, Error::ArticleNotFound(_)),
        "unexpected error: {err:?}"
    );
    client.quit().await;
}

/// Engine encode -> engine decode round trip, single-part and multipart,
/// over every byte value (so every yEnc escape is exercised).
#[test]
fn yenc_round_trip() {
    let data: Vec<u8> = (0..4096u32).map(|i| (i * 7 + i / 256) as u8).collect();

    let mut article = Vec::new();
    yenc::encode_segment(
        &mut article,
        &yenc::SegmentParams::single("blob.bin"),
        &data,
    )
    .expect("single-part encode");
    let mut dst = vec![0; data.len()];
    let written = yenc::decode_to("single", &article, &mut dst).expect("single-part decode");
    assert_eq!(&dst[..written], &data[..]);

    let split = 1500;
    let mut joined = vec![0; data.len()];
    for (n, (begin, chunk)) in [(0, &data[..split]), (split, &data[split..])]
        .into_iter()
        .enumerate()
    {
        let params = yenc::SegmentParams {
            name: "blob.bin".into(),
            part: n as u32 + 1,
            total: 2,
            begin: begin as u64 + 1,
            end: (begin + chunk.len()) as u64,
            file_size: data.len() as u64,
        };
        let mut article = Vec::new();
        yenc::encode_segment(&mut article, &params, chunk).expect("multipart encode");
        let mut part = vec![0; chunk.len()];
        let decoded = yenc::decode_part_to("multi", &article, &mut part).expect("multipart decode");
        assert_eq!(decoded.offset, begin as u64);
        assert_eq!(decoded.written, chunk.len());
        joined[begin..begin + chunk.len()].copy_from_slice(&part);
    }
    assert_eq!(joined, data);
}
