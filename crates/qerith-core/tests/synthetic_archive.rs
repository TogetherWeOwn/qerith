//! Synthetic composition ingredients only: no live provider or eviction proof.
#![cfg(feature = "native-tls")]

mod support;

use support::{
    mock_pair_matches, Archive, Event, Failure, Fault, FixtureC, Key, MemoryCache, MockBackbone,
    Trace,
};

fn fixture(generation: u64) -> FixtureC {
    FixtureC::new(Key {
        object: 1,
        generation,
    })
}

fn identity(label: &'static str, provenance: &'static str) -> MockBackbone {
    MockBackbone { label, provenance }
}

#[tokio::test]
async fn empty_cache_reconstruction_preserves_c_and_replays() {
    let c = fixture(7);
    let expected = vec![
        Event::EmptyCache,
        Event::Begin(c.key),
        Event::Article(0),
        Event::Staged(1024),
        Event::Article(1),
        Event::Staged(2048),
        Event::Article(2),
        Event::Staged(3072),
        Event::Verified(c.key, 3072, c.digest()),
        Event::Published(c.key),
    ];
    for _ in 0..2 {
        let archive = Archive::spawn(&c, identity("label-a", "spool-a"), Fault::Healthy).await;
        let mut cache = MemoryCache::default();
        let mut trace = Trace::default();
        cache.assert_empty(&mut trace);
        archive
            .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
            .await
            .unwrap();
        assert_eq!(cache.delivery(c.key), Some(c.bytes()));
        assert_eq!(cache.staged_len(c.key), 0);
        trace.assert_replay(&expected);
        cache.cleanup(c.key, &mut trace);
        cache.assert_empty(&mut trace);
    }
}

#[tokio::test]
async fn faults_never_publish_partial_bytes_or_use_warm_safety() {
    let c = fixture(7);
    let cases = [
        (Fault::Missing(1), Failure::Missing, 1024),
        (Fault::Lost(1), Failure::Missing, 1024),
        (Fault::Corrupt(1), Failure::Integrity, 1024),
        (Fault::Disconnect(1), Failure::Transport, 1024),
        (Fault::PartialStagedWrite, Failure::PartialWrite, 512),
        (Fault::Unavailable, Failure::Unavailable, 0),
        (Fault::Timeout, Failure::Timeout, 0),
        (Fault::CancelAfter(0), Failure::Cancelled, 1024),
    ];
    for (fault, failure, staged) in cases {
        let archive = Archive::spawn(&c, identity("label-a", "spool-a"), fault).await;
        let mut cache = MemoryCache::default();
        let mut trace = Trace::default();
        cache.assert_empty(&mut trace);
        cache.retain_safety(&c);
        let result = archive.reconstruct(&c, &mut cache, fault, &mut trace).await;
        assert_eq!(result.unwrap_err(), failure, "fault {fault:?}");
        assert_eq!(cache.delivery(c.key), None, "fault {fault:?}");
        assert_eq!(cache.safety(c.key), Some(c.bytes()));
        assert_eq!(cache.staged_len(c.key), staged);
        assert_eq!(trace.0.last(), Some(&Event::Failed(failure)));
        cache.cleanup(c.key, &mut trace);
        cache.assert_empty(&mut trace);
    }
}

#[tokio::test]
async fn restart_discards_partial_write_without_splicing_generations() {
    let c = fixture(7);
    let next = fixture(8);
    let archive = Archive::spawn(&c, identity("label-a", "spool-a"), Fault::Healthy).await;
    let mut cache = MemoryCache::default();
    let mut trace = Trace::default();
    cache.retain_safety(&next);
    assert_eq!(
        archive
            .reconstruct(&c, &mut cache, Fault::CancelAfter(1), &mut trace)
            .await
            .unwrap_err(),
        Failure::Cancelled
    );
    assert_eq!(cache.staged_len(c.key), 2048);
    cache.restart(c.key, &mut trace);
    assert_eq!(cache.staged_len(c.key), 0);
    assert_eq!(
        archive
            .reconstruct(&next, &mut cache, Fault::Healthy, &mut trace)
            .await
            .unwrap_err(),
        Failure::Generation
    );
    archive
        .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
        .await
        .unwrap();
    assert_eq!(cache.delivery(c.key), Some(c.bytes()));
    assert_eq!(cache.delivery(next.key), None);
    cache.cleanup(c.key, &mut trace);
    assert_eq!(cache.safety(next.key), Some(next.bytes()));
    cache.cleanup(next.key, &mut trace);
    cache.assert_empty(&mut trace);
}

