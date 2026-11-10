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
and safety bytes. The explicit incomplete-session abort checkpoint below adds a
trusted worker entry point, not automatic cleanup or public cancellation wiring.
Physical abort/restart settlement and durable runtime adapters remain unfinished.

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

## Backend-specific S3 qualification checkpoint

The default-off bridge now distinguishes S3 archive completion from NNTP
independence and from safety-copy eviction. After journaled posting, the S3
observation path checks exact-version stat, then streams the entire ciphertext
through the existing bounded, sticky-error digest sink without allocating a
second body or a cache version. Empty objects still require exact-version stat.
Both Read and Write controls remain current during the observation; the original
immutable journal/record is rechecked afterward.

A separate trusted `Qualifier::qualify_s3` must supply
`S3VerificationEvidence`, binding that entire backend/account/locator/version/
encryption record and recovery reference to current provenance, verifier,
authenticated-readability and backend-durability references. The default returns
`RepairUnavailable`. This is a trusted worker assertion, not a cryptographic
capability, provider qualification implementation or user-supplied field. Neither
`WriteProof` nor ciphertext SHA-256 manufactures the missing assessment.

The catalogue independently validates scope, bytes, references and freshness,
refuses NNTP/S3 evidence mixing, treats exact current replays as no-ops and allows
refresh only for the same immutable record. Archive completion and restore
publication may consume this separate evidence. **Deletion continues to require
the unchanged NNTP proof and therefore refuses S3-qualified generations.** No
S3 safety-copy eviction policy is implemented or relaxed.

Three generated tests in `tests/composition/provider_qualification.rs` author the
actual product ingest/job/completion path, thirteen invalid qualification cases,
readback-only refusal, five corrupt/unbounded/incomplete-stream cases, retained
safety bytes, immutable refresh/replay and refusal of NNTP evidence mixing. They
use explicitly fake readability/durability assertions; no media keys or physical
supplier evidence exists. These additions are authored, not yet observed passing
in Actions. Existing NNTP qualification remains separately exercised. Actual
S3-backed warm/cold restore from this new completion boundary, runtime assessors,
durable catalogue, sharing and global cache lifecycle remain unfinished.

## Explicitly unfinished boundaries

- The legacy `verify_archive` pair path deliberately fails closed for every
  new-provider journal or record. The additive S3 qualification checkpoint below
  can complete a synthetic archive job through a separate trusted assessor; the
  default assessor still refuses it. Neither readback alone nor a failed assessor
  discards staging bytes. Real authenticated readability/durability assessment and
  durable write-journal/runtime implementations remain unwired.
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
revocation. Both additions passed on head
`a1d8f3ea5ad31fd680b5b2634563d0c9439c6433`, Actions run `42757748906`,
native job `129635974960`, with all 111 feature-on composition tests passing.
Default native/Clippy, wasm/MSRV/deny/ci-ok, synthetic clients (job `129635974670`),
CodeQL run `42757744272` and PR standards run `42757749342` passed. This is
previous-head synthetic evidence, not acceptance of subsequent changes or
independent/native review clearance.

This remains synthetic full-ciphertext service/cache qualification. The setup's
prior eviction still uses the existing synthetic NNTP proof, never an S3 proof;
no stored fixtures, supplier calls, new profile, decryption, public share service,
physical settlement or durable database/runtime is introduced. Native byte
ranges stay unsupported. Backend-specific proof, durable runtime, bounded cache
lifecycle and complete upload/share/client parity remain unfinished.

## Product invocation interruption checkpoint

The bridge now races every provider read, begin, part, commit and reconcile future
against trusted `Control::cancelled`. It registers the policy/deadline wake before
checking current authority and polling provider I/O, and checks authority on every
subsequent poll. A provider future with no wake source cannot keep the product
invocation suspended after its control event. This uses the canonical control
contract, not a new provider protocol, pool or runtime policy source.

Completed acknowledgements still enter the original journal path; subsequent
effects, validated write proof and restore publication retain their current
authority fences. An interrupted read cannot publish its incomplete prefix.
Interrupted write invocations retain `BeginPending` or `EffectPending`; dropping
a future does not prove rollback, physical socket closure, request settlement or
permission to release a lease, abort, reallocate or delete safety bytes.

