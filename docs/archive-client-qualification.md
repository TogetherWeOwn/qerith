# Pinned synthetic archive-client qualification

This is an **Actions-only, synthetic, low-level S3 reference qualification**. It
is not a deployed S3 service, AWS equivalence, a live-provider/backbone test,
client-side crypto/readability proof, supplier/database durability evidence, or
rclone/high-level transfer/sync/mount certification. Arbitrary deterministic
opaque bytes are not proved ciphertext. Backbone identities and exact-generation
verification controls are simulated; they establish no real independence.

A restrictive-profile PASS never establishes default-client support. The
manifest reports each default profile independently, including red and
unqualified rows. Rows outside this slice remain explicitly unqualified; the
parent's broader native/REST/MCP, tenant/revocation/moderation, subscriber/cancel,
lost-response and production acceptance remain separate requirements.

## Fixture integration contract

The parent owns `crates/qerith-core/tests/archive_clients.rs`. CI runs:

```sh
cargo test --locked -p qerith-core --test archive_clients -- --ignored --nocapture
```

Rust starts a bounded plain-HTTP listener on a random loopback port and launches:

```text
python3 -I $QERITH_CLIENT_RUNNER --upstream http://127.0.0.1:<port> --control-token <synthetic>
```

Actions supplies these paths (all job-owned temporary resources):

- `QERITH_CLIENT_RUNNER`: absolute `scripts/archive-clients/runner.py` path.
- `QERITH_CLIENT_EVIDENCE_DIR`: public synthetic evidence only, uploaded for 7 days.
- `QERITH_CLIENT_PRIVATE_DIR`: venv, vendor installation, profile homes, TLS key/cert;
  never uploaded, deleted by an `always()` step, including failure/cancellation.
- `QERITH_CLIENT_CERT`, `QERITH_CLIENT_KEY`: one-day throwaway OpenSSL certificate
  with SAN `DNS:localhost,IP:127.0.0.1`, and private key.
- `QERITH_AWS_CLI`: absolute digest-verified vendor CLI executable.
- `QERITH_EVIDENCE_HEAD`: exact checked-out PR head or merge-queue/push SHA.

The Rust launcher supplies `AWS_ACCESS_KEY_ID=fixture` and a per-run random
synthetic `AWS_SECRET_ACCESS_KEY`. The runner rejects another access-key identity,
then explicitly forwards only those synthetic values in a minimal environment.
No session token, ambient credentials/profile, proxy, endpoint override,
`AWS_DATA_PATH`, plugin config or Python user imports are inherited. CLI debug
and byte traces are synthetic-only; debug is needed to assert actual HTTP status,
which ordinary `s3api` JSON omits. Do not repoint this fixture at real credentials.

Python terminates TLS on a random IPv4 loopback port and makes a trusted direct
control request before clients run:

```text
POST /__fixture/configure
Authorization: Bearer <synthetic control token>
Content-Type: application/json

{"host":"127.0.0.1:<TLS-port>"}
```

The Rust SigV4 policy pins that configured Host and region `us-east-1`; signing
skew uses real UTC independently of the fixture's advanceable lease clock.
The TLS relay forwards **raw byte streams**, not reconstructed HTTP requests.
Method, origin-form target, header order/case/duplicates, Host, percent encoding,
slash/dot segments, body and transfer framing are not rewritten. It does not
follow redirects or decode chunked uploads. `Expect: 100-continue` works through
bidirectional forwarding. Synthetic relay tests compare exact request/response
bytes, including encoded targets and unsupported chunk/trailer framing.

Authenticated controls return HTTP 200 with a JSON object; failed control
assertions fail qualification. Controls apply fixture-wide to eligible objects:

| Control | Required Rust-owned assertion/effect |
| --- | --- |
| `archive` | Compose archive posting, simulated exact-G verification, lawful retained eviction, and empty delivery cache; no hot-byte substitute |
| `restore` | Process pending whole-generation reconstruction/verification/publication, or record injected failure without a lease |
| `expire` | Advance trusted domain clock beyond leases; keep request-signing skew independent |
| `restart` | Clone/reconnect in-memory model while preserving pending job/state; not actual crash durability |
| `fail` | Next whole-generation restore I/O fails |

