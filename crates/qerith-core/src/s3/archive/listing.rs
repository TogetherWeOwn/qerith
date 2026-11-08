use super::{iso_date, xml_response, Adapter, ErrorCode, Response, Result, Session, Target};
use crate::catalogue::{ArchiveReadPort, BucketView, ReferenceView, TenantId};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenScope {
    pub tenant: TenantId,
    pub principal: String,
    pub bucket: String,
    pub incarnation: u64,
    pub prefix: String,
    pub delimiter: String,
    pub start_after: Option<String>,
    pub url_encoding: bool,
}
#[derive(Clone, Debug)]
pub struct Cursor {
    pub after: String,
    pub skip_prefix: Option<String>,
}

/// Tokens are opaque server-issued handles, not client-controlled key cursors.
/// Production implementations use unguessable handles, bounded lifetime/storage,
/// current scope checks and restart persistence (or explicitly expired tokens).
pub trait TokenPort {
    fn issue(&mut self, scope: TokenScope, cursor: Cursor, now: u64) -> Result<String>;
    fn resolve(&self, token: &str, scope: &TokenScope, now: u64) -> Result<Cursor>;
}

/// Non-durable fixture only: predictable handles are NOT production credentials.
/// Scope checks, lifetime and capacity are still enforced; expired entries are
/// reclaimed at issuance, never an unbounded per-page resource leak.
pub struct MemoryTokens {
    entries: BTreeMap<String, (TokenScope, Cursor, u64)>,
    sequence: u64,
    capacity: usize,
    ttl: u64,
}
impl MemoryTokens {
    pub fn new(capacity: usize, ttl: u64) -> Result<Self> {
        if capacity == 0 || ttl == 0 {
            return Err(ErrorCode::InvalidArgument);
        }
        Ok(Self {
            entries: BTreeMap::new(),
            sequence: 0,
            capacity,
            ttl,
        })
    }
}
impl TokenPort for MemoryTokens {
    fn issue(&mut self, scope: TokenScope, cursor: Cursor, now: u64) -> Result<String> {
        self.entries.retain(|_, (_, _, until)| *until > now);
        if self.entries.len() >= self.capacity {
            return Err(ErrorCode::SlowDown);
        }
        let until = now
            .checked_add(self.ttl)
            .ok_or(ErrorCode::InvalidArgument)?;
        self.sequence = self.sequence.checked_add(1).ok_or(ErrorCode::SlowDown)?;
        let token = format!("fixture-opaque-{:016x}", self.sequence);
        self.entries.insert(token.clone(), (scope, cursor, until));
        Ok(token)
    }
    fn resolve(&self, token: &str, scope: &TokenScope, now: u64) -> Result<Cursor> {
        self.entries
            .get(token)
            .filter(|(s, _, until)| s == scope && *until > now)
            .map(|(_, c, _)| c.clone())
            .ok_or(ErrorCode::InvalidArgument)
    }
}

