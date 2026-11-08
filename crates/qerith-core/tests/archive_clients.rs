#![cfg(feature = "native-tls")]
#![allow(dead_code)]

#[path = "archive_clients/http.rs"]
mod http;
#[path = "archive_clients/router.rs"]
mod router;
#[path = "archive_clients/storage.rs"]
mod storage;
mod support;

use std::time::Duration;

/// Actions-only network client qualification. The ordinary suite compiles this
/// target but cannot accidentally start a service or use an installed host client.
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires the pinned Actions client environment"]
async fn pinned_archive_clients() {
    let runner = std::env::var("QERITH_CLIENT_RUNNER").expect("Actions client runner path");
    let mut random = [0u8; 32];
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let secret: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let token = format!("fixture-control-{secret}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let mut child = tokio::process::Command::new("python3")
        .arg("-I")
        .arg(runner)
        .args(["--upstream", &upstream, "--control-token", &token])
        .env("AWS_ACCESS_KEY_ID", "fixture")
        .env("AWS_SECRET_ACCESS_KEY", &secret)
        .env_remove("AWS_SESSION_TOKEN")
        .env("AWS_EC2_METADATA_DISABLED", "true")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut state = router::State::new(secret);
    let service = async {
        // Sequential request processing is a fixture limitation, not concurrency
        // qualification. All catalogue/worker state has one mutable owner.
        for _ in 0..4096 {
            let (mut stream, peer) = listener.accept().await.unwrap();
            assert!(peer.ip().is_loopback());
            let result = tokio::time::timeout(Duration::from_secs(60), async {
                let request = http::read(&mut stream).await?;
                let head = request.method == "HEAD";
                let response = state.handle(request, &token).await;
                http::write(&mut stream, response, head).await
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                eprintln!("synthetic fixture request failed or exceeded its deadline");
            }
        }
        panic!("synthetic fixture request ceiling exceeded");
    };
    let outcome = tokio::time::timeout(Duration::from_secs(900), async {
        tokio::select! {
            status = child.wait() => status.unwrap(),
            () = service => unreachable!(),
        }
    })
    .await;
    // Drop of the child, listener and state (including all NNTP servers) handles
    // error/cancel unwinding too. Actions adds an outer job lifetime ceiling.
    state.save_trace();
    let status = outcome.expect("absolute fixture lifetime exceeded");
    assert!(status.success(), "client runner failed: {status}");
}
