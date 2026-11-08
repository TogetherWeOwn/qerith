# Portable ingest / archive / restore composition

This module composes the existing `MetadataOutbox` and `JobPort`, not a second
queue, scheduler or database. It does not implement NNTP, TLS, yEnc, PAR2 or
cryptography. The velmora pin is unchanged. All real persistence, cache and
provider services remain ports. No background work, provider probing, runtime
service, deployment or launch is supplied.

## Call and trust boundary

1. A trusted adapter derives tenant/authority and mints stable upload intent and
   commit operation IDs. `ingest` checks explicit admission, reserves the positive
   intent, stages a complete retained copy, checks its receipt against immutable
   N/SHA-256/checksum evidence, and commits metadata + reference + archival job +
   outbox atomically through the producer contract. The retained copy cannot grant
   a serving lease. Preserve C, opaque generation validator, content metadata,
   modification time, checksum algorithm/type/parts and recovery reference exactly.
2. `run_once` accepts only a committed RunJob event in that tenant's outbox. It
   reads the current job/generation, checks admission and reserves one attempt by
   a fenced checkpoint before physical I/O. Its stable inventory reference binds
   tenant, immutable generation and job. A real adapter must atomically bind the
   inventory to the metadata recovery reference and original upload operations,
   and persist manifest/article/request/copy IDs before acknowledging effects.
3. Archive: retained-source engine POST -> complete engine reconstruction on each
   backbone -> compare each N/SHA-256 to committed C -> separate trusted readability
   and external independence qualification -> record both proofs -> fenced archive
   completion. Two identical backbone IDs fail before evidence recording. A partial
   pair or an expired/missing/uncertain proof never allows completion/eviction.
   Exact, still-valid evidence and independence replay is an atomic no-op in the
   catalogue, permitting restart after either proof write without refreshing its
   expiry. Changed same-time content/attribution still conflicts.
4. Restore first reconciles the exact completed version recorded in the scoped
   immutable inventory or retained catalogue location. The trusted `retrieve` port
   verifies this version before considering another ARTICLE fetch, so loss of
   publication can recover even when the archive is unavailable. A missing/corrupt
   recorded completion fails closed without replacement or fallback healing;
   arbitrary physical presence is neither inventory nor authority. With no recorded
   completion: engine retrieval to invisible staged cache -> whole-generation digest,
   length and supported-checksum verification -> cache object completion -> trusted
   complete-copy receipt -> fenced `PublishRestore`. The existing catalogue checks
   archival qualification, live moderation epoch, current per-reference authority,
   revision/generation and each accepted subscription again in that transaction.
   A completed physical object is not a public URL and grants no authorization.
   When a competing job installed a different immutable version after the snapshot,
   reconcile at most once: read the current winning location, verify that exact
   completed version through Storage within the remaining invocation budget, then
   publish using its receipt under the original fence and current subscriber checks.
   Preserve the losing completed copy in the recoverable inventory for separate
   orphan reconciliation; never replace the winner or delete either inline.
5. Serving is outside this worker: acquire and continuously validate a scoped
   catalogue serving pin, read only its exact immutable completed cache version,
   and serve C or exact slices of C. No direct NNTP-to-user stream exists here.
   A cache hit, physical reuse, operation ID or cross-tenant digest is not access.

`Storage` is a **trusted infrastructure port** grouping collaborating transfer,
cache, manifest and byte-verifier adapters for a bounded invocation. It must not
be implemented by deserializing client-provided `CompleteCopy` assertions. Its
methods must enforce budget/timeout/cancellation **inside** I/O and hashing, use
streaming bounded buffers in a real service, validate immutable-version receipts,
and authenticate recovery/qualification references. The composition compares
assertions, not cryptographic plaintext authenticity. Unsupported checksum types
must fail before accepting upload. A malicious Storage/Qualifier is out of scope:
these ports are not cryptographic capabilities or proof-carrying data types.

## Budgets, lifetime, retries and cleanup

