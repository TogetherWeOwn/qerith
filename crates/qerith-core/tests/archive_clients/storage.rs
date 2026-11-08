//! Test-only composition I/O over the existing pinned synthetic NNTP adapter.
use std::collections::BTreeMap;

use qerith_core::{catalogue::*, composition::*, s3};
use sha2::{Digest, Sha256};

use crate::support::{Archive, Fault, FixtureC, MemoryCache, MockBackbone, Trace};

pub struct Spool {
    pub fixture: FixtureC,
    archives: [Archive; 2],
}

#[derive(Default)]
pub struct Io {
    pub spools: BTreeMap<GenerationId, Spool>,
    pub delivery: BTreeMap<String, Vec<u8>>,
    pending: BTreeMap<JobId, Vec<u8>>,
    completed: BTreeMap<JobId, String>,
    pub trace: Trace,
    pub fail: bool,
    pub cold_retrievals: usize,
}

impl Io {
    pub async fn register(&mut self, generation: GenerationId, bytes: Vec<u8>) {
        if self.spools.contains_key(&generation) {
            return;
        }
        let fixture = FixtureC::committed(
            crate::support::Key {
                object: 1,
                generation: generation.0,
            },
            bytes,
        );
        // Empty spools make successful engine POST a prerequisite of full
        // ARTICLE verification, rather than pre-seeding a warm archive oracle.
        let a = Archive::unposted(
            &fixture,
            MockBackbone {
                label: "simulated-a",
                provenance: "synthetic-spool-a",
            },
        )
        .await;
        let b = Archive::unposted(
            &fixture,
            MockBackbone {
                label: "simulated-b",
                provenance: "synthetic-spool-b",
            },
        )
        .await;
        self.spools.insert(
            generation,
            Spool {
                fixture,
                archives: [a, b],
            },
        );
    }

    fn check(&self, work: &Work) -> std::result::Result<(), IoError> {
        let fixture = &self
            .spools
            .get(&work.job.generation)
            .ok_or(IoError::Integrity)?
            .fixture;
        if work.metadata.identity.length != fixture.bytes().len() as u64
            || work.metadata.identity.sha256 != fixture.digest()
            || work.metadata.identity.length > work.budget.max_bytes()
            || fixture.parts() > work.budget.max_units() as usize
        {
            return Err(IoError::Integrity);
        }
        Ok(())
    }

    fn receipt(&self, work: &Work, location: String) -> CompleteCopy {
        CompleteCopy {
            identity: work.metadata.identity.clone(),
            checksums: work.metadata.checksums.clone(),
            receipt: "synthetic-whole-C-verified-not-crypto-readability".into(),
            location,
        }
    }

    pub fn assert_empty(&self) {
        assert!(self.delivery.is_empty());
        assert!(self.pending.is_empty());
        assert!(self.completed.is_empty());
        // Spool fixtures are archive input/assertion oracles, never a cache read.
    }
}

