# Catalogue and job adapter contract

`qerith_core::catalogue` owns product metadata only. It neither implements nor
copies encryption, NNTP, TLS, yEnc, PAR2, a database driver or a scheduler. The
engine dependency and immutable pin are unchanged.

## Public ports and fixture usage

- `MetadataOutbox::transact(tenant, operation, mutation, now, authority)` is a
  serializable metadata transaction. `BeginUpload` reserves an immutable
  generation and positive intent. `CommitUpload` checks complete-copy length,
  SHA-256 and negotiated checksum/part evidence, conditionally advances the
  logical-reference revision, and creates the archival job and outbox record in
  the **same transaction**. No committed reference is visible for an incomplete
  or aborted upload. Upload success is not a restored availability lease.
- `lookup` is an authorized metadata-only read. `AcquireServingPin` requires a
  current logical availability lease and verified cache, and `validate_pin`
  rechecks current authority, reference revision, moderation and expiry at each
  bounded serving interval. Bytes already transmitted cannot be recalled.
- `reconcile` distinguishes absent/applied/uncertain. An operation ID is scoped
  to a tenant and bound to the exact mutation. Retrying that same mutation can
  return the recorded historical result without replaying effects; a different
  payload or a fresh operation against an already-consumed intent conflicts.
  Replaying a successful old commit never rewrites the current reference.
- `JobPort` is a **trusted infrastructure port**, never an end-user endpoint.
  It supplies scoped outbox and job reads, fenced worker claims, conditional
  checkpoints, bounded retry-wait and terminal transitions, verification input,
  safety/moderation policy updates and deletion candidate/finalization/ack.
  Job/event IDs are tenant-scoped and stable across retries. Claims cannot extend
  the absolute job deadline. Expiration explicitly terminates even an abandoned
  claim; failed or expired archival work does not release the safety copy.
- Restore coalescing requires the same tenant, generation, profile and fixed
  deadline. Each logical reference retains its revision, subscription and
  availability duration. Cancellation removes only that subscription, not an
  archive obligation or another subscriber. Publication rechecks each subscriber
  against **current** authority and reference identity, then atomically publishes
  the complete verified copy and only eligible logical availability leases.
- `tests/catalogue_contract.rs` exercises the ports with deterministic synthetic
  metadata and a fake authority. The helper `qualify` inserts **fixture assertions
  only**. These are not real ciphertext, authenticated-decryption results or
  proof that any real pair of backbones is independent.

All timestamps are adapter-provided trusted seconds from one common epoch.
Clock rollback/uncertainty must fail closed in a durable adapter. IDs and opaque
references are not credentials. The adapter derives tenant identity from
verified authentication and implements `Authority` from a current policy
snapshot, never from request-supplied allow flags. Per-principal authorization
and HTTP/S3 error translation belong outside this port. `Unavailable` deliberately
conflates absence with denied reference access. No global existence, cross-tenant
content lookup, reference-count or plaintext/key API is exposed. Physical
cross-tenant deduplication is not implemented or authorized by this contract.

## Evidence, eviction and deletion

`CompleteCopy` is a trusted verifier's assertion of a whole immutable storage
version with agreed length/digest/checksums. Comparisons here do not hash bytes,
validate cryptographic formats or prove that arbitrary uploads are encrypted.
Recovery references are access-controlled opaque catalogue identifiers, **not
keys** and not proof that recovery has been independently tested. Production
admission must ensure recoverable catalogue/manifests and client recovery
material exist; native cryptography and its independent gates remain separate.

Eviction requires exact-generation full reconstruction evidence, matching length
and SHA-256, separately attributed client authenticated readability, verifier
version/provenance/time, and a live external independence assessment for the
specific two backbone identities. The trusted worker authenticates and validates
these artifacts before recording them. Strings, two reseller labels, POST,
STAT, samples, PAR2 presence and time elapsed establish none of these facts.
Expired/missing/uncertain evidence fails closed even after archive completion.
This module does not perform live qualification or manufacture signed receipts.