The generated restore wake test now covers both a cooperative provider and one
that writes an invisible prefix then remains pending forever. It checks actual
registered-task wakes for policy revocation, cancellation and deadline on both
backends. A new product ingest/job test stalls each of begin, part, commit and
reconcile without provider control registration, asserts the product's actual
cancellation wake, then serializes/reloads the pending journal and requires
uncertainty-only recovery without fresh allocation, abort or safety-copy cleanup.
These extensions passed on head `03eab66467a183e2508e14d2af2e2bb365051c84`,
Actions run `42759870946`, native job `129642786087`: all 112 feature-on
composition tests passed. Default native/Clippy, wasm/MSRV/deny/ci-ok, synthetic
clients (job `129642786246`), CodeQL run `42759866064` and PR standards run
`42759870746` passed. No pre-fix test execution or independent acceptance is
claimed. Transport-internal control/settlement and durable runtime qualification
remain mandatory and are not replaced by this invocation-level interruption.

## Explicit incomplete-write abort checkpoint

`ProviderStorage::abort_write` is an explicit trusted-worker entry point using the
existing scoped Work, journal CAS and canonical provider abort outcome. Ordinary
job failure/cleanup never invokes it. It does not cancel a catalogue job or wire
public REST/MCP/S3 cancellation to a runtime worker. That integration still needs
an authority/claim-owning runtime and durable journal; it is not shipped here.

- A prepared intent is atomically marked `Aborted` without allocating remotely.
- A ready session is checkpointed `AbortPending` before its exact backend/session
  is passed to `ArchiveProvider::abort`, under current `AbortIncomplete` control.
- A possibly issued write first persists `AbortRequested`, preventing background
  write replay while original-session reconciliation runs. Only transport-proven
  settled absence permits incomplete-session abort. A validated committed proof
  is saved as `Verified` and reported irreversible, never passed to abort.
- Only `IncompleteRemoved`, followed by a current-authority check and acknowledged
  local CAS, becomes terminal `Aborted`. NNTP `Irreversible` is returned honestly
  while preserving the pending checkpoint; it is not article erasure or rollback.
- Lost begin, lost/revoked/interrupted abort and failed terminal persistence stay
  uncertain. A later abort or posting attempt does not replay an abort-pending
  session, allocate another one or interpret object absence as multipart removal.
  Trusted physical settlement/recovery remains a separate unimplemented boundary.

Five generated tests in `tests/composition/provider_abort.rs` begin with actual
product ingest/archive jobs and cover no-effect cancellation, ready-session
backend outcomes, uncertain-effect settlement versus committed objects, pending
abort interruption/reconnect/no replay, scope/session refusal and failed terminal
persistence. The fake invalidates a removed S3 session and rejects abort of a
committed object. All five passed on head
`50eaac61171f390651bce68e0d469d8602bf5a9b`, Actions run `42762184395`,
native job `129650231005`, along with all 117 feature-on composition cases.
Default native/Clippy, wasm/MSRV/deny/ci-ok, synthetic clients (job `129650231339`),
CodeQL run `42762180035` and PR standards run `42762184490` passed. This is
previous-head synthetic evidence, not acceptance of subsequent changes or
independent review clearance. All cases retain safety bytes and withhold archive
completion. No live provider, durable
restart, public cancellation, physical settlement, lease-release or safety-copy
eviction qualification is claimed.

## Bounded restore-stream checkpoint

The product wraps invisible provider staging in an attempt-local sink. Before
forwarding each block, it checks current Read authority, the shared stream-block
cap and the remaining immutable ciphertext length (already within Work's byte
budget). It rechecks authority after cache writes, hashes accepted bytes
incrementally and requires exact length and whole-ciphertext SHA-256 before
`retrieve` succeeds. The first sink failure is sticky: a provider that ignores a
rejection cannot recover success by returning Ok or writing a valid body later.
No second full-body buffer, provider protocol or dependency is added.

The cache must still bound its own allocations and verify negotiated checksums,
immutable completion and persisted keys before publication. This stream guard
is not authenticated plaintext readability, global cache admission/retention,
durable runtime qualification or permission to evict safety bytes.

