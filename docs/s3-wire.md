# Restricted archive S3 wire primitives

`qerith_core::s3` is an executable wire/validation library, not a service, storage
backend, durability implementation or certified S3 endpoint. It does not change
the immutable velmora engine pin. NNTP, TLS transport, yEnc, PAR2 and media
cryptography remain in the engine; no implementation of those mechanisms lives
here. No live providers, credentials, customer data or deployment are involved.

## Adapter boundary and ordering

1. Enforce ingress HTTP framing and trusted HTTPS. Pass the **raw, unnormalized
   origin-form request target** and original ordered header values into `Target`
   and `Headers`. Never use form decoding (`+` is not a space), URL path cleanup,
   slash merging, dot resolution or Unicode normalization. `Headers` preserves
   interior value whitespace (including quoted metadata) for semantic access,
   combines repeated list values in order, and rejects singleton duplicates.
   SigV4 whitespace folding occurs only in canonical signing input. All retained
   content/cache metadata fields must be signed, with a shared field classifier.
   `ObjectMetadata` shares the ingress token-name and value-byte validators, requires
   lowercase names, and retains semantic values verbatim through GET/HEAD plans.
   Interior TAB and token punctuation are allowed; CR/LF, other controls, DEL and
   non-ASCII header bytes are rejected at both ingress and stored-metadata boundaries.
   HTTP/2 adapters map
   the trusted `:authority` to one Host field and reject conflicting authority.
2. `verify` validates local SigV4 header/presign authentication against an explicit
   endpoint/region and caller clock. `Authority` resolves only local permanent
   signing credentials and enforces per-principal method/bucket/key authority.
   Unknown/revoked/expired credentials return None. This is not IAM/STS or an
   AWS credential gateway. No plaintext transport, anonymous, SigV2, SigV4a,
   temporary-token, policy, object-lock or server-side-encryption compatibility.
3. Authenticate and authorize **before** catalogue lookup, existence/state
   disclosure, restore queueing or staging allocation. Resolve and pin immutable
   generation G. Missing-key disclosure is the adapter's listing-permission
   decision (404 NoSuchKey vs 403 AccessDenied). No physical cache hit grants a
   logical reference a lease. A `VerifiedRequest` is for the request just checked,
   not an independently transferable permission or a body-integrity receipt.
4. Reject operation-specific unknown shapes before effects. The feature allow
   lists only identify possible supported knobs: adapters must still validate
   operation placement, copy source/conditions, multipart, pagination and commit
   semantics. Recognized unimplemented operations return 501; unsupported feature
   options return 400. `parse_restore` implements strict bounded regular restore
   XML; it rejects DTD/entities, duplicate/unknown elements or attributes, select,
   output-location, unqualified Days and tiers. Only Standard is admitted.
5. For writes, create `UploadValidator` from the **same request's** headers and
   authentication. Stage only `push_decoded` bytes C, never HTTP chunk syntax or
   NNTP/yEnc framing. Commit only after `finish` succeeds and the adapter atomically
   commits C, G, metadata and a recoverable archival obligation. A receipt is not
   a durable commit or proof that arbitrary uploaded bytes are approved ciphertext.
   Abandoned/failed staging must be discarded. Recheck authority before commit.
6. For authorized GET/HEAD, resolve G and validate input, then `plan_read` evaluates
   conditions, range and only then cold state. A matching ETag suppresses
   If-Unmodified-Since; If-None-Match suppresses If-Modified-Since. HTTP-date
   parsing supports IMF-fixdate, RFC 850 and asctime; invalid dates are ignored.
   The existing chrono calendar parser handles four-digit pre-1970 dates that
   httpdate 1.0.3 cannot represent, retaining signed epoch seconds, weekday and
   grammar validation. The normal three-format parser is unchanged.
   Bodyless 304 retains the corresponding Cache-Control and Expires metadata. Applicable 304/412/416 precede cold 403. Multiple ranges are 400.
   HEAD is always bodyless; satisfiable HEAD Range changes Content-Length but
   keeps status 200. GET range is inclusive, clamped, 206 and exact slice of C.
