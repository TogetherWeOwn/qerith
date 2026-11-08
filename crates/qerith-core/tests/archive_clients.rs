#![cfg(feature = "native-tls")]
#![allow(dead_code)]

#[path = "archive_clients/http.rs"]
mod http;
#[path = "archive_clients/lifecycle.rs"]
mod lifecycle;
#[path = "archive_clients/router.rs"]
mod router;
#[path = "archive_clients/storage.rs"]
mod storage;
mod support;

use std::time::Duration;

/// Deduplicated process groups still live in the runner's dedicated session. The
/// Python runner becomes a session leader (sid == runner pid); its out-of-session
/// supervisor escalates TERM/KILL over that session on runner death, so an empty
/// result proves no worker or CLI group survived teardown. Linux-only: Actions is
/// ubuntu-24.04; on other platforms the supervisor still bounds teardown and this
/// returns empty so the fixture stays compilable.
#[cfg(target_os = "linux")]
fn session_survivors(session_id: u32) -> Vec<u32> {
    let mut survivors = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return survivors;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        // proc(5): comm may contain spaces/parens, so fields after the final
        // ')' are state(3), ppid(4), pgrp(5), session(6).
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            continue;
        };
        let mut fields = rest.split_whitespace();
        // A zombie holds its session id but is already dead; it is drained by
        // its reaper, not by killpg, so it must not report as a survivor.
        if fields.next() == Some("Z") {
            continue;
        }
        fields.next(); // ppid
        let group = fields.next().and_then(|f| f.parse::<u32>().ok());
        let session = fields.next().and_then(|f| f.parse::<u32>().ok());
        if session == Some(session_id) {
            if let Some(group) = group.filter(|group| *group > 1) {
                survivors.push(group);
            }
        }
    }
    survivors.sort_unstable();
    survivors.dedup();
    survivors
}

#[cfg(not(target_os = "linux"))]
fn session_survivors(_session_id: u32) -> Vec<u32> {
    Vec::new()
}

/// Bounded synchronous wait for the out-of-session supervisor to drain the
/// runner's session. Covers runner exit from panic, cancel, timeout and success.
fn drain_session(session_id: u32) -> Vec<u32> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let survivors = session_survivors(session_id);
        if survivors.is_empty() || std::time::Instant::now() >= deadline {
            return survivors;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Last-resort group SIGKILL through the system `kill` builtin. The supervisor
/// is the real containment path; this only trims evidence of a supervisor bug.
#[cfg(target_os = "linux")]
fn kill_group(pgid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-KILL", "--", &format!("-{pgid}")])
        .status();
}

#[cfg(not(target_os = "linux"))]
fn kill_group(_pgid: u32) {}

/// Owns the runner child on every exit path, including panics. kill_on_drop can
/// only reach the direct child with SIGKILL, which bypasses the runner's own
/// finally; the surviving supervisor is what then reaps the runner's session.
/// This guard also waits briefly for that drain and hard-kills leftovers so a
/// regression can never leak a worker group past private cleanup.
struct RunnerGuard {
    child: tokio::process::Child,
    session_id: u32,
}

impl RunnerGuard {
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}

impl Drop for RunnerGuard {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        // Reap the runner itself before enumerating the session: kill_on_drop
        // only signals, so a slow death would otherwise leave a zombie leader
        // counting as a session member until some later wait reaps it.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        let survivors = drain_session(self.session_id);
        if !survivors.is_empty() {
            eprintln!("runner session survivor after supervisor drain");
            for group in survivors {
                kill_group(group);
            }
            if !drain_session(self.session_id).is_empty() {
                eprintln!("runner session still has live groups after fallback teardown");
            }
        }
    }
}

/// Exercise the Rust guard without a supervisor: the worker leader is reaped
/// before the guard drops, leaving a descendant whose PID is not its PGID.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "current_thread")]
async fn fallback_drains_descendant_after_worker_group_leader_exits() {
    use tokio::io::{AsyncBufReadExt, BufReader};

    struct GroupCleanup(u32);
    impl Drop for GroupCleanup {
        fn drop(&mut self) {
            kill_group(self.0);
        }
    }

    let script = r#"
import os, subprocess, sys, time
os.setsid()
worker = subprocess.Popen(
    [sys.executable, '-I', '-c',
     "import subprocess, sys; "
     "child = subprocess.Popen([sys.executable, '-I', '-c', "
     "'import time; time.sleep(60)'], stdout=subprocess.DEVNULL); "
     "print(child.pid, flush=True)"],
    process_group=0, stdout=subprocess.PIPE, text=True)
descendant = worker.stdout.readline().strip()
assert worker.wait(timeout=5) == 0
print(worker.pid, descendant, flush=True)
time.sleep(60)
"#;
    let child = tokio::process::Command::new("python3")
        .args(["-I", "-c", script])
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let session_id = child.id().unwrap();
    let mut guard = RunnerGuard { child, session_id };
    let mut output = BufReader::new(guard.child.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    let ids: Vec<u32> = line
        .split_whitespace()
        .map(|value| value.parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 2);
    let _cleanup = GroupCleanup(ids[0]);
    assert_ne!(ids[0], ids[1], "descendant must not lead the worker group");
    assert!(!std::path::Path::new(&format!("/proc/{}", ids[0])).exists());
    assert!(std::path::Path::new(&format!("/proc/{}", ids[1])).exists());

    // No heartbeat supervisor exists in this case. Drop must use and verify the
    // fallback itself, rather than letting normal supervision mask a bad target.
    drop(guard);
    assert!(
        session_survivors(session_id).is_empty(),
        "fallback left a live descendant after guard destruction"
    );
}

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
    std::fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut random)
        .unwrap();
    let control: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let token = format!("fixture-control-{control}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let spawned = tokio::process::Command::new("python3")
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
    // The runner leads its own session, so its pid is also the supervisor's
    // enumeration target for every worker/CLI process group it spawns.
    let session_id = spawned.id().expect("runner pid");
    let mut child = RunnerGuard {
        child: spawned,
        session_id,
    };
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
    // Drop of the guard, listener and state (including all NNTP servers) handles
    // error/cancel unwinding too. Actions adds an outer job lifetime ceiling.
    state.save_trace();
    let status = outcome.expect("absolute fixture lifetime exceeded");
    assert!(status.success(), "client runner failed: {status}");
    let survivors = drain_session(session_id);
    assert!(
        survivors.is_empty(),
        "runner session still has members after supervised teardown"
    );
}