A generated test inspects invisible staging before completion/cleanup for each
backend with oversized, overlong, truncated, ignored-error and corrupt streams.
It requires no excess bytes or completed copy, then attempt-local cleanup and a
fresh segmented restore through the actual product job/publication path. The
existing product-job failure test also includes all four new stream faults and
requires incomplete cleanup without publication/fallback. These additions passed
on head `b149272248386fe81c17c7b42bf75a848fe4347e`, Actions run `42764127575`,
native job `129656477585`: all 118 feature-on composition cases passed. Default
native/Clippy, wasm/MSRV/deny/ci-ok, synthetic clients (job `129656477821`), CodeQL
run `42764123419` and PR standards run `42764128002` passed. No pre-fix execution
or independent acceptance is claimed. Subsequent heads need their own receipts.

## Completed-cache lifecycle checkpoint

Two generated tests in `tests/composition/provider_lifecycle.rs` exercise the
existing provider/cache ports and actual product restore job for both backends.
A completed but unpublished copy survives cleanup of another attempt's incomplete
allocation; unrelated incomplete bytes also survive until their own cleanup.
The exact recorded completion then reaches catalogue publication with both fake
providers unavailable and no additional provider read, replacement or allocation.
The provider record is serialized/reloaded; the cache remains the in-memory
reference adapter, not a durable process or physical restart.

Twenty negative backend/fault scenarios require recorded completion to fail
closed on missing/corrupt bytes or changed backend, account, locator, version,
format, mode, key epoch or envelope. Even when generated ciphertext is identical,
an old cache key cannot authorize a different immutable provider identity. The
job must not publish, refetch, heal, overwrite or delete a recorded completed
copy. Existing completed inventory and keys remain available for trusted repair.
These tests passed on head `8f7e6aaa49ed4f807bc9f91bd7ad84f2f5a79ccd`,
Actions run `42766062922`, native job `129662725391`: all 120 feature-on composition
cases passed. Default native/Clippy, wasm/MSRV/deny/ci-ok, synthetic clients (job
`129662725136`), CodeQL run `42766056745` and PR standards run `42766063037` passed.
No pre-fix execution or independent acceptance is claimed. This tests the existing
trusted adapter contract, not a new cache engine.

Global capacity admission/reservations, bounded retention, eviction scheduling,
public-share/key compatibility, backend-specific archive qualification and actual
durable catalogue/cache/runtime implementation remain unfinished. Attempt-local
cleanup and completion reconciliation are not those production qualifications.
The setup still uses synthetic NNTP qualification for its prior eviction; it
provides no S3 safety-copy eviction authority.

## Cache invocation interruption checkpoint

Provider restore now applies the same trusted event/deadline interruption to
cache reconciliation, staging allocation, immutable completion and winner
verification. It registers the control wake before polling cache I/O and checks
current Read authority again after a ready acknowledgement. A cache future that
never wakes cannot indefinitely suspend those product restore calls. The legacy
path and backend selection are unchanged; this adds no executor or cache engine.

An interrupted completion is **uncertain**, including when the immutable copy was
persisted before its acknowledgement stalled. No publication or cleanup permission
is inferred from dropping the future. The adapter must retain the exact completion
inventory and reconcile it after reauthorization, without replacement or refetch.
Incomplete staging remains attempt-local. Trusted cleanup intentionally does not
require the revoked Read grant; its own runtime deadline/settlement obligations
remain mandatory. Journal persistence, physical cache settlement and account-wide
admission/retention are not implemented by this invocation guard.

Two generated tests in `tests/composition/provider_cache_control.rs` cover both
backends. Twenty-four stalled-cache scenarios require an actual registered-task
wake on policy revocation, cancellation or deadline across all four cache calls.
The first three use the actual product restore job; winner verification uses its
trusted storage entry point. Completed copies survive interruption and are then
published through `run_once` with both providers unavailable, without refetch or
inventory replacement. A ready-completion regression revokes authority during the
same poll and requires uncertainty with the completed copy retained.

