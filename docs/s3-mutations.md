# Restricted archive mutation reference

`qerith_core::s3::mutation` is a synthetic, single-process executable adapter over
`catalogue::MemoryCatalogue` and the existing S3 wire primitives. It is **not** an
HTTP server, durable database, new engine, cryptographic construction, scheduler,
provider qualification or SDK compatibility claim. Arbitrary upload bytes are
not proof of encryption. No live endpoint or provider is used.

## Ownership and integration

The catalogue owns logical references, monotonic revisions/tombstones, generation
metadata, restore availability, archival jobs and the outbox. The mutation model
owns immutable retained byte fixtures and multipart session/part/result evidence.
It never uses `Mutation::Link` as a copy shortcut. The only new catalogue port is
`MutationTargets::write_target`: write-authorized inspection of the current
revision, including a deleted key. It does not grant read/list access. Prohibited
or deleting generations return errors, not an invented absent key.

Fixture operation/generation identities are allocated by the shared catalogue
above its replay ledger, reserved generations and infrastructure sequence. The
mutation adapter's private sequence is only for upload/part tokens; it cannot
collide with legitimate restore/link/tombstone operation identities.

An authenticated ingress adapter must bind a verified principal to a trusted
catalogue `Authority`, tenant and bucket/key mapping, and recheck the original
`VerifiedRequest` at admission. Typed reference names must include the bucket
(e.g. `bucket/decoded-key`); `CopySource::from_headers` uses that mapping and the
shared once-only path decoder. It rejects public version selectors; public S3
versioning is not qualified. No caller-supplied tenant or recovery/context claim
is authorization. Multipart IDs are scoped to the tenant **and exact reference**;
other tenants/keys cannot list, complete, abort or replace its parts.

Wire decoding, signatures, unsupported feature/framing/encryption rejection and
body integrity remain the merged wire module's responsibility. `ValidatedBody`
keeps a successful `UploadValidator` receipt bound to its exact bytes. Chunked
framing/trailers, CRC64NVME and unqualified encryption guarantees fail closed.
This slice does not expand that wire profile. Mutation request routing must use
all typed options: `UploadMetadata::from_headers`,
`DestinationConditions::from_headers`, `CopySource::from_headers`, and
`MetadataDirective::parse`; an HTTP dispatcher must reject fields in the wrong
operation context rather than ignore them. Multipart checksum negotiation is an
explicit typed input; no default-client multipart negotiation is claimed.

## Publication and conflict semantics

`prepare` records a write-authorized revision and admitted predicates. `put`,
`complete`, and `copy_object` perform a final authorization/predicate/revision
check. A failed predicate is 412; a changed revision with otherwise satisfied
predicates is 409 `ConditionalRequestConflict`. In this conservative profile a
multipart initiation records the destination revision: an intervening write or
delete requires a new upload, never a stale completion overwriting a successor.

Success is a retained-cache commit: complete decoded C, length/SHA256, negotiated
checksums, metadata/recovery reference, a unique generation/opaque ETag and a
queued archival obligation become visible together. It is **not** archive
completion, restored availability, trusted-client decryption evidence or an
immediate GET grant. Overwrites have no inherited restore lease.

The reference boundary is exclusive `&mut MemoryMutations`; the concurrent test
uses a mutex, not a claim of a distributed lock. Catalogue changes are staged
against a clone and assigned only after both upload transactions succeed. There
is no fallible operation after publication in this model. Production adapters
must use a real serializable storage/metadata boundary and atomically recover
session state, retained-copy receipt, immutable bytes/context/recovery metadata,
accepted request/result, catalogue commit and outbox obligation. A process clone
is a fixture checkpoint only, **not crash durability**. A real uncertain commit
must reconcile shared operation/generation evidence before deleting staged bytes
or retrying publication; it must never be mapped to absence or an early 200.

## Multipart and integrity

Arrival is unordered; completion is strictly increasing by part number.
Replacement is atomic and gets a new opaque part ETag, even for equal bytes. All
completion ETags and negotiated checksums must match current stored evidence.
Every nonfinal part meets the explicitly supplied minimum part size. Zero-byte
single-part objects remain valid. Unselected/replaced staging is reclaimed when
the session commits, aborts or expires; committed retained bytes are not staging.

Supported typed integrity modes:

- No negotiated checksum: length and service SHA256 still verify complete C.
- SHA256 or CRC32 `FULL_OBJECT`: validate each part, require the exact full-C
  checksum at completion, preserve full algorithm/type/value **and part evidence**.
- SHA256 `COMPOSITE`: use the shared `StoredChecksum` digest-of-binary-part-digests
  construction; persist the part evidence and render the part-count suffix. This
  is not SHA256(C). CRC32 composite and unknown algorithms are not admitted.