`Budget::new` requires explicit nonzero byte, unit, attempt and claim-duration
limits. Zero-length objects remain possible within a positive allocation budget.
The composition checks committed N before allocation, policy admission before
claims and every I/O boundary, checked time arithmetic, an absolute job deadline,
and claim expiry before publication. At physical I/O boundaries the worker uses
`Transition::Revalidate` through the same catalogue transition guards as final
publication: live fence/claim, current authority snapshot, moderation/deletion and
at least one authorized matching restore subscriber. This read-only transition
neither advances the checkpoint nor touches generation revisions. Archive jobs do
not require subscribers and cannot adopt a changed moderation epoch mid-claim.
These checks stop the next port call after observed drift; they cannot interrupt
an already-issued effect. Storage still owns in-call cancellation/timeout checks,
and final publication remains authoritative. Upload staging receives an explicit absolute
invocation deadline `min(now + claim_for, archive_deadline)` in the same trusted
clock epoch. Storage must enforce that deadline and its cancellation signal inside
staging; a late successful receipt still cannot commit or authorize cleanup.
`Clock` must reject rollback/uncertainty;
`Policy` must acquire account-wide resource reservations and fail closed if that
resource authority is unavailable. Unit limits mean adapter-defined engine units
(e.g. articles/stripes); the Storage adapter enforces them, not a claimed Workers
connection/CPU limit. No bytes, units or quota may be silently unbounded.

The executable fixture uses **4096 bytes, three 1024-byte articles, three total
attempts and a 100-second claim**, within a native ten-second reconstruction
wall timeout and two-second connection timeout supplied by the producer fixture.
These are validated fixture budgets only, not selected product sizes, prices,
Days limits, account entitlements, provider capacity or Workers qualification.

Every started attempt consumes an authoritative checkpoint, including worker
loss. The retry policy may select only a future time before the original absolute
deadline and within the total attempt budget. Integrity/repair failures in the
fixture are terminal, not an infinite retry. A lost final-attempt claim is left
fenced and can be expired at its absolute deadline; it cannot restart I/O. A
scheduler adapter is responsible for dispatching the existing outbox and explicit
expiry/cleanup, not this module. Outbox delivery remains at-least-once. A worker
reads only its scoped `outbox_event`, never materializes the tenant backlog before
admission. The reference catalogue's other operations still use non-durable
clone-and-swap and are not a production scaling claim.

