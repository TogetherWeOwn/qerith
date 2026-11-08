//! Test-only routing glue; domain transitions remain in the merged producers.
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use qerith_core::{
    catalogue::*,
    composition,
    s3::{self, archive::*, mutation::*},
};
use serde_json::json;

use super::{
    http::Request,
    storage::{Io, Rules, SimulatedQualification},
};

const TENANT: TenantId = TenantId(1);
const MAX_OBJECT: usize = 1024 * 1024;
const MAX_COMMITS: usize = 64;

pub struct Time(pub u64);
impl composition::Clock for Time {
    fn now(&self) -> qerith_core::catalogue::Result<u64> {
        Ok(self.0)
    }
}
impl Clock for Time {
    fn now(&self) -> u64 {
        self.0
    }
}

struct WireAuthority<'a> {
    secret: &'a str,
    revoked: bool,
}
impl s3::Authority for WireAuthority<'_> {
    fn credential(&self, access_key: &str) -> Option<s3::Credential<'_>> {
        if self.revoked {
            return None;
        }
        match access_key {
            "fixture" => Some(s3::Credential {
                principal: "fixture",
                secret: self.secret.as_bytes(),
            }),
            "foreign" => Some(s3::Credential {
                principal: "foreign",
                secret: self.secret.as_bytes(),
            }),
            _ => None,
        }
    }
    fn authorize(&self, _: &str, _: &str, _: &s3::Target) -> bool {
        !self.revoked
    }
}

pub struct Access {
    tenant: TenantId,
    revoked: bool,
}
impl Authority for Access {
    fn is_current(&self) -> bool {
        !self.revoked
    }
    fn permits(&self, reference: &Reference, _: Action) -> bool {
        !self.revoked && reference.tenant == self.tenant
    }
}
impl Session for Access {
    fn tenant(&self) -> TenantId {
        self.tenant
    }
    fn principal(&self) -> &str {
        if self.tenant == TENANT {
            "fixture"
        } else {
            "foreign"
        }
    }
    fn allows(&self, _: Operation, _: &str) -> bool {
        !self.revoked
    }
}

#[derive(Default)]
struct Capacity {
    reservations: Vec<CapacityReservation>,
}
impl CapacityPort for Capacity {
    fn reserve(
        &mut self,
        tenant: TenantId,
        name: &str,
        operation: OperationId,
        generation: GenerationId,
        until: u64,
    ) -> s3::Result<CapacityReservation> {
        if self.reservations.len() >= 256 {
            return Err(s3::ErrorCode::SlowDown);
        }
        let value = CapacityReservation {
            tenant,
            name: name.into(),
            operation,
            generation,
            until,
            receipt: "bounded-model-capacity-not-production".into(),
        };
        self.reservations.push(value.clone());
        Ok(value)
    }
}

pub struct State {
    mutations: MemoryMutations,
    tokens: Option<MemoryTokens>,
    io: Io,
    time: Time,
    secret: String,
    host: Option<String>,
    revoked: bool,
    capacity: Capacity,
    checksum: BTreeMap<UploadId, MultipartChecksum>,
    requests: usize,
    commits: usize,
    events: Vec<serde_json::Value>,
    trace_history: Vec<serde_json::Value>,
}

fn validate_checksum_type(headers: &s3::Headers, checksum: MultipartChecksum) -> s3::Result<()> {
    let expected = match checksum {
        MultipartChecksum::None => None,
        MultipartChecksum::CompositeSha256 => Some("COMPOSITE"),
        MultipartChecksum::Full(_) => Some("FULL_OBJECT"),
    };
    if headers
        .get("x-amz-checksum-type")
        .is_some_and(|kind| Some(kind) != expected)
    {
        return Err(s3::ErrorCode::InvalidRequest);
    }
    Ok(())
}

