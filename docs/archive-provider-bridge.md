# Experimental archive-provider consumer bridge

This is a default-off **cold restore and journaled-write checkpoint**, not
complete multi-backend support. Enable `qerith-core/archive-provider` only in synthetic development.
There is no live supplier configuration, signer, provider probe, activation,
charged fallback, media decryption, durable database or production qualification.

## Immutable source

Both engine packages are pinned to experimental Velmora source
`a4c7dfe6fce9920803994911a3679003751b2505` (PR #19). This is an integration
checkpoint, **not an accepted production pin**. Shared exact-head Actions run
`42511923975` passed all 21 archive-provider tests, including empty-S3 exact-version
HEAD and completed-reconciliation uncertainty corrections. Shared native
Crypto/Security/QA acceptance is still a separate gate.

Product head `2735e171822b6d25a1f9c8d7e832561445121afe` passed all five generated
restore/control tests, all eleven journaled-write tests and all 106 feature-on
composition tests in Actions run `42748313369`, job `129605634261`. Native default
tests/Clippy, wasm, MSRV, cargo-deny and ci-ok passed. The pinned synthetic-client
job `129605634182` also passed after consuming accepted client runner source from
PR #17; CodeQL run `42748308579` and PR standards run `42748313362` passed.
These receipts verify that head, not subsequent client-path additions or
product/provider durability. Every new consumer head still needs exact-head
Actions and the applicable independent review gates; the PR remains incomplete.

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

## Product write-ahead checkpoint

`Storage::post` now consumes a product-owned `WriteJournal` through the shared
provider's begin/part/commit/reconcile operations. `ingest` still stages the entire
ciphertext through the existing common cache and commits its original catalogue
upload/outbox. The trusted adapter selects and persists the exact new-write intent
independently of old-read routing. Every scope, byte/part budget, saved-session and
receipt binding is checked before effects. Each part is read from the retained
immutable staging copy and rehashed before provider I/O; no client profile or
key binding is converted.

`ArchiveCache::save_archive_write` is a scoped atomic compare-and-swap port:
intent before begin, pending phase before every remote effect, original session
before parts, exact receipt before acknowledgement, and validated readback record
in the same transaction as `Verified`. A runtime must serialize/fence writers and
settle issued requests before reporting absence; these values are not a database
or a physical-lease implementation. Failed proof, revocation after an issued
effect, lost acknowledgement and failed local record commit remain uncertain.
Restart reconciles only the original session. No automatic abort, deletion,
reallocation, alternate account or backend fallback is issued.

Lost begin responses lack a remote session, and shared v1 cannot reconcile by
intent alone. `BeginPending` therefore stays uncertain and needs trusted transport
settlement/recovery; the bridge never retries begin blindly. Partial writes whose
original-session reconciliation remains uncertain likewise keep their journal
and safety bytes. Definite abort/restart settlement and durable runtime adapters
remain unfinished.

Eleven generated write tests in `tests/composition/provider_write.rs` exercise the
actual product `ingest` and `run_once` paths for both backends: successful remote
observation without fabricated qualification; lost commit plus serialized journal
reconnect; lost begin/part; bad proof and failed local commit; early/late Write
revocation with Read retained; stalled-part cancellation; scope/session/receipt
binding rejection; and changed retained staging rejection. All eleven passed
on the head cited above.

Three tests add two-part recovery: a saved first receipt resumes without
reallocating or replaying that part; an uncertain second part cannot progress
unless the transport explicitly reports settled absence, after which only the
original session/intent/parts are retried; and an invalid returned receipt cannot
be checkpointed or reach commit. The fake validates the full original session,
exact retained part bytes and every commit receipt. The three additions passed
on the head cited above. Serialized journal reconnection and a fake settlement
flag are not durable process restart, physical settlement or safe-abort
qualification. All cases retain safety bytes and withhold archive completion.

## S3 client read-path checkpoint

Two generated positive tests in `tests/composition/provider_clients.rs` carry restored
NNTP/S3 bytes through `run_once`, a coalesced restore for independently authorized
same-tenant catalogue references and the existing `s3::archive::Adapter`. They
assert exact full ciphertext, inclusive/suffix ranges, HEAD, validators and invalid
range outcomes, then cross-tenant denial, mid-cache-I/O revocation, alias deletion
and continued source isolation. Only the selected fake provider is read once;
the client adapter receives only the qualified whole-generation cache, with no
provider transport or capacity fallback available. Catalogue links are not a
public-share implementation or proof of vault/key compatibility. Both tests passed
on head `d8ca1249c8b4eb8c7da11e81cbfe1408ce9e839f` in Actions run `42755882416`,
native job `129630031119`, along with the corrected native-profile guard. The
native service assigns an upload-bound validator, not the input ciphertext
identifier. The guard snapshots the actual committed metadata, checks that its
validator is unquoted and that the alias matches its source, and retains the
post-read no-mutation/no-byte-I/O assertions. All 109 feature-on composition
cases passed on that head. No HTTP/SigV4, live-provider, durable catalogue, S3
archival completion or eviction qualification is claimed.

## Explicitly unfinished boundaries

- `verify_archive` deliberately fails closed for every new-provider journal or
  record, including after successful remote readback. The catalogue job never
  becomes archive-complete from these observations. Neither cleanup nor a failed
  qualifier discards the retained staging copy. Backend-specific authenticated
  qualification and actual durable write-journal/runtime implementations remain
  unwired.
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

Provider-to-S3 read cases select the S3-compatible ciphertext metadata profile
before composition ingest, then use the existing synthetic NNTP qualification
and eviction setup and a separate provider restore inventory. The actual
`composition::ingest` / archive job / restore job / catalogue publication /
`s3::archive::Adapter` path is exercised, not the HTTP/SigV4 S3 upload path. No
profile is converted after commit. Native-service objects carry an unquoted C
validator and native user metadata that the strict S3 wire profile cannot
represent. A separate negative case keeps the committed native metadata intact
and requires GET/HEAD to reject before cache byte I/O rather than synthesize an
ETag, discard headers or expose native ciphertext under an S3 profile. This is
fail-closed incompatibility coverage, not cross-profile parity or a supported
client-visible conversion. Catalogue aliases are not public-share/vault-key
compatibility receipts.

## Native REST/MCP delivery checkpoint

Head `d8ca1249c8b4eb8c7da11e81cbfe1408ce9e839f` passed all 109 feature-on
composition cases in Actions run `42755882416`, native job `129630031119`,
including all three provider-to-S3 read/profile tests. The corrected native
metadata guard passed. Default native/Clippy, wasm/MSRV/deny/ci-ok and synthetic
clients (job `129630031470`) passed; CodeQL run `42755878607` and PR standards
run `42755882628` passed. This is previous-head evidence, not acceptance of
subsequent additions, a missing review gate or a production pin.

Two new generated cases in `tests/composition/provider_native.rs` extend the
actual product path for each backend: cold download denial without allocations;
REST/MCP explicit restore and reference-checkpoint reconnection; shared-provider
restore job and catalogue publication; then actual native, REST and MCP download
handles redeemed through `Service::read_download`. The MCP handle is redeemed on
its own independently projected service, not merely compared with a REST response.
A second case requires native ranges to retain `InvalidRange` without allocations,
foreign-tenant and missing-envelope grants to fail before cache I/O, and key
revocation during I/O to withhold all bytes and prevent a subsequent cache read.
Cache delivery has no provider transport available and does not delete bytes on
revocation. These additions are authored, not yet observed passing.

This remains synthetic full-ciphertext service/cache qualification. The setup's
prior eviction still uses the existing synthetic NNTP proof, never an S3 proof;
no stored fixtures, supplier calls, new profile, decryption, public share service,
physical settlement or durable database/runtime is introduced. Native byte
ranges stay unsupported. Backend-specific proof, durable runtime, bounded cache
lifecycle and complete upload/share/client parity remain unfinished.

## Dependency supply-chain record

The corrective pin delta from `40dba9a8cedb27748fa22e8a1d63cb2132067efd` changes
only ordinary archive adapter source, generated tests and documentation. Its
selective source diff was reviewed through the GitHub API. No engine manifest,
package version, dependency edge, build hook or script exception changes.
Cargo 1.99.1 still lacks the age/build refusal controls recorded below; no local
install or dependency-source materialization is performed. Locked clean build,
tests and deny remain exact-head Actions obligations.

The earlier event-control pin change has no engine Cargo manifest changes from the
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
