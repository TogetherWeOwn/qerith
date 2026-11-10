//! Experimental cold-restore bridge, not provider activation or qualification.
//! Existing legacy records retain their existing reader. New records select an
//! immutable backend/account, never the current new-write target or a fallback.

use super::*;
use a::{ArchiveProvider, Control};
use sha2::{Digest, Sha256};
use velmora::archive::v1 as a;

mod write;
pub use write::{WriteJournal, WritePhase};

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
    /// Stable intent selected independently of old-read routing, durably bound to
    /// this tenant/generation/recovery inventory before any provider effect. The
    /// original journal must also resolve for restore jobs of that generation,
    /// independently of the new-write target. None means no new-provider write;
    /// unknown or corrupt journals are errors.
    fn archive_write(&self, _work: &Work) -> std::result::Result<Option<WriteJournal>, IoError> {
        Ok(None)
    }
    /// Atomic compare-and-swap on the exact scoped journal. A Verified update
    /// installs its entire immutable ObjectRecord in the same transaction and
    /// binds the verified retained copy's exact location to its provider cache key.
    /// That binding must resolve for later jobs of this generation, not only the
    /// archive job's inventory. Never acknowledge a non-durable update;
    /// uncertainty requires original-state reconciliation. The invocation may be
    /// interrupted before acknowledgement; settle the original CAS and expose its
    /// actual checkpoint before accepting a retry, never infer rollback from drop.
    /// The journal retains the safety copy, never grants eviction.
    async fn save_archive_write(
        &mut self,
        _work: &Work,
        _expected: &WriteJournal,
        _next: &WriteJournal,
    ) -> std::result::Result<(), IoError> {
        Err(IoError::RepairUnavailable)
    }
    /// Read exactly this part from the retained verified immutable staging copy,
    /// not client-supplied bytes. Enforce Work's invocation bounds during I/O.
    async fn archive_write_part(
        &mut self,
        _work: &Work,
        _part: &a::Part,
    ) -> std::result::Result<Vec<u8>, IoError> {
        Err(IoError::RepairUnavailable)
    }
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

async fn interrupt<T, E>(
    control: &impl Control,
    target: &a::Target,
    action: a::Action,
    operation: impl std::future::Future<Output = std::result::Result<T, E>>,
    stopped: impl Fn(a::Failure) -> E,
) -> std::result::Result<T, E> {
    use std::future::{poll_fn, Future};
    use std::task::Poll;

    let mut cancelled = std::pin::pin!(control.cancelled(target, action));
    let mut operation = std::pin::pin!(operation);
    poll_fn(|cx| {
        // Register the event/deadline wake before checking current authority or
        // polling I/O. Dropping I/O interrupts this invocation, not remote effects;
        // the caller retains its pending journal and physical lease obligations.
        if let Poll::Ready(error) = cancelled.as_mut().poll(cx) {
            return Poll::Ready(Err(stopped(error)));
        }
        if let Err(error) = control.check(target, action) {
            return Poll::Ready(Err(stopped(error)));
        }
        operation.as_mut().poll(cx)
    })
    .await
}

async fn invoke<T>(
    control: &impl Control,
    target: &a::Target,
    action: a::Action,
    operation: impl std::future::Future<Output = a::Result<T>>,
) -> a::Result<T> {
    interrupt(control, target, action, operation, |error| error).await
}

async fn cache_read<T>(
    control: &impl Control,
    target: &a::Target,
    operation: impl std::future::Future<Output = std::result::Result<T, IoError>>,
    completing: bool,
) -> std::result::Result<T, IoError> {
    let stopped = |error| {
        if completing {
            IoError::Uncertain
        } else {
            io(error)
        }
    };
    let value = interrupt(control, target, a::Action::Read, operation, stopped).await?;
    // The cache may change authority while returning Ready in the same poll.
    // A dropped completion can already have persisted; never infer absence.
    control.check(target, a::Action::Read).map_err(stopped)?;
    Ok(value)
}

struct Discard;

impl a::Sink for Discard {
    async fn write(&mut self, _bytes: &[u8]) -> a::Result<()> {
        Ok(())
    }
}

struct RestoreSink<'a, S, C> {
    inner: S,
    control: &'a C,
    target: &'a a::Target,
    remaining: u64,
    digest: Sha256,
    failed: Option<a::Failure>,
}