fn wall() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn policy(host: &str) -> s3::Policy {
    s3::Policy::new(
        host.into(),
        "us-east-1".into(),
        s3::Limits {
            target_bytes: 8192,
            control_xml_bytes: 65536,
            header_bytes: 32768,
            header_count: 128,
            query_pairs: 64,
            upload_bytes: MAX_OBJECT as u64,
            min_restore_days: 1,
            max_restore_days: 7,
            clock_skew_seconds: 900,
            presign_seconds: 300,
        },
    )
    .unwrap()
}
fn xml(body: String) -> s3::Response {
    s3::Response {
        status: 200,
        headers: vec![("content-type".into(), "application/xml".into())],
        body: body.into_bytes(),
    }
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\r', "&#13;")
}
fn query<'a>(target: &'a s3::Target, name: &str) -> Option<&'a str> {
    target
        .query()
        .iter()
        .find(|(k, _)| k == name.as_bytes())
        .and_then(|(_, v)| std::str::from_utf8(v).ok())
}
fn validate_route(method: &str, target: &s3::Target) -> s3::Result<()> {
    let selectors = [
        "uploads",
        "uploadId",
        "delete",
        "restore",
        "location",
        "list-type",
    ];
    let selected: Vec<_> = selectors
        .into_iter()
        .filter(|name| query(target, name).is_some())
        .collect();
    if selected.len() > 1 {
        return Err(s3::ErrorCode::InvalidRequest);
    }
    let object = target.key.is_some();
    let selector = selected.first().copied();
    let valid = match selector {
        Some("uploads") => (method == "POST" && object) || (method == "GET" && !object),
        Some("uploadId") => object && matches!(method, "GET" | "PUT" | "POST" | "DELETE"),
        Some("delete") => method == "POST" && !object,
        Some("restore") => method == "POST" && object,
        Some("location" | "list-type") => method == "GET" && !object,
        None => true,
        _ => false,
    };
    if !valid {
        return Err(s3::ErrorCode::InvalidRequest);
    }
    for (name, value) in target.query() {
        let name = std::str::from_utf8(name).map_err(|_| s3::ErrorCode::InvalidRequest)?;
        if name.starts_with("X-Amz-") {
            continue;
        }
        let allowed = match selector {
            Some("uploads") if method == "GET" => matches!(
                name,
                "uploads"
                    | "prefix"
                    | "key-marker"
                    | "upload-id-marker"
                    | "max-uploads"
                    | "delimiter"
                    | "encoding-type"
            ),
            Some("uploadId") => {
                name == "uploadId"
                    || (method == "PUT" && name == "partNumber")
                    || (method == "GET" && matches!(name, "part-number-marker" | "max-parts"))
            }
            Some("list-type") => matches!(
                name,
                "list-type"
                    | "prefix"
                    | "delimiter"
                    | "continuation-token"
                    | "start-after"
                    | "max-keys"
                    | "encoding-type"
            ),
            Some(selector) => name == selector,
            None => false,
        };
        if !allowed
            || (matches!(name, "uploads" | "delete" | "restore" | "location") && !value.is_empty())
        {
            return Err(s3::ErrorCode::InvalidRequest);
        }
    }
    if selector == Some("uploadId") && method == "PUT" && query(target, "partNumber").is_none() {
        return Err(s3::ErrorCode::InvalidRequest);
    }
    Ok(())
}

fn number(target: &s3::Target, name: &str, default: u64) -> s3::Result<u64> {
    query(target, name).map_or(Ok(default), |s| {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(s3::ErrorCode::InvalidArgument);
        }
        s.parse().map_err(|_| s3::ErrorCode::InvalidArgument)
    })
}

fn copy_range(value: &str) -> s3::Result<(usize, usize)> {
    let (start, end) = value
        .strip_prefix("bytes=")
        .and_then(|v| v.split_once('-'))
        .ok_or(s3::ErrorCode::InvalidArgument)?;
    if start.is_empty()
        || end.is_empty()
        || !start.bytes().chain(end.bytes()).all(|b| b.is_ascii_digit())
    {
        return Err(s3::ErrorCode::InvalidArgument);
    }
    let start = start.parse().map_err(|_| s3::ErrorCode::InvalidArgument)?;
    let end = end.parse().map_err(|_| s3::ErrorCode::InvalidArgument)?;
    if start > end {
        return Err(s3::ErrorCode::InvalidRange);
    }
    Ok((start, end))
}

