# Drive same-intent resume evidence

Staging serves `GET /api/uploads/<intentId>/resume` only with
`DRIVE_STAGING_INVITE_ACCEPTANCE=1`, for a live upload-authorized owner or member
reading their own allocation. The disposable Worker/D1 fixture remains separate.
Both accept one canonical lowercase UUID. The request must be bodyless and have
no query string. An `Origin` header, when present, must match the Worker origin;
`Sec-Fetch-Site` must be absent or `same-origin`. The handler derives the active
session, principal and login generation on the server and uses the qualified,
normalized upload storage binding. The reader rechecks these inputs and the evidence in the same fresh
`first-primary` D1 snapshot.

The shared [`UploadResumeEvidence`](../apps/drive/src/lib/upload-resume-evidence.ts)
projection contains only:

- `declaredSize`: the intent's declared byte count (0 through 5 GiB).
- `parts`: ascending records of `{ partNumber, sizeBytes, sha256 }`, starting at
  part 1. `sha256` is a 64-character lowercase hexadecimal SHA-256 of the
  exact bytes acknowledged for that slot. Parts follow the picker's 16 MiB
  layout; the final part uses the exact remaining byte count. A zero-byte
  file has one planned part with size 0.
- `expectedPartSha256s` (bound intents only): the complete immutable plan set at
  allocation, packed as one 64-character lowercase hex digest per slot. Every
  acknowledged digest must match its slot. The plan is not an acknowledgement:
  even a complete plan can accompany `parts: []`.

Every route response is `private, no-store`. Only a `200` carries JSON;
`parts: []` means the eligible allocation has **no** recorded part operations.
The reader's `null` becomes an empty-body `404`, indistinguishable from a
missing or foreign intent. A gap, wrong part length, unknown or uncertain
result, or legacy receipt without exact byte proof invalidates the entire
projection. Sealing, cleanup and publication fences also make it unavailable.
An initially missing or inactive session receives `401`; unavailable server
storage qualification receives `503`. Staging rejects other methods, query
strings, path aliases, and flag-off requests with `404`. On the fixture, the
exact path rejects other methods with `405` (`Allow: GET`) and queries with
`400`. Both reject invalid body framing with `400` and disallowed origins or
fetch metadata with `403`.

This is evidence at the read snapshot only. The route never contacts the
provider or grants authority to send or complete an upload.

## Browser client

`resumeMultipartToRoot(intentId: string, file: File, partAccepted: (acceptedBytes: number) => void, fetcher?: typeof fetch): Promise<RootUploadResult>`
accepts an explicit candidate and re-picked file. It fetches evidence for that
candidate only (64 KiB response cap) and checks the size and every acknowledged
part against the file before any write. After verifying a full prefix it reports
its cumulative byte count and submits the existing root Complete request once.
This client still accepts only the legacy projection. A zero-byte file with an
acknowledged part skips PUT; with `parts: []`, the client must get a `204` for
one empty PUT before reporting zero and completing.
Nonempty missing suffixes, unavailable evidence and uncertain requests return
`interrupted`; nothing is allocated or retried. No picker calls this interface.

## Why only full prefixes (and empty bytes) can proceed

The [permanent slot claim](../apps/drive/migrations/0020_upload_part_operation_evidence.sql)
prevents an acknowledged part from being replaced; the HTTP claim also checks
live authority and refuses to exceed the intent's immutable declared size.
Once every selected byte is verified, those slots already use the entire byte
budget. Any additional admitted slot can only be empty. For a zero-byte intent,
no slot can carry nonempty bytes at all. The
[completion seal](../apps/drive/migrations/0021_upload_sealed_evidence.sql)
requires the complete, ordered set of acknowledged, non-uncertain slots to sum
to the declaration; sealing fences every subsequent HTTP part claim. Complete
still uses the existing live authorization, storage and publication checks.
A competing request can deny or preempt completion, but cannot substitute
bytes in these cases.

For a nonempty missing suffix on an unbound intent, a slot claim does not bind
the rest of the intent to the same file. Different writers can supply different slots, and
Complete validates receipts and aggregate size, not a selected-file manifest.
Waiting for the client's own PUTs or rereading evidence before Complete cannot
fence a competing Complete. The full file expectation must be bound at creation,
not retrofitted after any part has been dispatched.

## Expected parts producer and claim handoff

The server-only [`UploadIntents`](../apps/drive/src/lib/server/metadata/upload-intents.ts)
method `claimNewExpectedAllocation(principalId, sessionHash, size, endpoint,
bucket, epoch, mode, parts): Promise<UploadIntent | null>` takes trusted server
identity, session hash, normalized storage namespace and mode (`'owner'` or
`'active'`). Its `parts: readonly ExpectedUploadPart[]` is an ordered proposal of
`{ partNumber: number; sizeBytes: number; sha256: string }` records following the
same 16 MiB plan as above. It commits the fresh intent, full vector, storage
binding and version-1 allocation claim in one D1 batch. It returns no manifest,
does not contact S3, and is not called by any upload route.

The live part claim uses the intent row's immutable `declared_size`
and `expected_part_sha256s: string | null`. For integer slot `n` in
`1..length(expected_part_sha256s)/64`, the expected digest is
`substr(expected_part_sha256s, (n - 1) * 64 + 1, 64)` (lowercase hex); the
expected size is `min(16777216, declared_size - (n - 1) * 16777216)`. The server
hashes the bounded request snapshot and checks its slot, size and digest in
the fresh D1 claim **before any S3 dispatch**. The claim does not expose the vector or
use client hashes. `NULL` preserves legacy fresh uploads and cannot authorize
suffix continuation. The same snapshot and digest feed the existing trusted
receipt path; a lost acknowledgement does not permit another dispatch.

No route creates a bound intent yet. Before enabling suffix continuation,
reconcile the acknowledged prefix with the verified file; never treat an
in-flight or uncertain slot as missing. Sealing must require an exact
acknowledged match to the full plan; a proposal alone cannot complete an upload.
