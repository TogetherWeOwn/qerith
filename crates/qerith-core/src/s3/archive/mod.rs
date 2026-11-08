//! Bucket/list/read adapter for archive B, not an HTTP service or client certification.
//! Ingress verifies SigV4/TLS using `s3::verify` and constructs a trusted Session.
//! No public request can supply tenant identity, authority, cache/capacity receipts
//! or operation IDs. Durable implementations must honor the port contracts.
mod listing;
pub use listing::{Cursor, MemoryTokens, TokenPort, TokenScope};

use super::{
    parse_restore, plan_read, ByteRange, ChecksumAlgorithm, Conditions, ErrorCode, Headers,
    ObjectMetadata, Policy, Response, RestoreStatus, Result, StoredChecksum, Target,
};
use crate::catalogue::{self as cat, ArchiveReadPort, Authority};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    CreateBucket,
    ListBuckets,
    HeadBucket,
    DeleteBucket,
    Location,
    ListObjects,
    Read,
    Restore,
}

/// Trusted identity/scope bridge from verified ingress. `permits` receives exact
/// `bucket/key` references; listing permission never implies object read permission.
/// Recheck current credentials/policy on every call, including after cache I/O.
pub trait Session: Authority {
    fn tenant(&self) -> cat::TenantId;
    fn principal(&self) -> &str;
    fn allows(&self, operation: Operation, bucket: &str) -> bool;
}