impl<S: a::Sink, C: Control> a::Sink for RestoreSink<'_, S, C> {
    async fn write(&mut self, bytes: &[u8]) -> a::Result<()> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let result = async {
            self.control.check(self.target, a::Action::Read)?;
            if bytes.len() > a::STREAM_BLOCK_BYTES || bytes.len() as u64 > self.remaining {
                return Err(a::Failure::Limit);
            }
            self.inner.write(bytes).await?;
            self.control.check(self.target, a::Action::Read)
        }
        .await;
        if let Err(error) = result {
            // A provider must not turn a rejected block into successful completion
            // by ignoring the sink error and returning Ok from read_range.
            self.failed = Some(error);
            return Err(error);
        }
        self.remaining -= bytes.len() as u64;
        self.digest.update(bytes);
        Ok(())
    }
}

impl<S, C: Control> RestoreSink<'_, S, C> {
    fn finish(self, expected: [u8; 32]) -> a::Result<()> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        self.control.check(self.target, a::Action::Read)?;
        if self.remaining != 0 || <[u8; 32]>::from(self.digest.finalize()) != expected {
            return Err(a::Failure::Integrity);
        }
        Ok(())
    }
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
        let record = self.cache.archive_record(work)?;
        let journal = self.cache.archive_write(work)?;
        let Some(record) = record else {
            return match journal {
                None => Ok(None),
                Some(WriteJournal {
                    phase: WritePhase::Verified { .. },
                    ..
                }) => Err(IoError::Integrity),
                Some(_) => Err(IoError::RepairUnavailable),
            };
        };
        record.validate().map_err(io)?;
        if let Some(journal) = journal {
            // Verified and its record share one inventory transaction. Missing or
            // changed identity is corruption, not permission to read an alternate
            // version or route an unfinished new-provider write through legacy I/O.
            if journal.intent != record.intent()
                || !matches!(journal.phase, WritePhase::Verified { record: saved } if saved == record)
            {
                return Err(IoError::Integrity);
            }
        }
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