impl State {
    pub fn new(secret: String) -> Self {
        Self {
            mutations: MemoryMutations::new(MutationPolicy {
                object_bytes: MAX_OBJECT,
                part_bytes: MAX_OBJECT,
                min_part_bytes: 1,
                parts: 100,
                sessions: 64,
                staged_bytes: 8 * MAX_OBJECT,
                batch_keys: 100,
                lifetime: 14 * 86400,
                archive_window: 14 * 86400,
                result_retention: 86400,
                max_attempts: 3,
            })
            .unwrap(),
            tokens: Some(MemoryTokens::new(256, 3600).unwrap()),
            io: Io::default(),
            time: Time(wall()),
            secret,
            host: None,
            revoked: false,
            capacity: Capacity::default(),
            checksum: BTreeMap::new(),
            requests: 0,
            commits: 0,
            events: vec![],
            trace_history: vec![],
        }
    }

    pub async fn handle(&mut self, request: Request, token: &str) -> s3::Response {
        self.requests += 1;
        if request.target.starts_with("/__fixture/") {
            let authorized = request.method == "POST"
                && request.fields.iter().any(|(n, v)| {
                    n.eq_ignore_ascii_case("authorization") && v == &format!("Bearer {token}")
                });
            if !authorized {
                return s3::ErrorCode::AccessDenied.response(false, "control-denied");
            }
            self.events
                .push(json!({"control_started": &request.target[11..]}));
            self.save_trace();
            let response = self.control(&request.target[11..], &request.body).await;
            self.save_trace();
            return response;
        }
        let result = self.dispatch(&request);
        let mut response =
            result.unwrap_or_else(|e| e.response(request.method == "HEAD", "synthetic-request"));
        response
            .headers
            .retain(|(name, _)| !name.eq_ignore_ascii_case("x-amz-request-id"));
        response.headers.push((
            "x-amz-request-id".into(),
            format!("synthetic-{}", self.requests),
        ));
        // Never persist Authorization, presigned query credentials, control token,
        // signing secret, payloads or metadata values in fixture traces.
        self.events.push(json!({"method": request.method, "status": response.status, "response_bytes": response.body.len(), "request": self.requests}));
        response
    }