impl Storage for Io {
    async fn stage_upload(
        &mut self,
        _: &Upload,
        _: &Budget,
        _: u64,
    ) -> std::result::Result<CompleteCopy, IoError> {
        // S3 uses MemoryMutations' already-atomic retained commit, not ingest twice.
        Err(IoError::Integrity)
    }

    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.check(work)?;
        let spool = self
            .spools
            .get(&work.job.generation)
            .ok_or(IoError::Integrity)?;
        for archive in &spool.archives {
            for n in 0..spool.fixture.parts() {
                archive
                    .repost_from_retained(n, spool.fixture.bytes(), &mut self.trace)
                    .await
                    .map_err(|_| IoError::Retryable)?;
            }
        }
        Ok(())
    }

    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        self.check(work)?;
        let spool = self
            .spools
            .get_mut(&work.job.generation)
            .ok_or(IoError::Integrity)?;
        for archive in &mut spool.archives {
            let mut scratch = MemoryCache::default();
            archive
                .reconstruct(
                    &spool.fixture,
                    &mut scratch,
                    Fault::Healthy,
                    &mut self.trace,
                )
                .await
                .map_err(|_| IoError::Integrity)?;
            scratch.cleanup(spool.fixture.key(), &mut self.trace);
            scratch.assert_empty(&mut self.trace);
        }
        Ok(std::array::from_fn(|n| Reconstruction {
            backbone: BackboneId(n as u64 + 1),
            identity: work.metadata.identity.clone(),
        }))
    }

    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.check(work)?;
        if std::mem::take(&mut self.fail) {
            return Err(IoError::Integrity);
        }
        if let Some(location) = self
            .completed
            .get(&work.job.id)
            .cloned()
            .or_else(|| work.retained_location.clone())
        {
            self.verify_completed(work, &location).await?;
            self.completed.insert(work.job.id, location);
            return Ok(());
        }
        let spool = self
            .spools
            .get_mut(&work.job.generation)
            .ok_or(IoError::Integrity)?;
        let mut scratch = MemoryCache::default();
        scratch.assert_empty(&mut self.trace);
        spool.archives[0]
            .reconstruct(
                &spool.fixture,
                &mut scratch,
                Fault::Healthy,
                &mut self.trace,
            )
            .await
            .map_err(|_| IoError::Integrity)?;
        let bytes = scratch
            .delivery(spool.fixture.key())
            .ok_or(IoError::Integrity)?
            .to_vec();
        self.pending.insert(work.job.id, bytes);
        scratch.cleanup(spool.fixture.key(), &mut self.trace);
        scratch.assert_empty(&mut self.trace);
        self.cold_retrievals += 1;
        Ok(())
    }

    async fn complete_restore(
        &mut self,
        work: &Work,
    ) -> std::result::Result<CompleteCopy, IoError> {
        if let Some(location) = self.completed.get(&work.job.id).cloned() {
            return self.verify_completed(work, &location).await;
        }
        let bytes = self
            .pending
            .remove(&work.job.id)
            .ok_or(IoError::Integrity)?;
        if bytes.len() as u64 != work.metadata.identity.length
            || <[u8; 32]>::from(Sha256::digest(&bytes)) != work.metadata.identity.sha256
        {
            return Err(IoError::Integrity);
        }
        let location = format!(
            "synthetic/{}/{}/job-{}",
            work.tenant.0, work.job.generation.0, work.job.id.0
        );
        self.delivery.insert(location.clone(), bytes);
        self.completed.insert(work.job.id, location.clone());
        Ok(self.receipt(work, location))
    }

    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.check(work)?;
        let bytes = self.delivery.get(location).ok_or(IoError::Integrity)?;
        if bytes.len() as u64 != work.metadata.identity.length
            || <[u8; 32]>::from(Sha256::digest(bytes)) != work.metadata.identity.sha256
        {
            return Err(IoError::Integrity);
        }
        Ok(self.receipt(work, location.into()))
    }

    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        self.pending.remove(&work.job.id);
        Ok(())
    }
}

impl s3::archive::QualifiedCache for Io {
    fn read(
        &mut self,
        _: TenantId,
        _: GenerationId,
        identity: &CiphertextIdentity,
        location: &str,
        _: PinId,
        range: Option<s3::ByteRange>,
    ) -> s3::Result<Vec<u8>> {
        // No archive fallback: only a completed, verified immutable delivery copy.
        let bytes = self
            .delivery
            .get(location)
            .ok_or(s3::ErrorCode::InternalError)?;
        if bytes.len() as u64 != identity.length
            || <[u8; 32]>::from(Sha256::digest(bytes)) != identity.sha256
        {
            return Err(s3::ErrorCode::InternalError);
        }
        Ok(match range {
            Some(r) => bytes[r.start as usize..=r.end as usize].to_vec(),
            None => bytes.clone(),
        })
    }
}

pub struct Rules;
impl Policy for Rules {
    fn admit_upload(&self, _: &Upload, _: &Budget, _: u64) -> bool {
        true
    }
    fn admit_work(&self, _: &Work, _: u64) -> bool {
        true
    }
    fn cancelled(&self, _: &Work) -> bool {
        false
    }
    fn retry_at(&self, _: &Work, _: &IoError, _: u64) -> Option<u64> {
        None
    }
    fn cleanup_incomplete(&self, _: &Work, _: &IoError) -> bool {
        true
    }
}

pub struct SimulatedQualification;
impl Qualifier for SimulatedQualification {
    fn qualify(
        &self,
        work: &Work,
        retrieved: &[Reconstruction; 2],
        now: u64,
    ) -> qerith_core::catalogue::Result<Qualification> {
        Ok(Qualification {
            independence: IndependenceEvidence {
                backbones: [BackboneId(1), BackboneId(2)],
                assessor_ref: "SIMULATED software-only assessor".into(),
                decision_ref: "SIMULATED spools, NOT real provider independence".into(),
                valid_until: now + 30 * 86400,
            },
            verification: std::array::from_fn(|n| VerificationEvidence {
                generation: work.job.generation,
                backbone: retrieved[n].backbone,
                reconstructed: retrieved[n].identity.clone(),
                verified_at: now,
                valid_until: now + 30 * 86400,
                verifier_version: "pinned-velmora-synthetic-article".into(),
                provenance_ref: format!("simulated-spool-{n}"),
                readability_ref: "opaque bytes only; NO trusted-client crypto claim".into(),
            }),
        })
    }
}