impl<C: ArchiveReadPort, T: TokenPort> Adapter<C, T> {
    pub(super) fn list(
        &mut self,
        target: &Target,
        session: &impl Session,
        bucket: &BucketView,
        now: u64,
    ) -> Result<Response> {
        let max = target
            .one("max-keys")?
            .map(super::super::decimal)
            .transpose()?
            .unwrap_or(1000);
        if max > 1000 {
            return Err(ErrorCode::InvalidArgument);
        }
        let encoding = target.one("encoding-type")?;
        if !matches!(encoding, None | Some("url")) {
            return Err(ErrorCode::InvalidArgument);
        }
        let scope = TokenScope {
            tenant: session.tenant(),
            principal: session.principal().into(),
            bucket: bucket.name.clone(),
            incarnation: bucket.incarnation,
            prefix: target.one("prefix")?.unwrap_or("").into(),
            delimiter: target.one("delimiter")?.unwrap_or("").into(),
            start_after: target.one("start-after")?.map(str::to_owned),
            url_encoding: encoding.is_some(),
        };
        let token = target.one("continuation-token")?;
        let mut cursor = if let Some(token) = token {
            self.tokens.resolve(token, &scope, now)?
        } else {
            Cursor {
                after: scope.start_after.clone().unwrap_or_default(),
                skip_prefix: None,
            }
        };
        let namespace = format!("{}/", bucket.name);
        let prefix = format!("{namespace}{}", scope.prefix);
        let mut after = if token.is_some() || scope.start_after.is_some() {
            Some(format!("{namespace}{}", cursor.after))
        } else {
            None
        };
        let mut entries: Vec<(String, Option<ReferenceView>, Cursor)> = Vec::new();
        if max > 0 {
            'scan: loop {
                let batch = self
                    .catalogue
                    .list_references(
                        session.tenant(),
                        &prefix,
                        after.as_deref(),
                        self.limits.scan_batch,
                        now,
                        session,
                    )
                    .map_err(super::catalogue_error)?;
                let short = batch.len() < self.limits.scan_batch;
                if batch.is_empty() {
                    break;
                }
                for (name, view) in batch {
                    after = Some(name.clone());
                    let key = name
                        .strip_prefix(&namespace)
                        .ok_or(ErrorCode::InternalError)?
                        .to_owned();
                    if cursor
                        .skip_prefix
                        .as_ref()
                        .is_some_and(|p| key.starts_with(p))
                    {
                        continue;
                    }
                    cursor.skip_prefix = None;
                    let common = if scope.delimiter.is_empty() {
                        None
                    } else {
                        key[scope.prefix.len()..].find(&scope.delimiter).map(|i| {
                            key[..scope.prefix.len() + i + scope.delimiter.len()].to_owned()
                        })
                    };
                    if common
                        .as_ref()
                        .is_some_and(|p| scope.start_after.as_ref().is_some_and(|a| p <= a))
                    {
                        continue;
                    }
                    cursor = Cursor {
                        after: key.clone(),
                        skip_prefix: common.clone(),
                    };
                    if let Some(common) = common {
                        entries.push((common, None, cursor.clone()));
                    } else {
                        entries.push((key, Some(view), cursor.clone()));
                    }
                    if entries.len() > max as usize {
                        break 'scan;
                    }
                }
                if short {
                    break;
                }
            }
        }
        let truncated = entries.len() > max as usize;
        if truncated {
            entries.pop();
        }
        let next = if truncated {
            Some(self.tokens.issue(
                scope.clone(),
                entries.last().ok_or(ErrorCode::InternalError)?.2.clone(),
                now,
            )?)
        } else {
            None
        };
        // XML 1.0 cannot represent every valid UTF-8 object key. Require URL
        // encoding for those pages; do not replace/control-normalize key bytes.
        let field = |s: &str| -> Result<String> {
            if scope.url_encoding {
                Ok(super::super::xml(&url_encode(s)))
            } else if s.chars().all(xml_character) {
                Ok(super::super::xml(s))
            } else {
                Err(ErrorCode::InvalidArgument)
            }
        };
        let mut xml = format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{}</Name><Prefix>{}</Prefix><KeyCount>{}</KeyCount><MaxKeys>{max}</MaxKeys><IsTruncated>{truncated}</IsTruncated>", super::super::xml(&bucket.name), field(&scope.prefix)?, entries.len());
        if !scope.delimiter.is_empty() {
            xml.push_str(&format!(
                "<Delimiter>{}</Delimiter>",
                field(&scope.delimiter)?
            ));
        }
        if let Some(start) = &scope.start_after {
            xml.push_str(&format!("<StartAfter>{}</StartAfter>", field(start)?));
        }
        if scope.url_encoding {
            xml.push_str("<EncodingType>url</EncodingType>");
        }
        if let Some(token) = token {
            xml.push_str(&format!(
                "<ContinuationToken>{}</ContinuationToken>",
                super::super::xml(token)
            ));
        }
        if let Some(next) = next {
            xml.push_str(&format!(
                "<NextContinuationToken>{}</NextContinuationToken>",
                super::super::xml(&next)
            ));
        }
        for (key, view, _) in entries {
            if let Some(view) = view {
                xml.push_str(&format!("<Contents><Key>{}</Key><LastModified>{}</LastModified><ETag>{}</ETag><Size>{}</Size><StorageClass>GLACIER</StorageClass></Contents>", field(&key)?, iso_date(view.metadata.modified_at)?, super::super::xml(&view.metadata.validator), view.metadata.identity.length));
            } else {
                xml.push_str(&format!(
                    "<CommonPrefixes><Prefix>{}</Prefix></CommonPrefixes>",
                    field(&key)?
                ));
            }
        }
        xml.push_str("</ListBucketResult>");
        Ok(xml_response(xml))
    }
}
fn xml_character(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}
fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