Head `1eb59465c45bb3c87796c87bc7f4c5cdf05af1d4` failed native Actions run
`42768537800`, job `129670655373`: 121 composition cases passed and the
stalled-cache test failed during recovery. It retried at logical time 61 before
the retry deadline; the catalogue correctly rejected the early claim with
`Conflict`. The attempted repair at head
`da6f6f22e23f26a3fd68280cd4dcd3ce891f879f` also failed (run `42770454651`,
job `129676760635`, 121 passed / 1 failed): it expected deadline 62, but the
eviction helper advances the clock from 60 to 61 before the interrupted run,
so the test policy's two-second delay yields 63. The same-poll authority test
passed on both heads. Synthetic clients, wasm/MSRV, cargo-deny and CodeQL passed
on the latter head, not overall CI.

The repair captures the post-eviction logical clock, independently asserts the
policy's two-second retry delay, requires refusal one tick before that deadline
with unchanged job/checkpoint, completed inventory and provider read count, then
retries exactly at the deadline. Verification-only recovery keeps its unchanged
clock rather than moving it backward. It changes no runtime retry policy.
The corrected scenarios passed on head
`c906d4aae444c93af8b8dc06d547b3bf52f56005`, Actions run `42772292137`,
native job `129682666627`: all 122 feature-on composition tests passed, including
both cache-control tests. Default native/Clippy, wasm/MSRV/deny/ci-ok, synthetic
clients (job `129682666417`), CodeQL run `42772286059` and PR standards run
`42772292106` passed. This is previous-head evidence, not acceptance of subsequent
changes or independent review. Synthetic NNTP setup eviction remains unrelated
to S3 archival/eviction qualification.

## Journal/record consistency checkpoint

A surviving new-provider write journal cannot authorize the legacy reader when
its immutable record is missing. Before restore retrieval, completion or winner
verification, the bridge now requires any journal to be `Verified` and its saved
record and intent to match the entire current immutable record. Missing verified
inventory is corruption; a journal without a completed record remains unavailable.
Unfinished or aborted journals alongside a record fail closed. No new account,
version, encryption identity or part manifest can be substituted merely because
whole-ciphertext bytes match. Imported records without a local write journal keep
the existing immutable-record checks; explicit legacy records keep their reader.

Two generated tests cover 28 backend/inconsistency scenarios across trusted restore
entry points and the actual product job, asserting no provider/legacy I/O, cache
allocation, publication or journal/record mutation. Matching serialized verified
journals restore through the product job with Write revoked and Restore retained,
using only their recorded backend. These additions passed on head
`15c40b5ad6991e8a244208ad786ead3bf3cdcf6f`, Actions run `42774573486`,
native job `129689963096`: all 124 feature-on composition tests passed. Default
native/Clippy, wasm/MSRV/deny/ci-ok, synthetic clients (job `129689962930`),
CodeQL run `42774568021` and PR standards run `42774573409` passed. This is
previous-head evidence, not acceptance of subsequent changes or independent
review. Reference checkpoint serialization is not durable process restart.

Source tracing confirms the remaining qualification boundary is structural:
`Storage::verify_archive`, `Qualifier` and the catalogue's evidence/completion and
deletion checks consume two NNTP reconstructions plus independent-backbone and
separate authenticated-readability evidence. The shared provider's `WriteProof`
and a consistent `Verified` journal establish none of those qualifications and
cannot substitute a backend-specific S3 durability/readability decision. This
change preserves the fail-closed qualifier and every retained safety copy; it
does not complete S3 archival/catalogue integration or relax eviction.

## Retained write-part invocation checkpoint

Before sending each provider part, the bridge now races the retained cache read
against the same trusted Write-authority, cancellation and deadline event source.
An unresponsive cache cannot suspend this invocation indefinitely after a control
event. The existing part hash and post-read authority checks remain mandatory.
No part has been issued at this point, so interruption retains the original Ready
session and saved receipts; it is not uncertainty about a new remote part and
does not authorize begin/reallocation, abort or safety-copy deletion.

One generated product ingest/job test covers both backends across policy
revocation, cancellation and actual deadline-timer wakes during a permanently
pending retained read. It asserts a registered-task wake, no part/commit/fallback,
retained session/safety bytes, then serialized checkpoint recovery and completion
of the same session after reauthorization without another begin. Six scenarios
are authored, not yet observed passing. The job still withholds archive
qualification after remote readback. No physical cache settlement, durable
restart, global lifecycle or backend-specific durability claim is made. Journal
persistence itself still needs a bounded durable runtime implementation; this
read guard is not a transaction-cancellation or CAS-settlement mechanism.

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