impl<L: ArchiveCache, N: ArchiveProvider, S: ArchiveProvider, C: Control>
    ProviderStorage<L, N, S, C>
{
    /// Explicit trusted-worker cancellation, never automatic error cleanup. The
    /// caller owns the scoped Work/claim; the cache CAS serializes this decision
    /// with concurrent writes. No journal means unavailable, not a legacy abort.
    /// This does not cancel a catalogue job, erase completed objects or release
    /// safety bytes/physical leases. Lost abort acknowledgement requires repair;
    /// object absence alone cannot prove an incomplete multipart was removed.
    pub async fn abort_write(
        &mut self,
        work: &Work,
    ) -> std::result::Result<a::AbortOutcome, IoError> {
        let journal = self
            .cache
            .archive_write(work)?
            .ok_or(IoError::RepairUnavailable)?;
        match journal.intent.target.backend {
            a::Backend::Nntp => {
                write::abort(
                    &mut self.cache,
                    &mut self.nntp,
                    &self.control,
                    work,
                    journal,
                )
                .await
            }
            a::Backend::S3 => {
                write::abort(&mut self.cache, &mut self.s3, &self.control, work, journal).await
            }
        }
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
        if let Some(journal) = self.cache.archive_write(work)? {
            return match journal.intent.target.backend {
                a::Backend::Nntp => {
                    write::post(
                        &mut self.cache,
                        &mut self.nntp,
                        &self.control,
                        work,
                        journal,
                    )
                    .await
                }
                a::Backend::S3 => {
                    write::post(&mut self.cache, &mut self.s3, &self.control, work, journal).await
                }
            };
        }
        if self.record(work)?.is_some() {
            return Err(IoError::RepairUnavailable);
        }
        self.cache.post(work).await
    }

    async fn verify_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<[Reconstruction; 2], IoError> {
        if self.cache.archive_write(work)?.is_some() || self.record(work)?.is_some() {
            // Provider readback is an observation, not authenticated readability
            // or independent-backbone/S3 durable qualification. Keep safety bytes.
            return Err(IoError::RepairUnavailable);
        }
        self.cache.verify_archive(work).await
    }

    async fn verify_s3_archive(
        &mut self,
        work: &Work,
    ) -> std::result::Result<Option<a::ObjectRecord>, IoError> {
        let Some(record) = self.record(work)? else {
            return Ok(None);
        };
        if record.identity.target.backend != a::Backend::S3 {
            return Ok(None);
        }
        let target = &record.identity.target;
        let location = work
            .retained_location
            .as_deref()
            .ok_or(IoError::Integrity)?;
        // Qualification needs Write even while retained-byte verification stalls;
        // the inner read guard alone cannot observe a Write-only revocation.
        let copy = interrupt(
            &self.control,
            target,
            a::Action::Write,
            cache_read(
                &self.control,
                target,
                self.cache
                    .verify_provider_completed(work, record.identity.cache_key(), location),
                false,
            ),
            io,
        )
        .await?;
        if copy.location != location || complete(&work.metadata, &copy).is_err() {
            return Err(IoError::Integrity);
        }
        // Both rights must remain current even if the provider ignores Control.
        // No cache allocation, publication or second whole-body buffer is needed.
        invoke(&self.control, target, a::Action::Write, async {
            let observed = invoke(
                &self.control,
                target,
                a::Action::Read,
                self.s3.stat(&record, &self.control),
            )
            .await?;
            if observed != record.identity {
                return Err(a::Failure::Integrity);
            }
            let mut sink = RestoreSink {
                inner: Discard,
                control: &self.control,
                target,
                remaining: record.identity.bytes,
                digest: Sha256::new(),
                failed: None,
            };
            if record.identity.bytes != 0 {
                invoke(
                    &self.control,
                    target,
                    a::Action::Read,
                    self.s3.read_range(
                        &record,
                        a::Range {
                            offset: 0,
                            bytes: record.identity.bytes,
                        },
                        &mut sink,
                        &self.control,
                    ),
                )
                .await?;
            }
            sink.finish(record.identity.sha256)?;
            self.control.check(target, a::Action::Write)
        })
        .await
        .map_err(io)?;
        if self.record(work)?.as_ref() != Some(&record) {
            return Err(IoError::Integrity);
        }
        Ok(Some(record))
    }

    async fn retrieve(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        let Some(record) = self.record(work)? else {
            return self.cache.retrieve(work).await;
        };
        let key = record.identity.cache_key();
        if !cache_read(
            &self.control,
            &record.identity.target,
            self.cache.reconcile_provider_restore(work, key),
            false,
        )
        .await?
        {
            let range = a::Range {
                offset: 0,
                bytes: record.identity.bytes,
            };
            let mut stage = RestoreSink {
                inner: cache_read(
                    &self.control,
                    &record.identity.target,
                    self.cache.begin_provider_restore(work, key),
                    false,
                )
                .await?,
                control: &self.control,
                target: &record.identity.target,
                remaining: range.bytes,
                digest: Sha256::new(),
                failed: None,
            };
            match record.identity.target.backend {
                a::Backend::Nntp => {
                    invoke(
                        &self.control,
                        &record.identity.target,
                        a::Action::Read,
                        self.nntp
                            .read_range(&record, range, &mut stage, &self.control),
                    )
                    .await
                }
                a::Backend::S3 => {
                    invoke(
                        &self.control,
                        &record.identity.target,
                        a::Action::Read,
                        self.s3
                            .read_range(&record, range, &mut stage, &self.control),
                    )
                    .await
                }
            }
            .map_err(io)?;
            stage.finish(record.identity.sha256).map_err(io)?;
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
                let copy = cache_read(
                    &self.control,
                    &record.identity.target,
                    self.cache
                        .complete_provider_restore(work, record.identity.cache_key()),
                    true,
                )
                .await?;
                // Completion may already be durable. A changed or unreadable
                // inventory cannot authorize publication or incomplete cleanup.
                if self.record(work).map_err(|_| IoError::Uncertain)?.as_ref() != Some(&record) {
                    return Err(IoError::Uncertain);
                }
                Ok(copy)
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
                let copy = cache_read(
                    &self.control,
                    &record.identity.target,
                    self.cache.verify_provider_completed(
                        work,
                        record.identity.cache_key(),
                        location,
                    ),
                    false,
                )
                .await?;
                if self.record(work)?.as_ref() != Some(&record) {
                    return Err(IoError::Integrity);
                }
                Ok(copy)
            }
            None => self.cache.verify_completed(work, location).await,
        }
    }

    async fn cleanup_incomplete(&mut self, work: &Work) -> std::result::Result<(), IoError> {
        // Cleanup authority belongs to the trusted cache, even after read
        // revocation. Do not issue archive abort/delete or fall back on errors.
        if self.cache.archive_write(work)?.is_some() {
            // A failed qualifier or interrupted write cannot discard safety bytes
            // or settle a pending request. Abort needs a separate settled path.
            return Ok(());
        }
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