Cancellation never cancels an archive obligation or another authorized subscriber.
Pre-claim invocation interruption leaves needed jobs queued without consuming an
attempt. An interrupted claimed archive, or restore with a current subscriber,
uses the explicit retry policy and attempt cap, not a restore-only cancellation
transition. Only catalogue-confirmed unneeded restores become Cancelled. This
conditional cancellation is attempted independently of invocation interruption,
before claiming or consuming a bounded attempt.
The producer coalesces same-tenant/generation/profile/**fixed-deadline** requests;
each reference has its own scope, subscription operation ID and availability
period. A differing deadline is a separate physical job, not silently widened or
shortened. This slice does not change that reviewed producer contract or add
cross-tenant coalescing. Cancellation requires the exact accepted subscription ID.

Cleanup is policy-driven and may remove only incomplete attempt-local staging.
The Storage adapter must fence cleanup by its own immutable attempt allocation,
not remove another claim's data. Completed copies, retained safety bytes and
uncertain effects survive errors, including failed publication. `Uncertain`
skips cleanup and requires stable-inventory reconciliation on the next bounded
attempt. Cleanup never starts after claim/deadline expiry. Deadline terminalization
and outbox removal occur before cleanup or even after cleanup fails across the
deadline; `Failure::Cleanup` remains explicit. The synthetic fixture keys scratch
and pending bytes by tenant/generation/job/inventory/immutable attempt, not a
mutable checkpoint snapshot; old cleanup cannot erase new staging or completion.
No retry is disguised as success. Ordinary
catalogue/admission failures leave the claim to expire and preserve bytes. An
uncertain metadata commit must be reconciled with the original operation IDs;
transport timeout never proves absence. Do not use automatic abort/deletion to
"undo" an uncertain ingest.

Retention/deletion remains entirely the producer's candidate -> grace -> recheck
-> dispatch -> exact immutable storage version -> confirmed ack protocol. The
composition has **no timer eviction API**. Seven days do not authorize deletion.
All live references, positive intents, jobs, pins, safety holds, availability,
qualification validity and moderation remain producer vetoes. Physical copies
completed just before a failed publish are orphan candidates for separately
reconciled cleanup, never evidence that a new lease exists.

## Executed engine paths and explicit gaps

`tests/composition.rs` consumes `tests/support/mod.rs` without copying its engine
mechanisms. Its Storage adapter uses the existing pinned velmora native NNTP
client for retained-source POST, ARTICLE retrieval and yEnc validation. The
producer fixture checks whole C and then the composition cache adapter separately
hashes N/SHA-256 before completion. Its test-only scratch "delivery" map is private
materialization, never serving authority; it is discarded before the completed
copy is installed. Cold assertions check all copies/pending/scratch maps empty.
The immutable expected FixtureC is only an assertion oracle; retrieval has no
code path returning its bytes instead of ARTICLE bytes. The server spool is the
archive, not a hidden delivery cache.

Repair actually exercised: **retained-source article re-POST** to the synthetic
server (six POSTs across two mock spools). No retained source is available on the
cold path. Missing/corrupt ARTICLE or explicit cold repair failure yields no
lease. `repair_without_retained_source` explicitly reports the pinned public
surface has **no portable archive PAR2 repair adapter**. No PAR2 reconstruction,
newer engine API, container fallback or pin bump is claimed.

Worker-loss/restart tests abandon only the incomplete worker allocation, retain
the authoritative in-memory catalogue and inventory, reclaim with a newer fence
and reject the old publication. They do **not** clone/import a catalogue backup or
prove durable DB recovery. The metadata uncertainty fault wrapper is a controlled
acknowledgement-loss scenario, not a persistence implementation. Native single-
process tests prove ordering/state invariants, not distributed linearizability.

The two-backbone qualifier is explicitly MOCK. Separate native servers/labels
are not real provider independence; opaque fixture bytes are not proved encrypted
C, client AEAD verification, native OPRF or an approved format. Security, Crypto,
QA, provider, legal and release gates remain separate. No S3 adapter or client
conformance, production service, Workers limits or launch is certified here.

## Exact-build evidence export

`evidence.schema.json` (also exported as `composition::EVIDENCE_SCHEMA`) defines a
versioned future-window envelope: immutable product/engine SHAs, exact-head
Actions run/job links, admitted budgets, authorization/window reference, scoped
operation/generation/job identity, observed engine paths, cold-cache inventory,
publication ordering, qualification provenance and explicit unavailable paths.
It is an **evidence schema**, not permission to run live windows or a fabricated
successful record. Never export keys, credentials, raw customer bytes or opaque
access-bearing recovery material. Live evidence additionally needs separately
authorized windows, authenticated independence/readability artifacts and their
validity; a synthetic record never upgrades to live qualification by relabeling.
Consumers must parse `valid_until` and compare it with the window and decision
time; passing the schema is never qualification or authorization. Failed/incomplete
records may contain an empty or ordered observed publication prefix, never reordered
steps. Successful conclusions still require the exact full five-step sequence;
authorization and qualification fields are mandatory for every conclusion. The
schema regression pins these keywords and exercises prefix vectors, not a general
JSON Schema implementation.

Full suites, wasm/MSRV/clippy and ci-ok run only in GitHub Actions. No dependency
or workflow changes are needed for the new integration test. The exact-head PR
record carries Actions links and independent findings/dispositions.

REA angle: source-first reuse of the merged catalogue/job contract and synthetic
velmora NNTP/cache fixture; no copied implementation or parallel engine/scheduler.