Abort before commit prevents publication; after commit it returns 404
`NoSuchUpload` and never undoes the object. A missing upload is also 404. An exact
accepted completion request can replay its original result during bounded result
retention, including after a later overwrite. Changed evidence never replays a
successful result. This reconciles a lost completion response, not arbitrary
request idempotency. Success XML is produced only from an accepted commit.
`copy_response` includes the committed `LastModified`; `complete_response` includes
`Location`, `Bucket` and decoded `Key`, binding a parsed ingress target back to the
committed destination and using the trusted policy endpoint (not client Host).
Accepted results retain their destination and timestamp for identical retries.
`completion_result` explicitly treats an embedded `<Error>` in HTTP 200 as failure.
The parsers bound XML and reject unknown fields, DTD/entity expansion, unsupported
versions and duplicate fields. XML predefined/numeric escapes preserve Unicode
keys and opaque quoted ETags. Literal text follows XML 1.0 CRLF/CR normalization;
explicit numeric CR references remain distinct and response keys encode CR as
`&#13;` rather than a literal character that clients would normalize.

## Copy and deletion

Copy independently checks current source read and destination write authority,
source predicates and exact generation, active source restore availability and
retained full-C integrity. Shared read predicate precedence is reused without
changing read plans. A final source authorization guard also covers destination
publication/part staging. The model has no await or concurrent catalogue mutation
inside this boundary; real adapters need a source-generation/lease fence or pin
and atomic final predicates around external storage I/O.

`COPY` preserves source content/user metadata; `REPLACE` uses destination metadata.
Both bind destination recovery metadata, create a new generation and archival job,
and create **no destination restore lease**. Trusted encryption-context mismatch
requires client re-encryption via upload, never server decryption or rename.
`upload_part_copy` validates an optional inclusive source range and derives exact
part checksum evidence for the negotiated mode. Its resulting part must still
participate in a successful atomic completion.

`delete` is an authorized logical tombstone and returns 204, including an absent
key. `delete_objects` takes the shared parsed bucket target separately from
bucket-relative XML keys, qualifies catalogue references, and echoes only the
original keys. It returns per-key results, suppressing successful keys in quiet
mode while retaining errors. It never deletes shared byte versions. The shared
catalogue deletion worker and its serving pins, reference counts and integrity
proofs remain the sole physical-cleanup authority; there is no Usenet erasure
promise. Trusted fixture workers execute a queued event through
`MemoryMutations::delete_retained`, which obtains a fresh catalogue dispatch,
checks the exact tenant/generation storage version and verification deadline,
removes its retained allocation, and publishes catalogue acknowledgement in the
same exclusive boundary. It rejects stale, wrong-tenant and replayed events.
Workers must not acknowledge fixture storage deletion directly through
`catalogue_worker`: that port only updates metadata, not the byte allocation.
Production storage adapters need durable dispatch/completion reconciliation.
Aborting multipart never deletes an already committed generation.

## Explicit synthetic resource/retry policy

`MutationPolicy` has no default. It validates object/part size, minimum nonfinal
part size, part count (at most 10,000), per-tenant session slots, aggregate staged
part bytes, batch-delete count (at most 1,000), fixed session lifetime, a separate
archive work window, accepted completion result retention and completion attempt
ceiling. Every commit derives the archive deadline as commit time plus
`archive_window`, so late session completion still grants the entire work window.
Zero/contradictory limits, overflowing deadlines and unrepresentable XML commit
timestamps are rejected before publication. Replacement subtracts the replaced bytes before admission.
Polls and replacements do not extend lifetime. Expired sessions do not gain more
capacity until the caller explicitly invokes bounded `cleanup(now, limit)`.
An expiry-ordered index bounds inspection as well as removals, across all
tenants: `CleanupPass` reports `examined <= limit` and removed entries. Completion
and abort update this index together with their session state. Cleanup removes
only expired session/result evidence, never retained generations or recovery
obligations. There is no hidden retry loop or background collector.

These are fixture inputs, not selected production numbers or a production quota
system. Production retained-byte/backlog admission, tenant/global budgets, durable
idempotency/uncertain outcomes and cleanup-worker retry/backoff must be enforced by
the admitted durable adapter and existing lifecycle policy. Safety bytes cannot
be removed merely to regain capacity; exact-generation full verification on two
actually independent backbones and all existing deletion gates remain required.

## Verification

`tests/s3_mutation.rs` covers empty/binary overwrite, shared archive obligation,
checksums/framing/encryption rejection, write-only tombstone/recreation, revocation
and moderation, 412 versus 409, concurrent/out-of-order/replaced/duplicate parts,
completion/abort/overwrite ordering, checkpointed lost-response reconciliation,
FULL_OBJECT/COMPOSITE evidence, bounds/expiry/quiet deletion, restored-source copy,
metadata directives, generation/predicate/context/authorization failure, range
part-copy, strict control XML, success XML and embedded completion errors.

Full suites, formatting gates, Clippy, MSRV and Wasm builds run in GitHub Actions
on the exact PR head. No local full-suite/CI mirror or live client/provider test
is substituted for that evidence. No new dependency or engine pin is introduced.