Deletion is candidate → grace → current-authority and all-obligations recheck →
fenced deleting state + outbox event → conditional storage effect → ack. Candidate
revision changes fence stale decisions. Every current reference is consulted;
unreferenced-generation cleanup requires none remain. Delivery-cache eviction
may retain live references only when archived and currently qualified, without
availability guarantees. Pending positive intents, unfinished jobs (implicit
restore/archive pins), serving pins, logical availability and explicit
safety/retention holds all veto deletion. Unknown authority vetoes deletion.
Conservatively, even orphan-generation cleanup requires qualified archival
safety; failing archive jobs therefore retain bytes pending explicit remediation.

While deleting, new reference, restore and serving admission is refused. Storage
locations must be immutable, tenant/generation/copy-qualified versions, not
reusable object keys. An acknowledged old delete may be redelivered, so a new
copy must never reuse its location. The reference adapter reserves locations and
generations for its lifetime. Warm publication verifies the existing retained
copy; cold publication installs a new immutable version. Replacement of an
existing physical cache version is deliberately not supported: it would require
a separately fenced retirement protocol for the old version and active readers.
There is no propagated Usenet article-erasure claim. Logical tombstones and
moderation epochs survive local cache cleanup.

## What a durable implementation must add

`MemoryCatalogue` is explicitly **non-durable**. Clone-and-swap provides only
single-process atomic error rollback for deterministic tests. Cloning it does not
simulate a crash, durable restart or safe backup replay. It intentionally keeps
its operation, intent, location and tombstone history indefinitely; no production
retention-window or scale claim is made.

A real implementation must, within one authoritative transaction:

1. Persist reference/generation revisions, positive intents and completion
   evidence, operation/result bindings, jobs/checkpoints/fences/subscribers,
   leases/pins, policy epochs/tombstones and outbox rows before acknowledging.
2. Atomically claim/recheck using conditional writes or serializable locking;
   preserve the exact-generation and current-authority checks under concurrency.
   Bind policy snapshots/epochs into the same conflict domain. Fail closed when
   authorization, moderation, retention or clock authority cannot be established.
3. Recover the ledger and outbox after crashes; return `Uncertain` if commit
   outcome is unknown, reconcile stable operation identity and verified storage
   versions, and never treat transport timeout as proof of absence.
4. Dispatch external effects only from committed outbox records. Revalidate the
   current job/fence/policy before work, reconcile already-issued remote actions,
   use conditional immutable-version deletion, and acknowledge only confirmed
   effects. Outbox delivery is at least once, **not universal exactly once**.
   Fencing metadata cannot cancel a remote request already in flight. An external
   worker must retain its checked fence and condition the final publication.
5. Preserve monotonic tombstone/moderation/fence high-water marks outside any
   older backup being restored. Reconcile authority before reopening publication
   or GC. Never install an old snapshot over a newer authority ledger. Determine
   retry/backup windows before bounded history collection. This reference adapter
   deliberately exposes no snapshot-import or tombstone-erasure operation.
6. Define bounded admission, object/checksum/profile validation, resource limits,
   retry budgets, staged orphan cleanup and recovery qualification before service
   use. An upload intent tracks completion, not multipart byte transfer mechanics.

The generic restore duration starts at verified publication and never shortens
an existing lease. This module is **not S3 conformance**: an S3 adapter must admit
supported Days/tier values and implement the selected next-UTC-midnight expiry,
renewal/calendar/error/conditional-request semantics with exact client fixtures.
No values, supplier, pricing, database, cryptographic construction, production
service, live backbone window or deployment are selected here.

## Verification

Full verification runs in the existing GitHub Actions `ci` workflow: native
format/clippy/tests, wasm feature combinations, MSRV and cargo-deny, aggregated
by required `ci-ok`. The contract suite needs no network or live provider. Local
full-suite/CI-mirror execution is not part of this change. Exact-head Actions and
independent Security/QA findings remain release gates, not inferred from these
fixtures.