7. Recheck current authority at queue/publication/serving admission, including
   revocation, and bind the read/restore lease to logical reference + G. The
   library's `recheck` hook assists but does not implement revocation fencing,
   in-flight transfer limits or catalogue atomicity. Downstream adapters own
   these invariants; no tenant/session database or scheduler is selected here.

## Deliberate restricted framing/integrity profile

Initial accepted upload framing is an explicit, bounded Content-Length (including
zero), optionally signed SHA256 payload hash and/or canonical Base64 Content-MD5,
SHA256 or CRC32. Negotiation must match the supplied checksum; mismatches cannot
produce a validation receipt. MD5 is legacy transport integrity only, never an
ETag, authentication, dedupe identity or encryption primitive. HMAC comparison
uses the maintained primitive's verification API; body checks use constant-time
equality. All signing and payload modes require trusted HTTPS, including
UNSIGNED-PAYLOAD. A signed payload hash is verified on decoded C, not merely
trusted because the Authorization signature matched.

Transfer-Encoding, trailers, aws-chunked and STREAMING-* payload markers are
**rejected**, not ignored or accepted as object bytes. This is a restricted
profile, not unchanged-default/current-CRT streaming compatibility. CRC32C,
CRC64NVME, SHA1, multipart checksum ingestion and other requested integrity
variants are also rejected pending qualification, never silently disabled.

Stored ETags are quoted opaque generation-bound validators. They are not
recomputed on restore. FULL_OBJECT checksums are distinct from SHA256 COMPOSITE
(SHA256 of concatenated binary part digests with a `-partCount` suffix); composite
part evidence remains stored with G. A range omits full-object checksum headers.
The metadata value is a portable reference type, not proof the backing bytes
were verified or durably stored.

## Archive B only

Storage class omitted or exactly GLACIER means the disclosed archive default;
STANDARD and all unqualified classes fail. Upload never grants restored access.
HEAD remains metadata-only; GET without a valid logical-reference + G lease is
403 InvalidObjectState, even if safety bytes remain. GET starts no implicit job.
Restore status rendering provides pending/completed/expired headers, not lease
creation or renewal. Expiry calculation, queueing, generation fences, verified
whole-generation publication and monotonic lease renewal belong to the lifecycle
adapter. Restore preserves C, N, G, ETag, metadata and checksum/part evidence.

There is **no Default policy** and no production number is selected. A caller must
supply and validate target/XML/header/query/upload bounds, admitted minimum and
maximum Days, clock skew and presign TTL. The SigV4 protocol ceiling is seven
days; the explicit policy may be stricter. The fixture values are synthetic only.
Presigns expire at `now >= signedTime + TTL`; skew permits future-dated signatures
only within the explicit bound and never extends expiry. Revocation still wins.

R2 eviction, two-independent-backbone full reconstruction/integrity proof,
OPRF/encryption composition, plaintext authentication and recoverability remain
separate gates. Neither transport digests nor a green static fixture prove those
properties. No online/hot-only or plaintext-gateway profile is introduced.

## Static source and vector baselines (not certified clients)