/// Only a whole-generation verified immutable cache may implement this port.
/// Return exactly the inclusive C slice; no network archive fallback, decryption,
/// partial publication or reusable location. Implementations bound allocations to
/// the requested range and honor the serving pin/revocation policy during I/O.
pub trait QualifiedCache {
    fn read(
        &mut self,
        tenant: cat::TenantId,
        generation: cat::GenerationId,
        identity: &cat::CiphertextIdentity,
        location: &str,
        pin: cat::PinId,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>>;
}

/// Trusted current epoch seconds, never request data. Must advance across I/O
/// and not move backwards; ingress and the qualified cache share this time basis.
pub trait Clock {
    fn now(&self) -> u64;
}

pub trait CapacityPort {
    /// Commit capacity before returning. Bind receipt to tenant, reference, G and
    /// operation; reconcile failed/uncertain catalogue outcomes, never free an
    /// advertised guarantee on a disconnect. Failure must not extend the lease.
    fn reserve(
        &mut self,
        tenant: cat::TenantId,
        name: &str,
        operation: cat::OperationId,
        generation: cat::GenerationId,
        until: u64,
    ) -> Result<cat::CapacityReservation>;
}

#[derive(Clone, Debug)]
pub struct AdapterLimits {
    pub read_bytes: u64,
    pub serving_seconds: u64,
    pub restore_job_seconds: u64,
    pub scan_batch: usize,
    /// Maximum catalogue entries fetched per request, including discarded groups.
    pub scan_entries: usize,
}

pub struct Adapter<C, T> {
    pub catalogue: C,
    pub tokens: T,
    policy: Policy,
    limits: AdapterLimits,
}

impl<C: ArchiveReadPort, T: TokenPort> Adapter<C, T> {
    pub fn new(catalogue: C, tokens: T, policy: Policy, limits: AdapterLimits) -> Result<Self> {
        if limits.read_bytes == 0
            || limits.serving_seconds == 0
            || limits.restore_job_seconds == 0
            || !(1..=1000).contains(&limits.scan_batch)
            || limits.scan_entries == 0
        {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(Self {
            catalogue,
            tokens,
            policy,
            limits,
        })
    }

    fn authorize(&self, session: &impl Session, operation: Operation, bucket: &str) -> Result<()> {
        if !session.is_current() || !session.allows(operation, bucket) {
            return Err(ErrorCode::AccessDenied);
        }
        Ok(())
    }

    fn bucket(&self, session: &impl Session, bucket: &str) -> Result<cat::BucketView> {
        // Foreign and missing buckets intentionally have the same response. No
        // region/owner hints are emitted before tenant-scoped ownership succeeds.
        self.catalogue
            .bucket(session.tenant(), bucket)
            .map_err(bucket_error)
    }

    /// Route only this module's declared subset. Upload/delete/copy adapters are
    /// separate. Recognized unsupported selectors fail closed before effects.
    #[allow(clippy::too_many_arguments)]
    pub fn handle(
        &mut self,
        method: &str,
        target: &Target,
        headers: &Headers,
        body: &[u8],
        session: &impl Session,
        operation_id: cat::OperationId,
        clock: &impl Clock,
        request_id: &str,
        cache: &mut impl QualifiedCache,
        capacity: &mut impl CapacityPort,
    ) -> Response {
        let result = self.dispatch(
            method,
            target,
            headers,
            body,
            session,
            operation_id,
            clock,
            cache,
            capacity,
        );
        let mut response = result.unwrap_or_else(|e| e.response(method == "HEAD", request_id));
        response
            .headers
            .push(("x-amz-request-id".into(), request_id.into()));
        response
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch(
        &mut self,
        method: &str,
        target: &Target,
        headers: &Headers,
        body: &[u8],
        session: &impl Session,
        operation_id: cat::OperationId,
        clock: &impl Clock,
        cache: &mut impl QualifiedCache,
        capacity: &mut impl CapacityPort,
    ) -> Result<Response> {
        let now = clock.now();
        let bucket = target.bucket.as_str();
        let operation = if target.key.is_some() {
            match method {
                "GET" | "HEAD" => Operation::Read,
                "POST" => Operation::Restore,
                _ => return Err(ErrorCode::NotImplemented),
            }
        } else if bucket.is_empty() {
            if method != "GET" {
                return Err(ErrorCode::NotImplemented);
            }
            Operation::ListBuckets
        } else {
            match method {
                "PUT" => Operation::CreateBucket,
                "HEAD" => Operation::HeadBucket,
                "DELETE" => Operation::DeleteBucket,
                "GET" if target.one("location")?.is_some() => Operation::Location,
                "GET" => Operation::ListObjects,
                _ => return Err(ErrorCode::NotImplemented),
            }
        };
        self.authorize(session, operation, bucket)?;
        if let Some(key) = &target.key {
            let action = if operation == Operation::Restore {
                cat::Action::Restore
            } else {
                cat::Action::Read
            };
            if !session.permits(
                &cat::Reference {
                    tenant: session.tenant(),
                    name: format!("{bucket}/{key}"),
                },
                action,
            ) {
                return Err(ErrorCode::AccessDenied);
            }
        }
        validate_request(operation, target, headers)?;
        if now > 253402300799 {
            return Err(ErrorCode::InvalidArgument);
        }
        if operation != Operation::CreateBucket
            && !body.is_empty()
            && operation != Operation::Restore
        {
            return Err(ErrorCode::InvalidRequest);
        }
        if operation == Operation::CreateBucket {
            let region = create_region(body, &self.policy)?;
            if region != self.policy.region {
                return Err(ErrorCode::InvalidArgument);
            }
            self.catalogue
                .create_bucket(session.tenant(), bucket, &region, now)
                .map_err(bucket_error)?;
            return Ok(empty(200));
        }
        if operation == Operation::ListBuckets {
            let mut xml = String::from("<ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Buckets>");
            for b in self.catalogue.buckets(session.tenant()) {
                if session.allows(Operation::HeadBucket, &b.name) {
                    xml.push_str(&format!(
                        "<Bucket><Name>{}</Name><CreationDate>{}</CreationDate></Bucket>",
                        super::xml(&b.name),
                        iso_date(b.created_at)?
                    ));
                }
            }
            xml.push_str("</Buckets></ListAllMyBucketsResult>");
            return Ok(xml_response(xml));
        }
        let bucket_view = self.bucket(session, bucket)?;
        match operation {
            Operation::HeadBucket => Ok(Response { headers: vec![("x-amz-bucket-region".into(), bucket_view.region)], ..empty(200) }),
            Operation::DeleteBucket => { self.catalogue.delete_bucket(session.tenant(), bucket).map_err(bucket_error)?; Ok(empty(204)) }
            Operation::Location => Ok(xml_response(format!("<LocationConstraint xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{}</LocationConstraint>", super::xml(&bucket_view.region)))),
            Operation::ListObjects => self.list(target, session, &bucket_view, now),
            Operation::Read | Operation::Restore => {
                let name = format!("{bucket}/{}", target.key.as_deref().ok_or(ErrorCode::InvalidRequest)?);
                let action = if operation == Operation::Restore { cat::Action::Restore } else { cat::Action::Read };
                let view = self.catalogue.archive_view(session.tenant(), &name, action, now, session).map_err(|e| match e {
                    cat::Error::Unavailable if session.allows(Operation::ListObjects, bucket) => ErrorCode::NoSuchKey,
                    cat::Error::Unavailable => ErrorCode::AccessDenied,
                    _ => catalogue_error(e),
                })?;
                if operation == Operation::Restore {
                    self.restore(&name, view, body, session, operation_id, now, capacity)
                } else { self.read(method == "HEAD", &name, view, headers, session, operation_id, now, clock, cache) }
            }
            _ => Err(ErrorCode::InvalidRequest),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn read(
        &mut self,
        head: bool,
        name: &str,
        view: cat::ArchiveView,
        headers: &Headers,
        session: &impl Session,
        operation: cat::OperationId,
        now: u64,
        clock: &impl Clock,
        cache: &mut impl QualifiedCache,
    ) -> Result<Response> {
        let metadata = wire_metadata(&view.reference)?;
        let available = view.reference.availability_until.is_some();
        let mut plan = plan_read(
            &metadata,
            head,
            &Conditions::from_headers(headers),
            headers.get("range"),
            available,
            headers.get("x-amz-checksum-mode") == Some("ENABLED"),
        )?;
        if plan.status != 304 {
            let state = if let Some(expiry) = view.reference.availability_until {
                RestoreStatus::Available {
                    expiry: expiry as i64,
                }
            } else if view.pending {
                RestoreStatus::Pending
            } else {
                RestoreStatus::Unavailable
            };
            if let Some(value) = state.header(now as i64)? {
                plan.headers.push(("x-amz-restore".into(), value));
            }
        }
        if head || plan.status == 304 {
            return Ok(Response {
                status: plan.status,
                headers: plan.headers,
                body: Vec::new(),
            });
        }
        let length = plan.body.map_or(0, ByteRange::length);
        if length > self.limits.read_bytes {
            return Err(ErrorCode::SlowDown);
        }
        let until = now
            .checked_add(self.limits.serving_seconds)
            .ok_or(ErrorCode::InvalidArgument)?
            .min(
                view.reference
                    .availability_until
                    .ok_or(ErrorCode::InvalidObjectState)?,
            );
        let outcome = self
            .catalogue
            .transact(
                session.tenant(),
                operation,
                cat::Mutation::AcquireServingPin {
                    name: name.into(),
                    until,
                },
                now,
                session,
            )
            .map_err(catalogue_error)?;
        let cat::Outcome::Pin(pin) = outcome else {
            return Err(ErrorCode::InternalError);
        };
        // Validate the pin's generation against the earlier metadata snapshot,
        // defeating overwrite between metadata planning and serving admission.
        let result = (|| {
            if self
                .catalogue
                .validate_pin(session.tenant(), pin, now, session)
                .map_err(catalogue_error)?
                != view.reference.generation
            {
                return Err(ErrorCode::AccessDenied);
            }
            let location = view
                .cache_location
                .as_deref()
                .ok_or(ErrorCode::InternalError)?;
            let body = cache.read(
                session.tenant(),
                view.reference.generation,
                &view.reference.metadata.identity,
                location,
                pin,
                plan.body,
            )?;
            if u64::try_from(body.len()).ok() != Some(length) {
                return Err(ErrorCode::InternalError);
            }
            self.authorize(
                session,
                Operation::Read,
                name.split_once('/').ok_or(ErrorCode::InternalError)?.0,
            )?;
            let completed_at = clock.now();
            if completed_at < now
                || completed_at >= until
                || !session.permits(
                    &cat::Reference {
                        tenant: session.tenant(),
                        name: name.into(),
                    },
                    cat::Action::Read,
                )
                || self
                    .catalogue
                    .validate_pin(session.tenant(), pin, completed_at, session)
                    .is_err()
            {
                return Err(ErrorCode::AccessDenied);
            }
            Ok(Response {
                status: plan.status,
                headers: plan.headers,
                body,
            })
        })();
        // Release uses a separate infrastructure hook: no externally chosen
        // operation ID arithmetic/collision, and cleanup survives revocation.
        self.catalogue
            .release_serving_pin(session.tenant(), pin)
            .map_err(catalogue_error)?;
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn restore(
        &mut self,
        name: &str,
        view: cat::ArchiveView,
        body: &[u8],
        session: &impl Session,
        operation: cat::OperationId,
        now: u64,
        capacity: &mut impl CapacityPort,
    ) -> Result<Response> {
        let days = parse_restore(body, &self.policy)?;
        if let Some(old) = view.reference.availability_until {
            let until = cat::archive_expiry(now, days)
                .map_err(catalogue_error)?
                .max(old);
            let reservation = capacity.reserve(
                session.tenant(),
                name,
                operation,
                view.reference.generation,
                until,
            )?;
            self.catalogue
                .transact(
                    session.tenant(),
                    operation,
                    cat::Mutation::RenewArchiveAvailability {
                        name: name.into(),
                        expected_revision: view.reference.revision,
                        days,
                        reservation,
                    },
                    now,
                    session,
                )
                .map_err(catalogue_error)?;
            return Ok(empty(200));
        }
        if view.pending {
            return Err(ErrorCode::RestoreAlreadyInProgress);
        }
        let deadline = now
            .checked_add(self.limits.restore_job_seconds)
            .ok_or(ErrorCode::InvalidArgument)?;
        self.catalogue
            .transact(
                session.tenant(),
                operation,
                cat::Mutation::RequestArchiveRestore {
                    name: name.into(),
                    expected_revision: view.reference.revision,
                    deadline,
                    days,
                },
                now,
                session,
            )
            .map_err(|e| {
                if e == cat::Error::Conflict {
                    ErrorCode::RestoreAlreadyInProgress
                } else {
                    catalogue_error(e)
                }
            })?;
        Ok(empty(202))
    }
}

fn catalogue_error(error: cat::Error) -> ErrorCode {
    match error {
        cat::Error::Unavailable | cat::Error::Fenced => ErrorCode::AccessDenied,
        cat::Error::Expired => ErrorCode::InvalidObjectState,
        cat::Error::Uncertain | cat::Error::Conflict => ErrorCode::SlowDown,
        _ => ErrorCode::InternalError,
    }
}
fn bucket_error(error: cat::BucketError) -> ErrorCode {
    match error {
        cat::BucketError::Unavailable => ErrorCode::AccessDenied,
        cat::BucketError::AlreadyOwned => ErrorCode::BucketAlreadyOwnedByYou,
        cat::BucketError::NotEmpty => ErrorCode::BucketNotEmpty,
        cat::BucketError::Invalid => ErrorCode::InvalidArgument,
    }
}
fn empty(status: u16) -> Response {
    Response {
        status,
        headers: Vec::new(),
        body: Vec::new(),
    }
}
fn xml_response(body: String) -> Response {
    Response {
        status: 200,
        headers: vec![("content-type".into(), "application/xml".into())],
        body: body.into_bytes(),
    }
}
fn iso_date(timestamp: u64) -> Result<String> {
    chrono::DateTime::from_timestamp(
        i64::try_from(timestamp).map_err(|_| ErrorCode::InternalError)?,
        0,
    )
    .map(|t| t.format("%Y-%m-%dT%H:%M:%S.000Z").to_string())
    .ok_or(ErrorCode::InternalError)
}

fn wire_metadata(view: &cat::ReferenceView) -> Result<ObjectMetadata> {
    let m = &view.metadata;
    // This wire profile qualifies only one negotiated checksum. Never silently
    // discard an unsupported algorithm/type/part proof or synthesize an ETag.
    if m.checksums.len() > 1 {
        return Err(ErrorCode::InternalError);
    }
    let checksum = m
        .checksums
        .first()
        .map(|c| {
            let algorithm = match c.algorithm.as_str() {
                "SHA256" => ChecksumAlgorithm::Sha256,
                "CRC32" => ChecksumAlgorithm::Crc32,
                _ => return Err(ErrorCode::InternalError),
            };
            match c.kind {
                cat::ChecksumType::FullObject if c.parts.is_empty() => {
                    StoredChecksum::full(algorithm, STANDARD.encode(&c.value))
                }
                cat::ChecksumType::Composite if algorithm == ChecksumAlgorithm::Sha256 => {
                    let stored = StoredChecksum::composite_sha256(
                        c.parts.iter().map(|p| STANDARD.encode(p)).collect(),
                    )?;
                    if stored.value() != format!("{}-{}", STANDARD.encode(&c.value), c.parts.len())
                    {
                        return Err(ErrorCode::InternalError);
                    }
                    Ok(stored)
                }
                _ => Err(ErrorCode::InternalError),
            }
        })
        .transpose()
        .map_err(|_| ErrorCode::InternalError)?;
    ObjectMetadata::new(
        view.generation.0.to_string(),
        m.identity.length,
        m.validator.clone(),
        i64::try_from(m.modified_at).map_err(|_| ErrorCode::InternalError)?,
        m.headers
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        checksum,
    )
    .map_err(|_| ErrorCode::InternalError)
}

fn validate_request(operation: Operation, target: &Target, headers: &Headers) -> Result<()> {
    target.validate_features()?;
    headers.validate_features()?;
    for (name, _) in target.query() {
        let name = std::str::from_utf8(name).map_err(|_| ErrorCode::InvalidRequest)?;
        if name.starts_with("X-Amz-") {
            continue;
        }
        let allowed = match operation {
            Operation::ListObjects => matches!(
                name,
                "list-type"
                    | "prefix"
                    | "delimiter"
                    | "start-after"
                    | "max-keys"
                    | "continuation-token"
                    | "encoding-type"
            ),
            Operation::Location => name == "location",
            Operation::Restore => name == "restore",
            _ => false,
        };
        if !allowed {
            return Err(ErrorCode::InvalidRequest);
        }
    }
    if operation == Operation::ListObjects && target.one("list-type")? != Some("2") {
        return Err(ErrorCode::NotImplemented);
    }
    if operation == Operation::Restore && target.one("restore")? != Some("") {
        return Err(ErrorCode::InvalidRequest);
    }
    for (name, _) in headers.iter() {
        if name.starts_with("x-amz-")
            && !matches!(name, "x-amz-date" | "x-amz-content-sha256")
            && !(operation == Operation::Read && name == "x-amz-checksum-mode")
        {
            return Err(ErrorCode::InvalidRequest);
        }
    }
    Ok(())
}

fn create_region(body: &[u8], policy: &Policy) -> Result<String> {
    if body.is_empty() {
        return Ok(policy.region.clone());
    }
    if body.len() > policy.limits.control_xml_bytes {
        return Err(ErrorCode::InvalidRequest);
    }
    use quick_xml::{events::Event, Reader};
    let mut reader = Reader::from_reader(body);
    reader.config_mut().trim_text(true);
    let mut stage = 0;
    let mut declaration_seen = false;
    let mut region = String::new();
    loop {
        match reader.read_event().map_err(|_| ErrorCode::MalformedXML)? {
            Event::Decl(e) if stage == 0 && !declaration_seen => {
                super::restore::validate_declaration(&e)?;
                declaration_seen = true;
            }
            Event::Start(e) if stage == 0 && e.name().as_ref() == "CreateBucketConfiguration" => {
                for a in e.attributes() {
                    let a = a.map_err(|_| ErrorCode::MalformedXML)?;
                    if a.key.as_ref() != "xmlns"
                        || a.value.as_ref() != "http://s3.amazonaws.com/doc/2006-03-01/"
                    {
                        return Err(ErrorCode::InvalidRequest);
                    }
                }
                stage = 1;
            }
            Event::Start(e)
                if stage == 1
                    && e.name().as_ref() == "LocationConstraint"
                    && e.attributes().next().is_none() =>
            {
                stage = 2
            }
            Event::Text(e) if stage == 2 => region.push_str(e.as_ref()),
            Event::End(_) if stage == 2 => stage = 3,
            Event::End(_) if stage == 3 => stage = 4,
            Event::Eof if stage == 4 && !region.is_empty() => return Ok(region),
            _ => return Err(ErrorCode::MalformedXML),
        }
    }
}
