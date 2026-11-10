use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use qerith_core::s3::{self, mutation::ValidatedBody};
use sha2::{Digest, Sha256};

const NOW: i64 = 1369353600;

struct WireAuth {
    secret: [u8; 32],
}
impl WireAuth {
    fn new() -> Self {
        use std::io::Read;
        let mut secret = [0; 32];
        // Linux CI fixture only: fresh OS entropy, no service credential or I/O
        // beyond the local random device. Never suppress the key-analysis rule.
        std::fs::File::open("/dev/urandom")
            .unwrap()
            .read_exact(&mut secret)
            .unwrap();
        Self { secret }
    }
}
impl s3::Authority for WireAuth {
    fn credential(&self, _: &str) -> Option<s3::Credential<'_>> {
        Some(s3::Credential {
            principal: "fixture",
            secret: &self.secret,
        })
    }
    fn authorize(&self, _: &str, _: &str, _: &s3::Target) -> bool {
        true
    }
}
pub fn policy() -> s3::Policy {
    s3::Policy::new(
        "s3.example.invalid".into(),
        "fixture".into(),
        s3::Limits {
            target_bytes: 8192,
            control_xml_bytes: 8192,
            header_bytes: 16384,
            header_count: 64,
            query_pairs: 64,
            upload_bytes: 1024,
            min_restore_days: 1,
            max_restore_days: 7,
            clock_skew_seconds: 900,
            presign_seconds: 60,
        },
    )
    .unwrap()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
pub fn body_with(
    bytes: &[u8],
    algorithm: Option<s3::ChecksumAlgorithm>,
    extra: &[(&str, &str)],
) -> s3::Result<ValidatedBody> {
    let length = bytes.len().to_string();
    let digest = match algorithm {
        Some(s3::ChecksumAlgorithm::Sha256) => STANDARD.encode(Sha256::digest(bytes)),
        Some(s3::ChecksumAlgorithm::Crc32) => STANDARD.encode(crc32fast::hash(bytes).to_be_bytes()),
        None => String::new(),
    };
    let mut fields = vec![
        ("host", "s3.example.invalid"),
        ("content-length", &length),
        ("x-amz-date", "20130524T000000Z"),
        ("x-amz-content-sha256", "UNSIGNED-PAYLOAD"),
    ];
    if let Some(a) = algorithm {
        fields.push((a.header(), &digest));
    }
    fields.extend_from_slice(extra);
    let p = policy();
    let unsigned = s3::Headers::new(&fields, &p)?;
    let target = s3::Target::parse("/bucket/key", &p)?;
    let mut names: Vec<_> = fields.iter().map(|(name, _)| *name).collect();
    names.sort_unstable();
    let signed = names.join(";");
    let canonical = s3::canonical_request(
        "PUT",
        &target,
        &unsigned,
        &signed,
        "UNSIGNED-PAYLOAD",
        false,
    )?;
    let authority = WireAuth::new();
    let signing_secret = [b"AWS4".as_slice(), authority.secret.as_slice()].concat();
    let key = hmac(
        &hmac(
            &hmac(&hmac(&signing_secret, b"20130524"), b"fixture"),
            b"s3",
        ),
        b"aws4_request",
    );
    let string = format!(
        "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/fixture/s3/aws4_request\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential=fixture/20130524/fixture/s3/aws4_request, SignedHeaders={signed}, Signature={}",
        hex(&hmac(&key, string.as_bytes()))
    );
    fields.push(("authorization", &authorization));
    let headers = s3::Headers::new(&fields, &p)?;
    let verified = s3::verify("PUT", &target, &headers, true, NOW, &p, &authority)?;
    assert_eq!(
        s3::verify("PUT", &target, &headers, true, NOW, &p, &WireAuth::new()).err(),
        Some(s3::ErrorCode::SignatureDoesNotMatch)
    );
    ValidatedBody::new(bytes.to_vec(), &headers, &verified, &p)
}
pub fn body(bytes: &[u8]) -> ValidatedBody {
    body_with(bytes, None, &[]).unwrap()
}
