//! Additive inventory/calendar seams for the restricted archive adapter.
//! Durable implementations share the metadata/outbox transaction boundary.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BucketView {
    pub name: String,
    pub region: String,
    pub created_at: u64,
    /// Never reused, including after delete/recreate; fences continuation tokens.
    pub incarnation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BucketError {
    Unavailable,
    AlreadyOwned,
    NotEmpty,
    Invalid,
}

#[derive(Clone, Debug)]
pub struct ArchiveView {
    pub reference: ReferenceView,
    pub pending: bool,
    /// Trusted, immutable cache version. Not disclosed on the S3 wire.
    pub cache_location: Option<String>,
}

/// Admission/capacity receipt from trusted infrastructure, not request data.
/// The reservation must protect this exact tenant/reference/generation through
/// `until`, survive restart and be settled with the lease transaction. Failed or
/// uncertain transactions retain/reconcile it; they must not silently free it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapacityReservation {
    pub tenant: TenantId,
    pub name: String,
    pub operation: OperationId,
    pub generation: GenerationId,
    pub until: u64,
    pub receipt: String,
}

/// S3 names are `bucket/key` without path normalization. The namespace slash is
/// unambiguous because bucket names never contain slash. All bucket operations
/// require prior trusted bucket authority; this infrastructure port still scopes
/// every lookup by tenant. Delete checks *all* live references and pending upload
/// intents, not the caller's filtered listing, in the same serializable boundary
/// as uploads. Upload adapters must check bucket existence inside their commit
/// boundary; these generic catalogue contracts alone do not enforce S3 routing.
pub trait ArchiveReadPort: MetadataOutbox {
    /// Trusted cleanup, including after credential revocation; cannot grant read rights.
    fn release_serving_pin(&mut self, tenant: TenantId, pin: PinId) -> Result<()>;
    fn create_bucket(
        &mut self,
        tenant: TenantId,
        name: &str,
        region: &str,
        now: u64,
    ) -> std::result::Result<BucketView, BucketError>;
    fn bucket(&self, tenant: TenantId, name: &str) -> std::result::Result<BucketView, BucketError>;
    fn buckets(&self, tenant: TenantId) -> Vec<BucketView>;
    fn delete_bucket(
        &mut self,
        tenant: TenantId,
        name: &str,
    ) -> std::result::Result<(), BucketError>;
    /// UTF-8 byte order; at most `limit` authorized, non-prohibited live entries.
    /// Each call is current, not a snapshot. A durable implementation must use a
    /// bounded indexed scan and return no unauthorized names or metadata.
    fn list_references(
        &self,
        tenant: TenantId,
        prefix: &str,
        after: Option<&str>,
        limit: usize,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<Vec<(String, ReferenceView)>>;
    /// Metadata/status remains visible during cache deletion. Authorize before
    /// lookup using exactly Read or Restore; Restore does not imply Read. Serving
    /// and restore mutations retain their own deletion/admission fences.
    fn archive_view(
        &self,
        tenant: TenantId,
        name: &str,
        action: Action,
        now: u64,
        authority: &dyn Authority,
    ) -> Result<ArchiveView>;
}

/// Ceil(completion/renewal time + admitted Days) to UTC midnight. An exact
/// midnight remains unchanged. This is a service-profile rule, not an AWS claim.
pub fn archive_expiry(now: u64, days: u32) -> Result<u64> {
    if days == 0 {
        return Err(Error::Invalid);
    }
    now.checked_add(u64::from(days).checked_mul(86400).ok_or(Error::Invalid)?)
        .and_then(|t| t.checked_add(86399))
        .map(|t| t / 86400 * 86400)
        .filter(|t| *t <= 253402300799)
        .ok_or(Error::Invalid)
}
