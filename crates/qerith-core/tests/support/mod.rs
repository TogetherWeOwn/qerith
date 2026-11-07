//! Test-only adapters, not a catalogue, scheduler, durability or eviction authority.
//! Include with `mod support` from downstream integration tests. All identities
//! here are fixture-local; mock provenance never proves real independence.

use std::collections::BTreeMap;
use std::time::Duration;

use qerith_core::nntp::{NntpClient, NntpConfig};
use qerith_core::transports::{connect_native, NativeTlsTransport};
use qerith_core::yenc;
use sha2::{Digest, Sha256};
use velmora_test_nntp::{Article, ServerConfig, TestNntpServer};

const GROUP: &str = "alt.binaries.qerith.test";
const PART_SIZE: usize = 1024;

/// Opaque fixture coordinates only, to be replaced by catalogue types at integration.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Key {
    pub object: u64,
    pub generation: u64,
}

#[derive(Clone, Debug)]
pub struct FixtureC {
    pub key: Key,
    bytes: Vec<u8>,
    digest: [u8; 32],
}

impl FixtureC {
    /// Arbitrary opaque bytes stand in for committed ciphertext C. This is not
    /// encryption, an approved encrypted format, or proof about plaintext.
    pub fn new(key: Key) -> Self {
        let bytes: Vec<_> = (0..3072u32).map(|i| (i * 7 + i / 256) as u8).collect();
        let digest = Sha256::digest(&bytes).into();
        Self { key, bytes, digest }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }

    fn verify(&self, key: Key, bytes: &[u8]) -> Result<(), Failure> {
        if key != self.key {
            return Err(Failure::Generation);
        }
        let digest: [u8; 32] = Sha256::digest(bytes).into();
        if bytes.len() != self.bytes.len() || digest != self.digest || bytes != self.bytes {
            return Err(Failure::Integrity);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    Generation,
    Integrity,
    Missing,
    Transport,
    Unavailable,
    Timeout,
    Cancelled,
    PartialWrite,
    NotQualified(&'static str),
}

/// Replayable assertions omit sockets, wall clocks and credentials.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    EmptyCache,
    Begin(Key),
    Article(usize),
    Staged(usize),
    Verified(Key, usize, [u8; 32]),
    Published(Key),
    Failed(Failure),
    Restart(Key),
    RepairPosted(usize),
    Cleaned(Key),
}

#[derive(Default, Debug, PartialEq, Eq)]
pub struct Trace(pub Vec<Event>);

impl Trace {
    pub fn assert_replay(&self, expected: &[Event]) {
        assert_eq!(self.0, expected, "fixture trace diverged");
    }
}

/// Portable reference semantics: staged writes are invisible, safety bytes do
/// not grant delivery, and only whole-generation verified bytes are published.
/// No filesystem paths, external allocation, hidden warm lookup or persistence.
#[derive(Default)]
pub struct MemoryCache {
    staged: BTreeMap<Key, Vec<u8>>,
    safety: BTreeMap<Key, Vec<u8>>,
    delivery: BTreeMap<Key, Vec<u8>>,
}

impl MemoryCache {
    pub fn assert_empty(&self, trace: &mut Trace) {
        assert!(self.staged.is_empty(), "staged cache is not empty");
        assert!(self.safety.is_empty(), "safety cache is not empty");
        assert!(self.delivery.is_empty(), "delivery cache is not empty");
        trace.0.push(Event::EmptyCache);
    }

    pub fn retain_safety(&mut self, fixture: &FixtureC) {
        self.safety.insert(fixture.key, fixture.bytes.clone());
    }

    pub fn safety(&self, key: Key) -> Option<&[u8]> {
        self.safety.get(&key).map(Vec::as_slice)
    }

    pub fn delivery(&self, key: Key) -> Option<&[u8]> {
        self.delivery.get(&key).map(Vec::as_slice)
    }

    pub fn staged_len(&self, key: Key) -> usize {
        self.staged.get(&key).map_or(0, Vec::len)
    }

    pub fn begin(&mut self, key: Key, trace: &mut Trace) {
        self.staged.insert(key, Vec::new());
        trace.0.push(Event::Begin(key));
    }

    pub fn append(&mut self, key: Key, bytes: &[u8], trace: &mut Trace) {
        self.staged
            .get_mut(&key)
            .expect("begin staged allocation first")
            .extend_from_slice(bytes);
        trace.0.push(Event::Staged(self.staged_len(key)));
    }

    pub fn publish(&mut self, fixture: &FixtureC, trace: &mut Trace) -> Result<(), Failure> {
        let bytes = self.staged.get(&fixture.key).ok_or(Failure::Integrity)?;
        fixture.verify(fixture.key, bytes)?;
        trace
            .0
            .push(Event::Verified(fixture.key, bytes.len(), fixture.digest));
        let bytes = self
            .staged
            .remove(&fixture.key)
            .expect("verified allocation");
        self.delivery.insert(fixture.key, bytes);
        trace.0.push(Event::Published(fixture.key));
        Ok(())
    }

    /// Restart discards only this fixture's incomplete allocation. It does not
    /// inherit a previous attempt's partial prefix or touch other generations.
    pub fn restart(&mut self, key: Key, trace: &mut Trace) {
        self.staged.remove(&key);
        trace.0.push(Event::Restart(key));
    }

    pub fn cleanup(&mut self, key: Key, trace: &mut Trace) {
        self.staged.remove(&key);
        self.safety.remove(&key);
        self.delivery.remove(&key);
        trace.0.push(Event::Cleaned(key));
    }
}

/// Distinct labels alone never imply distinct provenance, even in a mock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MockBackbone {
    pub label: &'static str,
    pub provenance: &'static str,
}

/// Constructed only after full ARTICLE retrieval and generation/digest checking.
#[derive(Clone, Debug)]
pub struct Reconstruction {
    identity: MockBackbone,
    key: Key,
    length: usize,
    digest: [u8; 32],
}

pub fn mock_pair_matches(fixture: &FixtureC, a: &Reconstruction, b: &Reconstruction) -> bool {
    !a.identity.provenance.is_empty()
        && !b.identity.provenance.is_empty()
        && a.identity.provenance != b.identity.provenance
        && [a, b].iter().all(|proof| {
            proof.key == fixture.key
                && proof.length == fixture.bytes.len()
                && proof.digest == fixture.digest
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Healthy,
    Missing(usize),
    Lost(usize),
    Corrupt(usize),
    Disconnect(usize),
    PartialStagedWrite,
    Unavailable,
    Timeout,
    CancelAfter(usize),
}

pub struct Archive {
    fixture: FixtureC,
    identity: MockBackbone,
    articles: Vec<Article>,
    server: Option<TestNntpServer>,
}

impl Archive {
    pub async fn spawn(fixture: &FixtureC, identity: MockBackbone, fault: Fault) -> Self {
        let articles = articles(fixture);
        let mut config = ServerConfig::for_test();
        config.group = GROUP.into();
        config.articles = articles.clone();
        config.missing_ids.clear();
        match fault {
            Fault::Missing(n) => {
                config.articles.remove(n);
            }
            Fault::Lost(n) => {
                config.missing_ids.insert(articles[n].message_id.clone());
            }
            Fault::Corrupt(n) => {
                // Keep the original yEnc checksum but change an encoded byte.
                let raw = &mut config.articles[n].raw;
                let pos = raw
                    .windows(7)
                    .position(|w| w == b"=ypart ")
                    .expect("multipart header");
                let body = pos + raw[pos..].windows(2).position(|w| w == b"\r\n").unwrap() + 2;
                raw[body] = if raw[body] == b'A' { b'B' } else { b'A' };
            }
            Fault::Disconnect(n) => {
                config
                    .drop_after_bytes
                    .insert(articles[n].message_id.clone(), 32);
            }
            Fault::Timeout => config.latency_ms = 60_000,
            _ => {}
        }
        let server = if fault == Fault::Unavailable {
            None
        } else {
            Some(TestNntpServer::spawn(config).await)
        };
        Self {
            fixture: fixture.clone(),
            identity,
            articles,
            server,
        }
    }

    async fn connect(&self) -> Result<NntpClient<NativeTlsTransport>, Failure> {
        let server = self.server.as_ref().ok_or(Failure::Unavailable)?;
        let config = NntpConfig {
            host: "127.0.0.1".into(),
            port: server.addr().port(),
            tls: false,
            username: Some("testuser".into()),
            password: Some("testpass".into()),
            timeout: Duration::from_secs(2),
            ..NntpConfig::default()
        };
        let transport = connect_native(&config)
            .await
            .map_err(|_| Failure::Transport)?;
        NntpClient::connect(transport, &config)
            .await
            .map_err(|_| Failure::Transport)
    }

    /// No safety/delivery read occurs here: every byte comes from ARTICLE.
    /// A failed/cancelled/timed-out attempt leaves no newly published delivery.
    pub async fn reconstruct(
        &self,
        expected: &FixtureC,
        cache: &mut MemoryCache,
        fault: Fault,
        trace: &mut Trace,
    ) -> Result<Reconstruction, Failure> {
        let deadline = if fault == Fault::Timeout {
            Duration::from_millis(50)
        } else {
            Duration::from_secs(10)
        };
        let result = tokio::time::timeout(deadline, self.fetch(expected, cache, fault, trace))
            .await
            .unwrap_or(Err(Failure::Timeout));
        if let Err(err) = &result {
            trace.0.push(Event::Failed(err.clone()));
        }
        result
    }

    async fn fetch(
        &self,
        expected: &FixtureC,
        cache: &mut MemoryCache,
        fault: Fault,
        trace: &mut Trace,
    ) -> Result<Reconstruction, Failure> {
        if expected.key != self.fixture.key {
            return Err(Failure::Generation);
        }
        let mut client = self.connect().await?;
        cache.begin(expected.key, trace);
        for (n, article) in self.articles.iter().enumerate() {
            trace.0.push(Event::Article(n));
            let mut raw = Vec::new();
            client
                .article_to(engine_id(article), &mut raw)
                .await
                .map_err(|err| {
                    if matches!(err, qerith_core::Error::ArticleNotFound(_)) {
                        Failure::Missing
                    } else {
                        Failure::Transport
                    }
                })?;
            let mut part = vec![0; PART_SIZE];
            let decoded = yenc::decode_part_to(&article.message_id, &raw, &mut part)
                .map_err(|_| Failure::Integrity)?;
            if !decoded.multipart
                || decoded.file_size != expected.bytes.len() as u64
                || decoded.offset != cache.staged_len(expected.key) as u64
            {
                return Err(Failure::Integrity);
            }
            if fault == Fault::PartialStagedWrite {
                cache.append(expected.key, &part[..decoded.written / 2], trace);
                return Err(Failure::PartialWrite);
            }
            cache.append(expected.key, &part[..decoded.written], trace);
            if fault == Fault::CancelAfter(n) {
                return Err(Failure::Cancelled);
            }
        }
        client.quit().await;
        cache.publish(expected, trace)?;
        Ok(Reconstruction {
            identity: self.identity.clone(),
            key: expected.key,
            length: expected.bytes.len(),
            digest: expected.digest,
        })
    }

    /// Existing mechanism: explicit re-POST of a missing/hidden article from
    /// an intact retained source. Never claims PAR2 reconstruction or cold repair.
    pub async fn repost_from_retained(
        &self,
        n: usize,
        source: &[u8],
        trace: &mut Trace,
    ) -> Result<(), Failure> {
        self.fixture.verify(self.fixture.key, source)?;
        let article = self.articles.get(n).ok_or(Failure::Missing)?;
        let mut client = self.connect().await?;
        client
            .post_article(engine_id(article), &article.raw)
            .await
            .map_err(|_| Failure::Transport)?;
        client.quit().await;
        trace.0.push(Event::RepairPosted(n));
        Ok(())
    }

    pub fn repair_without_retained_source(&self) -> Result<(), Failure> {
        Err(Failure::NotQualified(
            "velmora owns PAR2 repair; qerith's pinned public surface has no portable archive repair adapter",
        ))
    }

    /// Dropping the owned server closes its listener and sessions through the
    /// upstream shutdown signal. No process, daemon, disk allocation or timer survives.
    pub fn shutdown(&mut self) {
        self.server.take();
    }

    pub fn addr(&self) -> std::net::SocketAddr {
        self.server.as_ref().expect("running fixture").addr()
    }
}

// The server corpus stores bracketed IDs; the engine client accepts bare IDs
// and supplies the wire brackets itself. Only adapt our generated corpus IDs.
fn engine_id(article: &Article) -> &str {
    article
        .message_id
        .strip_prefix('<')
        .and_then(|id| id.strip_suffix('>'))
        .expect("bracketed fixture corpus ID")
}

fn articles(fixture: &FixtureC) -> Vec<Article> {
    fixture.bytes.chunks(PART_SIZE).enumerate().map(|(n, bytes)| {
        let message_id = format!("<fixture-{}-{}-{n}@qerith.invalid>", fixture.key.object, fixture.key.generation);
        let mut raw = format!("Message-ID: {message_id}\r\nNewsgroups: {GROUP}\r\nSubject: opaque-C\r\nFrom: fixture\r\nDate: Thu, 01 Jan 1970 00:00:00 +0000\r\n\r\n").into_bytes();
        yenc::encode_segment(&mut raw, &yenc::SegmentParams {
            name: "opaque-C.bin".into(),
            part: n as u32 + 1,
            total: 3,
            begin: (n * PART_SIZE + 1) as u64,
            end: (n * PART_SIZE + bytes.len()) as u64,
            file_size: fixture.bytes.len() as u64,
        }, bytes).expect("encode synthetic article");
        Article {
            message_id, number: n as u32 + 1, group: GROUP.into(), subject: "opaque-C".into(),
            from: "fixture".into(), date: "Thu, 01 Jan 1970 00:00:00 +0000".into(), raw, payload: bytes.to_vec(),
        }
    }).collect()
}