    fn dispatch(&mut self, request: &Request) -> s3::Result<s3::Response> {
        let p = policy(self.host.as_deref().ok_or(s3::ErrorCode::AccessDenied)?);
        let target = s3::Target::parse(&request.target, &p)?;
        let fields: Vec<_> = request
            .fields
            .iter()
            .map(|(n, v)| (n.as_str(), v.as_str()))
            .collect();
        let headers = s3::Headers::new(&fields, &p)?;
        let wire = WireAuthority {
            secret: &self.secret,
            revoked: self.revoked,
        };
        // This listener exists solely behind the test-owned verified HTTPS relay.
        // No Forwarded header or public caller can assert the transport boolean.
        let verified = s3::verify(
            &request.method,
            &target,
            &headers,
            true,
            wall() as i64,
            &p,
            &wire,
        )?;
        let access = Access {
            tenant: if verified.principal == "fixture" {
                TENANT
            } else {
                TenantId(2)
            },
            revoked: self.revoked,
        };
        let tenant = access.tenant;
        let method = request.method.as_str();
        validate_route(method, &target)?;
        let multipart = query(&target, "uploads").is_some() || query(&target, "uploadId").is_some();
        let mutation = (target.key.is_some() && matches!(method, "PUT" | "DELETE"))
            || multipart
            || (method == "POST" && query(&target, "delete").is_some());
        if !mutation {
            let mut adapter = Adapter::new(
                self.mutations.catalogue().clone(),
                self.tokens.take().unwrap(),
                p,
                AdapterLimits {
                    read_bytes: MAX_OBJECT as u64,
                    serving_seconds: 30,
                    restore_job_seconds: 3600,
                    scan_batch: 100,
                    scan_entries: 1000,
                },
            )?;
            let operation = OperationId(
                adapter
                    .catalogue
                    .allocate_identity(tenant)
                    .map_err(|_| s3::ErrorCode::InternalError)?,
            );
            let response = adapter.handle(
                method,
                &target,
                &headers,
                &request.body,
                &access,
                operation,
                &self.time,
                "synthetic",
                &mut self.io,
                &mut self.capacity,
            );
            *self.mutations.catalogue_worker() = adapter.catalogue;
            self.tokens = Some(adapter.tokens);
            return Ok(response);
        }
        // Authenticate before even disclosing bucket existence.
        self.mutations
            .catalogue()
            .bucket(tenant, &target.bucket)
            .map_err(|_| s3::ErrorCode::AccessDenied)?;
        if query(&target, "delete").is_some() {
            if method != "POST" {
                return Err(s3::ErrorCode::InvalidRequest);
            }
            let _ = ValidatedBody::new(request.body.clone(), &headers, &verified, &p)?;
            let deleted = parse_delete(&request.body, &p, 100)?;
            return self
                .mutations
                .delete_objects(tenant, &target, deleted, self.time.0, &access);
        }
        if method == "GET" && query(&target, "uploads").is_some() && target.key.is_none() {
            return self.list_uploads(&target, &access);
        }
        let key = target.key.as_deref().ok_or(s3::ErrorCode::NotImplemented)?;
        let reference = Reference {
            tenant,
            name: format!("{}/{key}", target.bucket),
        };
        if query(&target, "uploads").is_some() {
            if method != "POST" {
                return Err(s3::ErrorCode::NotImplemented);
            }
            if !request.body.is_empty() {
                return Err(s3::ErrorCode::InvalidRequest);
            }
            let prepared = self.prepare(&reference, &headers)?;
            let checksum = match headers
                .get("x-amz-checksum-algorithm")
                .or_else(|| headers.get("x-amz-sdk-checksum-algorithm"))
            {
                None => MultipartChecksum::None,
                Some("SHA256") => MultipartChecksum::CompositeSha256,
                Some("CRC32") => MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32),
                _ => return Err(s3::ErrorCode::InvalidRequest),
            };
            validate_checksum_type(&headers, checksum)?;
            let id = self
                .mutations
                .initiate(prepared, checksum, self.time.0, &access)?;
            self.checksum.insert(id, checksum);
            return Ok(xml(format!("<InitiateMultipartUploadResult><Bucket>{}</Bucket><Key>{}</Key><UploadId>{}</UploadId></InitiateMultipartUploadResult>", escape(&target.bucket), escape(key), id.0)));
        }
        if query(&target, "uploadId").is_some() {
            let id = UploadId(number(&target, "uploadId", 0)?);
            if method == "DELETE" {
                return self.mutations.abort(&reference, id, self.time.0, &access);
            }
            if method == "GET" {
                let after = u16::try_from(number(&target, "part-number-marker", 0)?)
                    .map_err(|_| s3::ErrorCode::InvalidArgument)?;
                let limit = usize::try_from(number(&target, "max-parts", 100)?)
                    .map_err(|_| s3::ErrorCode::InvalidArgument)?;
                let page = self.mutations.list_parts(
                    &reference,
                    id,
                    after,
                    limit,
                    self.time.0,
                    &access,
                )?;
                let mut body = format!("<ListPartsResult><Bucket>{}</Bucket><Key>{}</Key><UploadId>{}</UploadId><IsTruncated>{}</IsTruncated>", escape(&target.bucket), escape(key), id.0, page.next.is_some());
                if let Some(next) = page.next {
                    body.push_str(&format!(
                        "<NextPartNumberMarker>{next}</NextPartNumberMarker>"
                    ));
                }
                for part in page.entries {
                    body.push_str(&format!(
                        "<Part><PartNumber>{}</PartNumber><ETag>{}</ETag><Size>{}</Size></Part>",
                        part.evidence.number,
                        escape(&part.evidence.etag),
                        part.length
                    ));
                }
                body.push_str("</ListPartsResult>");
                return Ok(xml(body));
            }
            if method == "PUT" {
                let part = u16::try_from(number(&target, "partNumber", 0)?)
                    .map_err(|_| s3::ErrorCode::InvalidArgument)?;
                if headers.get("x-amz-copy-source").is_some() {
                    if !request.body.is_empty()
                        || headers.get("x-amz-checksum-algorithm").is_some()
                        || headers.get("x-amz-sdk-checksum-algorithm").is_some()
                    {
                        return Err(s3::ErrorCode::InvalidRequest);
                    }
                    let _ = ValidatedBody::new(request.body.clone(), &headers, &verified, &p)?;
                    let source = self.copy_source(tenant, &headers, &p, &access)?;
                    let range = headers
                        .get("x-amz-copy-source-range")
                        .map(copy_range)
                        .transpose()?;
                    let evidence = self.mutations.upload_part_copy_with_cache(
                        &reference,
                        id,
                        part,
                        source,
                        range,
                        self.time.0,
                        &access,
                        Some(&mut self.io),
                    )?;
                    let checksum = evidence.checksum.map_or(String::new(), |bytes| {
                        let algorithm = if self.checksum.get(&id)
                            == Some(&MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32))
                        {
                            "CRC32"
                        } else {
                            "SHA256"
                        };
                        format!(
                            "<Checksum{algorithm}>{}</Checksum{algorithm}>",
                            STANDARD.encode(bytes)
                        )
                    });
                    return Ok(xml(format!(
                        "<CopyPartResult><ETag>{}</ETag>{checksum}</CopyPartResult>",
                        escape(&evidence.etag)
                    )));
                }
                let body = ValidatedBody::new(request.body.clone(), &headers, &verified, &p)?;
                let evidence =
                    self.mutations
                        .upload_part(&reference, id, part, body, self.time.0, &access)?;
                let mut response = xml(String::new());
                response.headers.push(("etag".into(), evidence.etag));
                if let Some(value) = evidence.checksum {
                    let algorithm = self.checksum.get(&id).ok_or(s3::ErrorCode::NoSuchUpload)?;
                    let name =
                        if *algorithm == MultipartChecksum::Full(s3::ChecksumAlgorithm::Crc32) {
                            "x-amz-checksum-crc32"
                        } else {
                            "x-amz-checksum-sha256"
                        };
                    response.headers.push((name.into(), STANDARD.encode(value)));
                }
                return Ok(response);
            }
            if method == "POST" {
                self.admit_commit()?;
                let checksum = *self.checksum.get(&id).ok_or(s3::ErrorCode::NoSuchUpload)?;
                validate_checksum_type(&headers, checksum)?;
                // The producer's composite SHA256 contract accepts per-part XML
                // evidence, not a full-object SHA256 completion header. Never drop it.
                if headers.get("x-amz-checksum-sha256").is_some() {
                    return Err(s3::ErrorCode::InvalidRequest);
                }
                let payload_fields: Vec<_> = fields
                    .iter()
                    .copied()
                    .filter(|(n, _)| {
                        !n.eq_ignore_ascii_case("x-amz-checksum-crc32")
                            && !n.eq_ignore_ascii_case("x-amz-checksum-type")
                    })
                    .collect();
                let payload_headers = s3::Headers::new(&payload_fields, &p)?;
                let _ = ValidatedBody::new(request.body.clone(), &payload_headers, &verified, &p)?;
                let parts = parse_complete(&request.body, &p, 100, checksum)?;
                let full = headers
                    .get("x-amz-checksum-crc32")
                    .map(|v| STANDARD.decode(v).map_err(|_| s3::ErrorCode::InvalidDigest))
                    .transpose()?;
                let result =
                    self.mutations
                        .complete(&reference, id, parts, full, self.time.0, &access)?;
                self.commits += 1;
                return result.complete_response(&target, &p);
            }
            return Err(s3::ErrorCode::InvalidRequest);
        }
        match method {
            "DELETE" => self.mutations.delete(
                &reference,
                &DestinationConditions::from_headers(&headers)?,
                self.time.0,
                &access,
            ),
            "PUT" => {
                self.admit_commit()?;
                let prepared = self.prepare(&reference, &headers)?;
                let result = if headers.get("x-amz-copy-source").is_some() {
                    // Copy reuses verified source checksums; selection/recomputation
                    // is not implemented by this fixture and must not be ignored.
                    if !request.body.is_empty()
                        || headers.get("x-amz-checksum-algorithm").is_some()
                        || headers.get("x-amz-sdk-checksum-algorithm").is_some()
                    {
                        return Err(s3::ErrorCode::InvalidRequest);
                    }
                    let _ = ValidatedBody::new(request.body.clone(), &headers, &verified, &p)?;
                    let source = self.copy_source(tenant, &headers, &p, &access)?;
                    self.mutations
                        .copy_object_with_cache(
                            prepared,
                            source,
                            MetadataDirective::parse(headers.get("x-amz-metadata-directive"))?,
                            self.time.0,
                            &access,
                            Some(&mut self.io),
                        )?
                        .copy_response()
                } else {
                    let body = ValidatedBody::new(request.body.clone(), &headers, &verified, &p)?;
                    self.mutations
                        .put(prepared, body, self.time.0, &access)?
                        .put_response()
                };
                self.commits += 1;
                Ok(result)
            }
            _ => Err(s3::ErrorCode::NotImplemented),
        }
    }

    fn copy_source(
        &self,
        tenant: TenantId,
        headers: &s3::Headers,
        p: &s3::Policy,
        access: &Access,
    ) -> s3::Result<CopySource> {
        let source = CopySource::target(headers, p)?;
        let name = format!(
            "{}/{}",
            source.bucket,
            source.key.as_deref().ok_or(s3::ErrorCode::InvalidRequest)?
        );
        let view = self
            .mutations
            .catalogue()
            .lookup(tenant, &name, self.time.0, access)
            .map_err(|_| s3::ErrorCode::AccessDenied)?;
        CopySource::from_headers(tenant, view.generation, headers, p)
    }

    fn list_uploads(&self, target: &s3::Target, access: &Access) -> s3::Result<s3::Response> {
        if query(target, "delimiter").is_some() || query(target, "encoding-type").is_some() {
            return Err(s3::ErrorCode::NotImplemented);
        }
        let max = usize::try_from(number(target, "max-uploads", 64)?)
            .map_err(|_| s3::ErrorCode::InvalidArgument)?;
        if max == 0 || max > 64 {
            return Err(s3::ErrorCode::InvalidArgument);
        }
        let prefix = query(target, "prefix").unwrap_or("");
        let bucket = format!("{}/", target.bucket);
        let key_marker = query(target, "key-marker").unwrap_or("");
        let id_marker = query(target, "upload-id-marker");
        if id_marker.is_some() && key_marker.is_empty() {
            return Err(s3::ErrorCode::InvalidArgument);
        }
        let marker = number(target, "upload-id-marker", 0)?;
        // The producer orders by upload identity. Scan at most the fixture's 64
        // session slots, then render S3's key/upload-id marker order explicitly.
        let mut entries = self
            .mutations
            .list_uploads(
                access.tenant,
                &format!("{bucket}{prefix}"),
                0,
                64,
                self.time.0,
                access,
            )?
            .entries;
        entries.sort_by(|a, b| (&a.reference.name, a.id.0).cmp(&(&b.reference.name, b.id.0)));
        entries.retain(|u| {
            let key = u.reference.name.strip_prefix(&bucket).unwrap();
            key_marker.is_empty()
                || key > key_marker
                || (key == key_marker && id_marker.is_some() && u.id.0 > marker)
        });
        let truncated = entries.len() > max;
        entries.truncate(max);
        let mut body = format!("<ListMultipartUploadsResult><Bucket>{}</Bucket><Prefix>{}</Prefix><KeyMarker>{}</KeyMarker><UploadIdMarker>{}</UploadIdMarker><MaxUploads>{max}</MaxUploads><IsTruncated>{truncated}</IsTruncated>", escape(&target.bucket), escape(prefix), escape(key_marker), escape(id_marker.unwrap_or("")));
        if truncated {
            let last = entries.last().unwrap();
            body.push_str(&format!(
                "<NextKeyMarker>{}</NextKeyMarker><NextUploadIdMarker>{}</NextUploadIdMarker>",
                escape(last.reference.name.strip_prefix(&bucket).unwrap()),
                last.id.0
            ));
        }
        for upload in entries {
            body.push_str(&format!("<Upload><Key>{}</Key><UploadId>{}</UploadId><StorageClass>GLACIER</StorageClass></Upload>", escape(upload.reference.name.strip_prefix(&bucket).unwrap()), upload.id.0));
        }
        body.push_str("</ListMultipartUploadsResult>");
        Ok(xml(body))
    }

    fn prepare(&self, reference: &Reference, headers: &s3::Headers) -> s3::Result<PreparedWrite> {
        let access = Access {
            tenant: reference.tenant,
            revoked: self.revoked,
        };
        self.mutations.prepare(
            reference.clone(),
            UploadMetadata::from_headers(
                headers,
                "synthetic-recovery-not-crypto".into(),
                "unqualified-opaque-fixture".into(),
            )?,
            DestinationConditions::from_headers(headers)?,
            headers.get("x-amz-storage-class"),
            self.time.0,
            &access,
        )
    }

    fn admit_commit(&self) -> s3::Result<()> {
        if self.commits >= MAX_COMMITS || self.mutations.retained_bytes(TENANT) >= 8 * MAX_OBJECT {
            Err(s3::ErrorCode::SlowDown)
        } else {
            Ok(())
        }
    }

    fn evict(&mut self, access: &Access) -> qerith_core::catalogue::Result<()> {
        // Validate every candidate before publishing a deletion or touching bytes.
        let mut candidates = Vec::new();
        for &generation in self.io.spools.keys() {
            let view = self.mutations.catalogue().generation(TENANT, generation)?;
            let Some(location) = view.cache_location else {
                continue;
            };
            let candidate = self.mutations.catalogue().candidate(
                TENANT,
                generation,
                DeletionKind::DeliveryCache,
                self.time.0,
                self.time.0 + 1,
                access,
            )?;
            candidates.push((location, candidate));
        }
        self.time.0 += 1;
        for (location, candidate) in candidates {
            let event = self.mutations.catalogue_worker().finalize_deletion(
                candidate,
                self.time.0,
                access,
            )?;
            if location.starts_with("fixture/") {
                self.mutations
                    .delete_retained(TENANT, event, self.time.0, access)?;
                self.io.forget_location(&location);
            } else {
                self.io.delete_delivery(
                    self.mutations.catalogue_worker(),
                    TENANT,
                    event,
                    self.time.0,
                    access,
                )?;
            }
        }
        Ok(())
    }

    async fn control(&mut self, command: &str, body: &[u8]) -> s3::Response {
        let access = Access {
            tenant: TENANT,
            revoked: self.revoked,
        };
        match command {
            "configure" => {
                let v: serde_json::Value = serde_json::from_slice(body).unwrap();
                let host = v["host"].as_str().unwrap();
                assert!(host.starts_with("localhost:") || host.starts_with("127.0.0.1:"));
                if let Some(existing) = &self.host {
                    assert_eq!(existing, host);
                }
                self.host = Some(host.into());
            }
            "archive" | "post" => {
                let events = self.mutations.catalogue().outbox(TENANT);
                for event in events {
                    let Effect::RunJob(job) = event.effect else {
                        continue;
                    };
                    if job.kind != JobKind::Archive
                        || self
                            .mutations
                            .catalogue()
                            .job(TENANT, job.id)
                            .unwrap()
                            .state
                            == JobState::Complete
                    {
                        continue;
                    }
                    assert!(self.io.spools.len() < MAX_COMMITS);
                    let bytes = self
                        .mutations
                        .retained_for_archive(TENANT, job.generation)
                        .unwrap()
                        .to_vec();
                    self.io.register(job.generation, bytes).await;
                    composition::run_once(
                        self.mutations.catalogue_worker(),
                        &mut self.io,
                        TENANT,
                        event.id,
                        &composition::Budget::new(MAX_OBJECT as u64, 1024, 3, 120).unwrap(),
                        &self.time,
                        &Rules,
                        &SimulatedQualification,
                        &access,
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        self.mutations
                            .catalogue()
                            .job(TENANT, job.id)
                            .unwrap()
                            .state,
                        JobState::Complete
                    );
                }
                if command == "archive" {
                    // The catalogue's minimum seven-day retention AND exact-G
                    // pair proof are required. Only the fixture clock advances.
                    self.time.0 += 7 * 86400 + 1;
                    if let Err(error) = self.evict(&access) {
                        self.events.push(
                            json!({"control":"archive", "eviction_refused":format!("{error:?}")}),
                        );
                        return s3::ErrorCode::InvalidObjectState
                            .response(false, "eviction-refused");
                    }
                    assert_eq!(self.mutations.retained_bytes(TENANT), 0);
                    self.io.assert_empty();
                    self.events.push(json!({"control":"archive", "empty_cache":true, "independence":"SIMULATED", "generations":self.io.spools.len()}));
                }
            }
            "restore" => {
                let events = self.mutations.catalogue().outbox(TENANT);
                for event in events {
                    let Effect::RunJob(job) = event.effect else {
                        continue;
                    };
                    if job.kind != JobKind::Restore {
                        continue;
                    }
                    let current = self.mutations.catalogue().job(TENANT, job.id).unwrap();
                    if matches!(
                        current.state,
                        JobState::Complete
                            | JobState::FailedUnrecoverable
                            | JobState::Cancelled
                            | JobState::Expired
                    ) {
                        continue;
                    }
                    let result = composition::run_once(
                        self.mutations.catalogue_worker(),
                        &mut self.io,
                        TENANT,
                        event.id,
                        &composition::Budget::new(MAX_OBJECT as u64, 1024, 3, 120).unwrap(),
                        &self.time,
                        &Rules,
                        &SimulatedQualification,
                        &access,
                    )
                    .await;
                    self.events.push(json!({"control":"restore", "generation":job.generation.0, "result":format!("{result:?}")}));
                }
            }
            "evict" => {
                if let Err(error) = self.evict(&access) {
                    self.events
                        .push(json!({"control":"evict", "eviction_refused":format!("{error:?}")}));
                    return s3::ErrorCode::InvalidObjectState.response(false, "eviction-refused");
                }
                self.io.assert_empty();
            }
            "expire" => self.time.0 += 8 * 86400,
            "restart" => {
                self.mutations = self.mutations.clone();
                self.events
                    .push(json!({"control":"restart", "durability":"in-memory clone only"}));
            }
            "reset" => {
                // Fixture-only teardown between client profiles; this is neither
                // product deletion nor evidence of archive erasure.
                let host = self.host.clone();
                let snapshot = self.trace_snapshot();
                let mut history = std::mem::take(&mut self.trace_history);
                history.push(snapshot);
                let events = std::mem::take(&mut self.events);
                let requests = self.requests;
                *self = Self::new(self.secret.clone());
                self.host = host;
                self.trace_history = history;
                self.events = events;
                self.requests = requests;
            }
            "fail" => self.io.fail = true,
            "revoke" => self.revoked = true,
            "allow" => self.revoked = false,
            _ => return s3::ErrorCode::InvalidRequest.response(false, "control"),
        }
        let mut response = xml(String::new());
        response.headers = vec![("content-type".into(), "application/json".into())];
        response.body = serde_json::to_vec(&json!({"ok":true, "requests":self.requests, "commits":self.commits, "retained_bytes":self.mutations.retained_bytes(TENANT), "cold_retrievals":self.io.cold_retrievals, "simulated_backbones":true, "domain_time":self.time.0})).unwrap();
        response
    }

    fn trace_snapshot(&self) -> serde_json::Value {
        json!({"schema":"qerith.synthetic-archive-trace.v1", "events":self.events, "engine_trace":format!("{:?}", self.io.trace), "cold_retrievals":self.io.cold_retrievals, "retained_bytes":self.mutations.retained_bytes(TENANT), "simulated_backbones":true})
    }

    pub fn save_trace(&self) {
        if let Ok(dir) = std::env::var("QERITH_CLIENT_EVIDENCE_DIR") {
            std::fs::create_dir_all(&dir).unwrap();
            let trace = self.trace_snapshot();
            // Episode zero is configuration before the first profile reset.
            // Subsequent episodes follow the runner's declared profile order.
            for (index, snapshot) in self
                .trace_history
                .iter()
                .chain(std::iter::once(&trace))
                .enumerate()
            {
                std::fs::write(
                    std::path::Path::new(&dir)
                        .join(format!("service-trace-episode-{index:02}.json")),
                    serde_json::to_vec_pretty(snapshot).unwrap(),
                )
                .unwrap();
            }
            std::fs::write(
                std::path::Path::new(&dir).join("service-trace.json"),
                serde_json::to_vec_pretty(&trace).unwrap(),
            )
            .unwrap();
        }
    }
}

#[tokio::test]
async fn reset_preserves_each_engine_trace_episode() {
    let mut state = State::new("synthetic".into());
    state
        .io
        .trace
        .0
        .push(crate::support::Event::RepairPosted(7));
    assert_eq!(state.control("reset", b"").await.status, 200);
    assert!(state.trace_history[0]["engine_trace"]
        .as_str()
        .unwrap()
        .contains("RepairPosted(7)"));
    assert!(state.io.trace.0.is_empty());
    state
        .io
        .trace
        .0
        .push(crate::support::Event::RepairPosted(8));
    assert_eq!(state.control("reset", b"").await.status, 200);
    assert_eq!(state.trace_history.len(), 2);
    assert!(state.trace_history[1]["engine_trace"]
        .as_str()
        .unwrap()
        .contains("RepairPosted(8)"));
    assert!(state.trace_history[0]["engine_trace"]
        .as_str()
        .unwrap()
        .contains("RepairPosted(7)"));
}
