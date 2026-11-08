//! Experimental cold-restore bridge, not provider activation or qualification.
//! Existing legacy records retain their existing reader. New records select an
//! immutable backend/account, never the current new-write target or a fallback.

use super::*;
use a::{ArchiveProvider, Control};
use velmora::archive::v1 as a;

/// Trusted product inventory/cache adapter. Resolve `recovery_ref` in the same
/// tenant/generation scope as the catalogue metadata, not from request fields.
/// None means an explicitly recognized legacy record; missing/corrupt/unknown
/// new records are errors, never permission to try the legacy reader.
///
/// Persist the entire shared ObjectRecord (including encryption identity and
/// immutable account routing), not just a locator. Numeric tenant/generation
/// identifiers use their canonical decimal encoding at the provider boundary.
/// No data in this port grants serving rights or replaces media authentication.
#[allow(async_fn_in_trait)]
pub trait ArchiveCache: Storage {
    type Stage<'a>: a::Sink
    where
        Self: 'a;

    fn archive_record(&self, work: &Work) -> std::result::Result<Option<a::ObjectRecord>, IoError>;
    /// Reconcile the scoped completed inventory or retained catalogue version.
    /// Verify its full bytes/checksums and exact cache key. Only proven absence
    /// returns false; missing/corrupt recorded completions must return an error.
    async fn reconcile_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<bool, IoError>;
    /// Invisible, bounded staging; a partial/error prefix must never be served.
    /// The key includes backend/account/version/encryption, not only content.
    async fn begin_provider_restore<'a>(
        &'a mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<Self::Stage<'a>, IoError>;
    /// Verify the entire ciphertext and negotiated checksums before immutable
    /// cache completion; persist its exact key/location before acknowledging.
    /// Publication and serving pins remain exclusively catalogue operations.
    async fn complete_provider_restore(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<CompleteCopy, IoError>;
    async fn verify_provider_completed(
        &mut self,
        work: &Work,
        key: [u8; 32],
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError>;
    /// Remove only this attempt's incomplete allocation. Never remove completed,
    /// uncertain, retained safety or another attempt's bytes.
    async fn cleanup_provider_incomplete(
        &mut self,
        work: &Work,
        key: [u8; 32],
    ) -> std::result::Result<(), IoError>;
}

pub struct ProviderStorage<L, N, S, C> {
    pub cache: L,
    pub nntp: N,
    pub s3: S,
    /// Trusted current authority/deadline/cancellation; not request booleans.
    /// Both transports must enforce it during I/O, not only at these boundaries.
    /// `Control::cancelled` must register an actual invocation/policy/deadline
    /// wake source before rechecking current policy. A pending socket must not
    /// prevent that wake. Caller retains physical leases until proved settled;
    /// dropping an operation is not evidence of remote rollback or closure.
    pub control: C,
}

fn io(error: a::Failure) -> IoError {
    match error {
        a::Failure::Uncertain => IoError::Uncertain,
        a::Failure::Transient => IoError::Retryable,
        a::Failure::Denied | a::Failure::Cancelled | a::Failure::Deadline => IoError::Cancelled,
        a::Failure::Integrity | a::Failure::Conflict | a::Failure::Invalid | a::Failure::Limit => {
            IoError::Integrity
        }
        _ => IoError::RepairUnavailable,
    }
}

impl<L: ArchiveCache, N, S, C: Control> ProviderStorage<L, N, S, C> {
    fn record(&self, work: &Work) -> std::result::Result<Option<a::ObjectRecord>, IoError> {
        let Some(record) = self.cache.archive_record(work)? else {
            return Ok(None);
        };
        record.validate().map_err(io)?;
        if record.identity.target.tenant.as_str() != work.tenant.0.to_string()
            || record.identity.target.generation.as_str() != work.job.generation.0.to_string()
            || record.identity.bytes != work.metadata.identity.length
            || record.identity.sha256 != work.metadata.identity.sha256
            || record.identity.bytes > work.budget.max_bytes()
            || record.parts.len() as u64 > u64::from(work.budget.max_units())
        {
            return Err(IoError::Integrity);
        }
        self.control
            .check(&record.identity.target, a::Action::Read)
            .map_err(io)?;
        Ok(Some(record))
    }
}

impl<L: ArchiveCache, N: ArchiveProvider, S: ArchiveProvider, C: Control> Storage
    for ProviderStorage<L, N, S, C>
{
    async fn stage_upload(
        &mut self,
        upload: &Upload,
        budget: &Budget,
        until: u64,
    ) -> std::result::Result<CompleteCopy, IoError> {
        self.cache.stage_upload(upload, budget, until).await
    }

    async fn post(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        if self.record(work)?.is_some() {
            // Write journal and backend-specific qualification are not yet wired.
            // Preserve the staged safety copy rather than fabricate NNTP proof.
            return Err(IoError::RepairUnavailable);
        }
        self.cache.post(work).await
    }

    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        if self.record(work)?.is_some() {
            return Err(IoError::RepairUnavailable);
        }
        self.cache.verify_archive(work).await
    }

    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        let Some(record) = self.record(work)? else {
            return self.cache.retrieve(work).await;
        };
        let key = record.identity.cache_key();
        if !self.cache.reconcile_provider_restore(work, key).await? {
            let range = a::Range {
                offset: 0,
                bytes: record.identity.bytes,
            };
            let mut stage = self.cache.begin_provider_restore(work, key).await?;
            match record.identity.target.backend {
                a::Backend::Nntp => {
                    self.nntp
                        .read_range(&record, range, &mut stage, &self.control)
                        .await
                }
                a::Backend::S3 => {
                    self.s3
                        .read_range(&record, range, &mut stage, &self.control)
                        .await
                }
            }
            .map_err(io)?;
        }
        if self.record(work)?.as_ref() != Some(&record) {
            return Err(IoError::Integrity);
        }
        Ok(())
    }

    async fn complete_restore(
        &mut self,
        work: &Work,
    ) -> std::result::Result<CompleteCopy, IoError> {
        match self.record(work)? {
            Some(record) => {
                self.cache
                    .complete_provider_restore(work, record.identity.cache_key())
                    .await
            }
            None => self.cache.complete_restore(work).await,
        }
    }

    async fn verify_completed(
        &mut self,
        work: &Work,
        location: &str,
    ) -> std::result::Result<CompleteCopy, IoError> {
        match self.record(work)? {
            Some(record) => {
                self.cache
                    .verify_provider_completed(work, record.identity.cache_key(), location)
                    .await
            }
            None => self.cache.verify_completed(work, location).await,
        }
    }

    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        // Cleanup authority belongs to the trusted cache, even after read
        // revocation. Do not issue archive abort/delete or fall back on errors.
        match self.cache.archive_record(work)? {
            Some(record) => {
                self.cache
                    .cleanup_provider_incomplete(work, record.identity.cache_key())
                    .await
            }
            None => self.cache.cleanup_incomplete(work).await,
        }
    }
}