Control responses are saved as row observations; the parent fixture must assert
its own exact-G/eviction/capacity invariants, not merely return counters.

Fixture sizes are deliberately small: the main object is 272 arbitrary bytes,
two multipart parts are 256 bytes each (the fixture minimum nonfinal part must
be at most 256), and listing uses three keys with a one-key page. Main key is
`opaque/%2F +/café/../payload.bin`: once-only decoding must not change identity.
Content type, cache control, user metadata, ETag, LastModified, length and selected
checksums remain stable across restore states. Each profile uses its own bucket;
failed profiles may leave objects for process teardown, never a live service.

Copy-after-restore is a must-pass row after true retained eviction. The runner
never reuploads/warm-substitutes the source to make copy succeed. A failed copy
row is recorded as FAIL while later expiry/failure/deletion rows continue.

## Exact clients and profiles

`pins.json` records provenance and immutable build anchors. Initial pins:

- AWS CLI **2.31.23**, vendor `linux-x86_64` ZIP SHA256
  `eca61882437a815d7a7df9e70982a71cdaef0c4061cf4fb63a07726bd6dfee08`.
  Digest was obtained from the HTTPS vendor artifact before any execution.
  Vendored Botocore reports `2.0.0dev155` and S3Transfer `0.5.1`; these are the
  CLI's private SDK copies, **not** the separately installed Python wheels.
  Source tag resolves to `15a987e6645caa5e10a83504fd98c3eba9ff8dbc`;
  that revision pins CRT `0.27.6`. Runtime version, every vendor distribution file
  hash and available dist-info are archived too. The entire binary bundle,
  including Python/private dependencies, is locked by the vendor ZIP digest.
- CPython **3.12.8**, Ubuntu **24.04** x86_64 runner image (image patch contents
  are not immutable; actual platform/OpenSSL/Python build is in the manifest).
- Boto3 **1.40.61**, Botocore **1.40.61**, S3Transfer **0.14.0**, JMESPath **1.0.1**,
  python-dateutil **2.9.0.post0**, six **1.17.0**, urllib3 **2.6.3**. All transitive
  wheel hashes are in `requirements.lock`. No Boto3 CRT extra is installed;
  runtime rejects an unexpected `awscrt` package.

These historical pins define a reproducible test target, not an endorsement of
old client security support or of other builds/platforms.

| Profile | Settings and qualification policy |
| --- | --- |
| `cli-default` | Unchanged vendor checksum/framing/signing/addressing/retry defaults. Only synthetic endpoint, region, CA, credentials and JSON/no-pager output are selected. Default transport timeouts remain unchanged; 20 s per CLI process and 100 s per profile impose outer bounds. Diagnostic rows: failures never become restrictive-profile support claims. |
| `boto3-default` | Empty Botocore `Config()`, explicit synthetic endpoint/region/credentials/CA only. Default checksum/framing/signing/retry/transport settings are recorded from runtime config. Outer 100 s process bound; no default setting silently replaced. Diagnostic rows. |
| `cli-restrictive` / `boto3-restrictive` | Path addressing, SigV4 payload signing, optional checksum calculation/validation `when_required`, standard retry mode with total attempts 1, connect 2 s/read 3 s. PUT and multipart parts explicitly provide SHA256 integrity; multipart negotiates SHA256 COMPOSITE. Bytes have known fixed lengths. All declared rows must pass. |

Required checksum/signature validation is never disabled. Optional unsupported
CRC64NVME/aws-chunked/trailers stay red/unqualified rather than being translated
by the relay or silently accepted. `when_required` is **not** a global integrity
bypass: explicit SHA256 request checksums and server-side body validation remain.
The runner never edits the independent `scripts/s3-static-vectors.py` vectors;
the parent's raw SigV4 assertions remain independent of client normalization.

## Declared client rows and failure policy

The canonical ordered matrix is `scripts/archive-clients/contract.py::ROWS`.
Both restrictive profiles declare every row must-pass:

1. Bucket creation, ListBuckets/HeadBucket/location.
2. PUT, retained metadata/checksum HEAD, no immediate GET lease, cold copy denial.
3. Conditional 304 before restore and bounded encoded-key listing pagination.
4. Multipart initiation, two uploads, ListParts, completion, no immediate GET;
   abort then NoSuchUpload.
