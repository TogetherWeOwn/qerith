# Experimental archive-provider consumer bridge

This is a default-off **cold restore checkpoint**, not complete multi-backend
support. Enable `qerith-core/archive-provider` only in synthetic development.
There is no live supplier configuration, signer, provider probe, activation,
charged fallback, media decryption, durable database or production qualification.

## Immutable source

Both engine packages are pinned to experimental Velmora source
`40dba9a8cedb27748fa22e8a1d63cb2132067efd` (PR #19). This is an integration
checkpoint, **not an accepted production pin**. Shared exact-head Actions run
`42509015484` passed, including the corrected invocation-control source. Shared
native Crypto/Security/QA acceptance is still a separate gate. The product
previous-head run `42508625487` passed all three generated restore tests; that
is not evidence for this new consumer head. The dependency bump must settle through
shared review and the product's applicable independent Security/Crypto/QA gates
before this PR is ready.

The previous pin `c5e79d617896490a47d577a9b062cd0010e0bc8a` predates more than
this module: the intervening engine changes include the media format and pinned
TLS transport. The product does not re-export media decryption, reinterpret raw
client ciphertext or turn part digests into authenticated plaintext. Do not
present this as a one-file or archive-only dependency update.

## Product-owned inventory and common cache

`composition::provider::ProviderStorage` implements the existing `Storage` port,
so `run_once` still owns catalogue claim, checkpoint, current authority,
subscriber cancellation, final generation fence, publication and retry policy.
It consumes `velmora::archive::v1::{ArchiveProvider,ObjectRecord}` directly;
there is no second provider protocol or transport/pool implementation.

`ArchiveCache::archive_record` resolves the catalogue's protected `recovery_ref`
to the complete immutable shared record. A durable adapter must retain tenant,
backend, account routing identity, allocation, remote version, encryption
format/mode/key epoch/envelope, whole ciphertext length/hash and part manifest in
the same product inventory boundary. Tenant/generation numeric IDs have canonical
decimal provider encodings. Credential material is never an identifier. Account
routing changes create new accounts; resolving old records must remain possible
independently of the current new-write target.

An explicitly recognized legacy record returns `None` and keeps its existing
reader. An unknown/new/missing/corrupt inventory is an error, not `None`. Neither
new write policy nor missing S3 configuration authorizes NNTP, another account or
permanent R2 substitution.

The bridge validates tenant/generation/length/hash and byte/part budgets before
I/O, selects exactly the recorded backend, and requests the entire immutable
ciphertext into invisible bounded cache staging. The shared identity's internal
cache key includes all routing/version/encryption coordinates. The cache port
reconciles exact completed inventory before fetching; recorded corruption or a
missing recorded completion fails closed without a healed replacement. It
verifies whole ciphertext/checksums before returning an immutable cache receipt.
Only the existing catalogue transition can publish that receipt. Provider or
cache presence is never a lease, public ETag, dedupe signal or authorization.

Trusted `Control` and the injected transports must enforce current authority,
resource bounds, cancellation and deadlines during I/O. The canonical
`Control::cancelled` future must register an actual event source before checking
policy and wake even when the socket never progresses. Polling-only checks or a
never-woken pending future do not satisfy this requirement. Shared `ClientIo`
interrupts pending operations and attempts shutdown without QUIT; this does not
prove physical closure/settlement or permit releasing the product's pool lease.
The production runtime control binding is not shipped here. Generated consumer
tests bind a retained watch event source to the same current authority and a
Tokio deadline timer; paused-time tests assert an actual registered-task wake
for policy revocation, cancellation and deadline during stalled NNTP/S3 fake
reads, plus pre-registration events. They also check incomplete cleanup and no
publication/fallback. These are not socket/lease-close qualification.

An error prefix stays
invisible. Cleanup removes only incomplete attempt-local cache allocations; it
never aborts/deletes provider objects, uncertain writes, safety copies or another
attempt's completed version. Existing serving pins and protocol-specific range,
validator and authorization checks are unchanged.

## Explicitly unfinished boundaries

- New provider records deliberately fail closed for `post` and
  `verify_archive`. Upload still stages through the existing common cache port;
  shared begin/part/commit/abort/reconcile and durable write journal integration
  are not yet wired.
- The legacy two-independent-backbone archive qualification/eviction path is
  untouched. No S3 receipt is converted to a pair of NNTP reconstructions. S3
  archival completion/eviction needs its own authenticated durable-write and
  readability proof, rather than bypassing or relaxing the existing policy.
- Native REST/MCP full-ciphertext delivery reuses the existing service handle
  and qualified cache seam. Provider-backed client upload/share/S3 range parity,
  cache admission/retention/invalidation and durable metadata/runtime adapters
  still need consumer receipts. Native ranges remain unsupported.

## Authored synthetic receipts

Feature-on composition tests use programmatically generated bytes, a fake shared
`ArchiveProvider`, an explicit serializable inventory and the real product job,
publication, transfer/pin and delivery paths. They cover NNTP/S3 dispatch, exact
full-C delivery, revocation, corruption/configuration failure without fallback,
and scope/identity rejection before provider I/O. These are not receipts for the
real injected engine adapters or live services.

The cold fixture first uses unchanged **synthetic NNTP** qualification and exact
cache eviction, then supplies a separate synthetic restore inventory. That setup
is intentionally **not S3 archival or S3 eviction evidence**, nor a migration.
Serialized inventory and reference-service checkpoints are not durable restart
qualification. Tests are authored; only exact-head Actions can establish PASS.
The native Actions job runs default and feature-on clippy/tests; wasm and MSRV
also compile the default-off bridge explicitly.

## Dependency supply-chain record

The event-control pin change has no engine Cargo manifest changes from the
previous pinned checkpoint. Only the three git source coordinates move in the
lock; no package versions/dependency edges change. The product additionally
enables Tokio's existing dev-only `test-util` feature for deterministic paused
deadline tests; no new package, script or build-hook exception is introduced.
Selective ordinary control/client source was inspected through the GitHub API,
not by fetching a source tree or opening provider/media/NZB fixtures. The actual
new git source, locked freshness and clean build/tests are verified in Actions,
not by a local dependency install or source execution.

Before this correction, no local dependency-source fetch, installation, build or suite ran. The first
composed lock graph failed Actions freshness on head `a0d1ea3` (run
`42508369021`): it accidentally retained an engine dev-dependency as a normal
synthetic-server dependency. A subsequent manifest-only Cargo resolution used
only the three pinned package manifests and empty target placeholders, never
engine code or provider/media/NZB fixtures. `cargo update --offline --workspace`
against that projection identified exactly the stale edge, with no package or
version changes. The fix removes it; the projected files were cleaned up.
Registry index metadata was accessed, not dependency source artifacts. This is a
lockfile diagnostic, not a build or CI substitute. Actions must still validate
the actual git source with the existing `cargo metadata --locked` freshness and
immutable-pin gates, clean dependency build/tests, cargo-deny and CodeQL.

Cargo 1.99.1 has no supported stable release-age filter or blanket dependency
build-script/proc-macro refusal. These protections are **not claimed**. Existing
native ring/platform build hooks and serde proc macros remain part of the
isolated Actions build trust; no scripts were enabled on the host. The changed
engine graph introduces the media AEAD/HKDF dependencies and the shared SSRF
crate, and removes the old rclone-crypt/legacy crypto graph and aws-lc build
chain. These changes require source/dependency review, not an age-policy waiver
or an assertion that an immutable pin is safe.

REA angle: reuse the shared versioned provider mechanism and the accepted
product catalogue/composition/client contracts, not a duplicate archive engine,
installer, transport pool or cache authority.
