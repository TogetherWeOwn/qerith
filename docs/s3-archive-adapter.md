# Restricted archive bucket/list/read adapter

`qerith_core::s3::archive` composes the merged wire validators and catalogue/outbox
contracts. It is a portable library and non-durable executable reference, **not an
HTTP service, production storage adapter, AWS equivalence or certified client**.
No provider, database, deployment, engine pin, encryption or scheduler changes.

## Integration boundaries

Ingress must retain the raw origin-form target, establish trusted TLS, verify
SigV4 with `s3::verify`, verify the decoded request body's signed payload/integrity,
and map that verified principal to a trusted `Session`. Never deserialize a
session, tenant, operation ID, capacity receipt or cache receipt from a request.
`Session` rechecks credentials/current policy; catalogue references are exactly
`bucket/key`, with no Unicode, dot-segment, slash or percent normalization.
The root target `/` supports ListBuckets; it is not an object/bucket alias.

The read module routes Create/List/Head/DeleteBucket, GetBucketLocation,
ListObjectsV2, Head/GetObject and regular RestoreObject. Other adapters own upload,
copy and logical object deletion. Unsupported selectors, ACL/policy/versioning,
encryption, retention and integrity options are rejected rather than accepted as
guarantees. Missing and foreign buckets deliberately both return AccessDenied,
without region/owner hints. Missing objects are disclosed only with current list
permission, after object authorization. HEAD errors are always bodyless.

`ArchiveReadPort` adds tenant-scoped inventory/status/bucket methods to the existing
metadata boundary; it creates no second job store. Bucket delete checks all live
references (including hidden/prohibited ones) and pending upload intents. A durable
implementation must serialize that check with upload admission/commit. The generic
catalogue still accepts arbitrary reference names: **the downstream upload adapter
must check bucket existence in its atomic commit boundary**, not perform a separate
HTTP precheck. These read-side ports do not claim a live multi-service transaction.

`CapacityPort::reserve` returns only after exact-reference/generation capacity is
committed through the requested expiry. The catalogue validates the scoped receipt
and atomically extends an existing lease without shortening it. A failed/uncertain
lease transaction must retain/reconcile its reservation. At initial restore
publication, the trusted worker must reserve the admitted availability period and
provide the existing complete-copy proof before `PublishRestore`. Synthetic receipts
are assertions at a trusted boundary, not cryptographic or physical qualification.

## Read and restore invariants

- Wire metadata is derived from the exact immutable catalogue generation; opaque
  quoted ETag, modification time, content/user headers and checksum type/part proof
  are preserved. Unsupported or inconsistent stored checksum evidence fails closed.
- Preconditions (using the merged precedence rules) and range validation precede
  cold state. HEAD is metadata-only, including ranged HEAD; it never reads cache,
  pins a transfer, requests capacity or queues work. No lease means GET/range 403
  InvalidObjectState even if retained safety bytes physically exist.
- GET obtains a catalogue serving pin and compares its generation to the planned
  metadata before cache I/O. `QualifiedCache` is a trusted **whole-generation
  verified immutable cache**; no NNTP fallback or partial reconstruction. The
  adapter bounds buffered read size, validates returned slice length, rechecks
  current authority and the pin after I/O, and cleans up pins even after revocation.
  Streaming production adapters must perform equivalent checks during transfer;
  bytes already received cannot be recalled. This reference buffers before success.
- Regular restore parses the merged strict XML/policy, queues the existing durable
  job path (202/empty), or reports pending duplicate (409/S3 XML). Only verified
  publication grants availability. Failed/expired work has no S3 failure header.
- Calendar Days is persisted on the subscriber. Expiry is ceiling(completion +
  Days) to UTC midnight; an exact midnight stays unchanged. Renewal uses its
  accepted time, commits reserved capacity before 200, and takes max(old,new).
  This is the selected service profile, **not an observed AWS-compatible expiry
  claim**. Tests admit 1–7 Days explicitly as fixture policy, not production limits.
- Adapter recreation uses catalogue-held jobs/leases, not adapter-local state.
  Cloning MemoryCatalogue is only a process-local reference snapshot, **not actual
  crash recovery, durable persistence or a recoverability claim**.

## Listing policy

Keys are valid UTF-8 strings ordered lexicographically by their UTF-8 bytes, without
normalization. Prefix, arbitrary nonempty delimiter and CommonPrefixes share the
max-keys budget; max-keys is 0–1000 (default 1000). StartAfter is exclusive and also
filters CommonPrefixes. A continuation cursor carries the last key and any emitted
prefix group, preventing duplicate groups across page boundaries. Calls are current
indexed scans, **not a snapshot** across concurrent mutations: newly inserted keys
behind the cursor need not appear and keys ahead may appear.

`TokenPort` binds opaque server-issued handles to tenant, principal, bucket
incarnation, prefix, delimiter, encoding and StartAfter. Every continued request
rechecks authorization. Page size may change. Production implementations require
unguessable bounded-life handles and persistent scope state (or explicit expiry on
restart). `MemoryTokens` is an explicitly predictable, bounded, expiring fixture;
it must not become a production credential/token implementation.

XML escapes metacharacters. `encoding-type=url` percent-encodes UTF-8 bytes using
RFC 3986 unreserved characters only, including slash, space, percent and plus.
Keys not representable in XML 1.0 require URL encoding, never replacement characters
or silently changed names. Region and unsupported options are validated before
bucket mutation. The catalogue reference is deliberately not a production-scale
indexed store; the durable port must supply bounded indexed scans and resource
admission.

## Verification boundary

`tests/s3_archive.rs` supplies synthetic fixtures for bucket ownership/nonempty
checks, predicate/cold/HEAD ordering, exact byte slices, verified publication,
restart-like adapter recreation, capacity renewal, expiry, generation isolation,
revocation, XML/URL listing and >1000-key traversal under mutations. Existing wire
and catalogue tests remain unchanged. Full verification runs only in GitHub Actions.
Composition with actual synthetic archive/engine and pinned low-level S3 clients
is downstream qualification; these tests do not substitute for it.