- Botocore **1.34.46**, commit
  `fdee2825e01b4c3e7bc7c6f21ee384bebf7b9e0c`:
  [S3 signer and presigner](https://github.com/boto/botocore/blob/fdee2825e01b4c3e7bc7c6f21ee384bebf7b9e0c/botocore/auth.py),
  [published S3 presign test](https://github.com/boto/botocore/blob/fdee2825e01b4c3e7bc7c6f21ee384bebf7b9e0c/tests/unit/auth/test_signers.py).
  The published signature `ac1b8b9e...7201db66` is an independent golden in unit
  tests. Its dummy myservice/myregion are test-only, never allowed in production.
- [RFC 4231 §4.2](https://www.rfc-editor.org/rfc/rfc4231#section-4.2), published
  HMAC-SHA256 case 1, independently checks the maintained primitive.
- `scripts/s3-static-vectors.py` uses installed Botocore exactly 1.34.46 to produce
  the committed `tests/fixtures/s3-static.json`. No network or provider requests.
  The corpus covers header/presign, GET/PUT/HEAD, Unicode escapes, raw plus/percent,
  repeated/empty/case-sensitive query fields, dot/slash preservation and header
  whitespace. Repeated unknown application selectors are canonical-only fixtures;
  actual verification rejects ambiguous or unqualified semantics. Regeneration
  requires that SDK version, not a workspace dependency install or moving latest.
- S3 URI and already-wire-encoded query canonicalization follow that SDK's S3
  signer: preserve encoded path and encoded query component spelling, sort query
  pairs and preserve repeats/empty values. No generic URL normalization. Both
  wire and decoded query representations are retained to prevent semantic alias
  confusion. The adapter does not get to silently use last-wins parsing.
- Current operation references remain
  [GET](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html),
  [HEAD](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html),
  [RestoreObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_RestoreObject.html).
  Those moving docs are background, not pinned runtime evidence. The executable
  assertions define this restricted profile; no observed AWS-equivalence claim.

`tests/fixtures/published-crypto.json` keeps the RFC and pinned Botocore public
keys and expected outputs as data, decoded by the two unit tests. No runtime key
literal is embedded at a cryptographic call site; both independent known-answer
assertions remain active. CodeQL configuration, queries and required gates are
unchanged; no alert dismissal or analysis exclusion is used.

Fixture secrets are public documentation examples, not usable credentials.
There is no AWS CLI, Boto3, rclone, CRT, shipped-client, default-settings or live
cold-restore certification. Such qualification needs exact client/build/OS and
settings plus real archive and cold-miss evidence under separate authorization.

## Supply-chain inventory

Cargo 1.99.1 was used only for locked source fetching/metadata resolution, not a
local build or full suite. Rust 1.89 remains the MSRV; native, wasm32 (scalar and
Worker transport), clippy, tests and cargo-deny are enforced by the existing
GitHub Actions workflow, including `ci-ok`. No workflow/pin policy is weakened.

Cargo has no stable native release-age filter or blanket build.rs/proc-macro
refusal. `--locked`/`--offline` are not equivalent controls. Those gaps remain
explicit: resolve from crates.io only, commit integrity checksums, inspect exact
added sources/hooks, and build in Actions rather than on the shared host.
No package-manager configuration pretending to enforce unsupported keys is added.

New locked packages (registry publication times inspected 2026-11-07; all older
than three days):

| Package | Version | Published UTC | Hooks / scope |
| --- | --- | --- | --- |
| base64 | 0.22.1 | 2024-04-30T23:16:40Z | No build.rs/proc macros; strict canonical Base64 |
| hmac | 0.13.0 | 2026-03-29T23:19:21Z | build=false; RustCrypto HMAC over existing sha2 0.11.1 |
| ctutils | 0.4.8 | 2026-11-02T20:07:29Z | build=false; digest's maintained constant-time verification |
| cmov | 0.5.4 | 2026-05-28T19:07:33Z | build=false; ctutils portable/architecture primitive dependency |
| httpdate | 1.0.3 | 2023-08-13T10:55:54Z | No build.rs/proc macros or runtime dependencies; all three HTTP-date formats |

Exact SHA256 integrity is in Cargo.lock. Existing chrono 0.4.45 (std only, no
clock/timezone runtime), crc32fast 1.5.3, md5 0.8.1, quick-xml 0.42.0, sha2 0.11.1,
subtle 2.6.1 and dev-only serde_json 1.0.154 become explicit dependencies without
version changes. Existing graph native TLS build scripts and proc macros remain
unchanged; no new lifecycle/build-hook exception is granted. No new Git source,
credentials, engine rev, resolver, database, paid service or package manager.
Clean full build/test evidence must be exact-head Actions links; local fixture
generation is only static evidence, not CI. Required advisory/license/source
results are accepted only when the existing cargo-deny job is green.

REA angle: source-first reuse of the pinned maintained SDK signer and published
vectors, not copied server code, a handwritten cryptographic primitive, a second
engine, a new scheduler or live-client qualification.