#[test]
fn publication_checks_full_length_digest_and_preserves_prior_delivery() {
    let c = fixture(7);
    let mut cache = MemoryCache::default();
    let mut trace = Trace::default();
    cache.begin(c.key, &mut trace);
    cache.append(c.key, &c.bytes()[..1024], &mut trace);
    assert_eq!(cache.publish(&c, &mut trace), Err(Failure::Integrity));
    assert_eq!(cache.delivery(c.key), None);
    cache.begin(c.key, &mut trace);
    cache.append(c.key, c.bytes(), &mut trace);
    cache.publish(&c, &mut trace).unwrap();
    let mut corrupt = c.bytes().to_vec();
    corrupt[2000] ^= 1;
    cache.begin(c.key, &mut trace);
    cache.append(c.key, &corrupt, &mut trace);
    assert_eq!(cache.publish(&c, &mut trace), Err(Failure::Integrity));
    assert_eq!(cache.delivery(c.key), Some(c.bytes()));
    cache.begin(c.key, &mut trace);
    cache.append(c.key, c.bytes(), &mut trace);
    cache.append(c.key, &[0], &mut trace);
    assert_eq!(cache.publish(&c, &mut trace), Err(Failure::Integrity));
}

#[test]
#[should_panic(expected = "safety cache is not empty")]
fn cold_precondition_refuses_retained_safety() {
    let mut cache = MemoryCache::default();
    cache.retain_safety(&fixture(7));
    cache.assert_empty(&mut Trace::default());
}

#[tokio::test]
async fn mock_full_reconstructions_require_distinct_provenance_and_generation() {
    let c = fixture(7);
    let next = fixture(8);
    let a = Archive::spawn(&c, identity("reseller-a", "spool-a"), Fault::Healthy).await;
    let b = Archive::spawn(&c, identity("reseller-b", "spool-b"), Fault::Healthy).await;
    let alias = Archive::spawn(&c, identity("other-label", "spool-a"), Fault::Healthy).await;
    let other = Archive::spawn(&next, identity("reseller-b", "spool-b"), Fault::Healthy).await;
    let mut trace = Trace::default();
    let mut cache = MemoryCache::default();
    cache.assert_empty(&mut trace);
    let proof_a = a
        .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
        .await
        .unwrap();
    cache.cleanup(c.key, &mut trace);
    cache.assert_empty(&mut trace);
    let proof_b = b
        .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
        .await
        .unwrap();
    let alias_proof = alias
        .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
        .await
        .unwrap();
    let other_proof = other
        .reconstruct(&next, &mut cache, Fault::Healthy, &mut trace)
        .await
        .unwrap();
    assert!(mock_pair_matches(&c, &proof_a, &proof_b));
    assert!(!mock_pair_matches(&c, &proof_a, &alias_proof));
    assert!(!mock_pair_matches(&c, &proof_a, &other_proof));
    assert!(!mock_pair_matches(&c, &proof_a, &proof_a));
}

#[tokio::test]
async fn explicit_repost_repairs_loss_only_with_an_intact_retained_source() {
    let c = fixture(7);
    for fault in [Fault::Lost(1), Fault::Missing(1)] {
        let archive = Archive::spawn(&c, identity("label-a", "spool-a"), fault).await;
        let mut cache = MemoryCache::default();
        let mut trace = Trace::default();
        cache.retain_safety(&c);
        assert_eq!(
            archive
                .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
                .await
                .unwrap_err(),
            Failure::Missing
        );
        assert_eq!(
            archive
                .repost_from_retained(1, &c.bytes()[..1024], &mut trace)
                .await,
            Err(Failure::Integrity)
        );
        archive
            .repost_from_retained(1, cache.safety(c.key).unwrap(), &mut trace)
            .await
            .unwrap();
        cache.restart(c.key, &mut trace);
        archive
            .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
            .await
            .unwrap();
        assert_eq!(cache.delivery(c.key), Some(c.bytes()));
        assert!(trace.0.contains(&Event::RepairPosted(1)));
        assert!(
            matches!(archive.repair_without_retained_source(), Err(Failure::NotQualified(owner)) if owner.contains("velmora"))
        );
    }
}

#[tokio::test]
async fn teardown_only_removes_owned_allocations_and_archive() {
    let c = fixture(7);
    let unrelated = fixture(9);
    let mut archive = Archive::spawn(&c, identity("label-a", "spool-a"), Fault::Healthy).await;
    let mut cache = MemoryCache::default();
    let mut trace = Trace::default();
    cache.retain_safety(&c);
    cache.retain_safety(&unrelated);
    cache.cleanup(c.key, &mut trace);
    assert_eq!(cache.safety(c.key), None);
    assert_eq!(cache.safety(unrelated.key), Some(unrelated.bytes()));
    use tokio::io::{AsyncBufReadExt, BufReader};
    let socket = tokio::net::TcpStream::connect(archive.addr())
        .await
        .unwrap();
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reader.read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(line.starts_with("200"));
    archive.shutdown();
    line.clear();
    assert_eq!(
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            reader.read_line(&mut line)
        )
        .await
        .unwrap()
        .unwrap(),
        0
    );
    assert_eq!(
        archive
            .reconstruct(&c, &mut cache, Fault::Healthy, &mut trace)
            .await
            .unwrap_err(),
        Failure::Unavailable
    );
    cache.cleanup(unrelated.key, &mut trace);
    cache.assert_empty(&mut trace);
}