5. Archive/empty-cache control; pre-restore HEAD and 403 InvalidObjectState.
6. Restore 202; pending HEAD, GET 403, duplicate 409; reconnect simulation preserves
   pending state; explicit whole-G completion.
7. Completed HEAD, exact full GET, exact range and Content-Range; metadata/ETag/
   checksum persistence; 304/412/416 conditions.
8. Restored-source copy preserving metadata but granting no destination GET lease;
   restore renewal 200, expired HEAD with no restore header and GET 403;
   injected failed restore likewise has no lease/header.
9. Missing key/bodyless HEAD/bucket errors; nonempty bucket conflict; batch and
   single logical deletion, missing GET, empty bucket deletion.

A prerequisite failure leaves later dependent rows explicitly **unqualified**,
not passed. Copy is independent of the later restore-state rows, so its failure
is non-short-circuiting. Each row records a call-sequence range in `calls.json`;
control responses are embedded in the row. CLI stderr gives actual wire status,
raw TLS-terminated request/response streams retain exact signing input, and the
manifest hashes every evidence artifact. Unknown/missing/duplicated/relabelled
rows, a failed/unqualified restrictive row, a restrictive subprocess failure,
or a relay resource error fail the overall gate. A default failure is visible
but does not falsely convert the restrictive target into default support.

## Bounds, evidence and supply-chain controls

- Job 30 min; setup 300 s; Rust build 900 s; fixture execution 600 s with TERM and
  10 s KILL fallback. Rust separately owns request/process lifetime caps.
- Python runner 440 s; each of four profile processes 100 s; CLI calls 20 s;
  direct control calls 5 s. Worker process groups are terminated/reaped in `finally`.
  Fixture restore is one explicit control call, not an unbounded application poll.
  Listing follows at most eight pages and rejects non-advancing cursors.
- Relay at most 8 simultaneous / 1,024 lifetime connections; 45 s per connection,
  10 s idle; 8 MiB per direction per connection and 32 MiB total. No public bind.
  Response reads are bounded to 1 MiB, controls 64 KiB. Job file-size limit is
  128 MiB; normal payloads and traces are far smaller.
- `manifest.json` starts as FAIL before dependency installation, with every row
  unqualified. Thus setup/build/missing-fixture failures still have honest evidence.
  Final manifest includes exact head, pins, actual platform/inventory, settings,
  bounds, every row and artifact SHA256. The manifest itself is not self-hashed;
  the Actions artifact/run identifies it. Upload uses `always()`, retention 7 days.
- No host dependency installations. An ephemeral venv bootstraps exactly hash-pinned
  pip 26.1; the preinstalled pip lacks native age filtering, so this **single pinned
  wheel**, published 2026-04-26, is the documented bootstrap exception. Thereafter
  absolute `PIP_CONFIG_FILE=scripts/archive-clients/pip.conf` applies native `P3D`
  release age, wheel-only and required hashes. No source builds/install hooks are
  needed; wheels execute only in the Actions-owned runtime. Missing wheels fail.
  Clean install, `pip check`, freeze/config and actual client execution are Actions
  evidence, not presumed acceptance. Vendor installer is executed only after digest
  verification, scoped to the private job directory. No global install or cache.
- Cargo has no stable native dependency age filter or blanket build.rs/proc-macro
  denial. Existing locked Rust dependencies and reviewed CI remain unchanged;
  these unsupported controls are a residual gap, not claimed protection.

REA angle: use the shipped AWS CLI/private Botocore and public Boto3 models to
observe real low-level client behavior; preserve raw signing vectors and reuse
the parent's merged S3 adapters and synthetic archive engine, not another engine.

## Delivery boundary

The standalone client PR cannot qualify or merge until the parent integration
fixture has actually exercised the contract on the tested head. The parent may
consume this commit into an integration PR with provenance and supersede the
standalone draft. Missing Rust fixture is an expected red build gate, never a
reason to skip the qualification job or remove it from fail-closed `ci-ok`.
Only exact-head Actions run/job links count as CI evidence. No local startup,
client suite, host installation, provider, secret, paid service or deployment is
introduced by this slice.
