# In-process product service reference

`service::Service` implements the delivered `operations::OperationPort` against
`MemoryCatalogue` and the existing composition service. It does not listen on a
network, choose a DB, schedule workers or operate a plaintext gateway. Native
`native_bytes` decodes the bounded native protocol and `native_call` uses the
reviewed native request/response validators. REST/MCP use the same registry and
operation port, never separate domain implementations.

## Trust and admission

Authentication happens outside this library. `Scope` and the native handler's
container are trusted adapter arguments, never extracted as authority from a
request. `Access` resolves a current tenant, grants for every reference, container,
key/envelope reference and admission policy. It is a live port, not checkpointed
policy. Missing and foreign handles return the same sanitized denial. Catalogue
transactions recheck live authority with the effect. Moderation and serving-pin
fences remain catalogue-owned.

There is no built-in crypto suite. A deployment supplies the independently reviewed
native profile registry. The synthetic test's `unqualified_mock` is deliberately
not an AEAD/OPRF claim. Only opaque key/envelope references cross the request API;
no keys or base64 file bodies are accepted.

The operation registry's upload initiation contains only logical identity, fence
and byte budget, not a ciphertext descriptor. The native descriptor ingress binds
a validated `UploadIntent` to authenticated scope plus initiation identity.
`bind_upload` is the corresponding **trusted adapter ingress** for REST/MCP; it is
not a public unvalidated wire endpoint. A REST/MCP integration must resolve that
same descriptor before initiating. It cannot invent metadata or infer it from an
object hash. Native initiation performs this binding itself. Copy and delete are
registry operations; the current native wire enum has no invented copy/delete or
result variant. Native status/cancel support upload and restore jobs only; copy/delete
job handles explicitly return `UnsupportedProfile` rather than masquerading as uploads.
REST/MCP status/cancel/result support copy/delete and expose their committed logical
targets. Native and operation opaque identities share the same bounded 128-byte
alphanumeric/`_-.:` alphabet, preserving punctuation without lossy casts or aliases.
Native ciphertext ranges are explicitly unsupported by
this adapter, rather than silently expanded to whole-object downloads.

Upload descriptor ingress uses the native stored-ciphertext and metadata validator,
including canonical lowercase checksum syntax. Bound key/envelope and parent grants
are rechecked on initiation, staged progress, resume, verification, commit and worker
entry, including replays. The ingest authority also rechecks them at catalogue effects,
so a grant revoked while storage runs cannot authorize publication.

## Copy identities and contexts

Copy requires a currently available exact source, source key/envelope grants and
access to every source parent inherited by the destination. A deployment must also
explicitly qualify unchanged-C reuse through `Access::copy_compatible`; the default
is false. A supported profile or key grant alone does not prove compatibility with
a new logical target. The synthetic fixture opts in only for `unqualified_mock`.

Every accepted new copy reserves a fresh **logical** destination generation. Its
persisted bound descriptor contains the unchanged C/metadata, underlying catalogue
storage generation and destination reference revision. All lookup, browse, native,
job, restore and transfer boundaries resolve that binding, never accept a storage
ID as an alternate logical ID, and fail closed after an out-of-band revision change.
Copy uses a real catalogue Link, retaining one physical ciphertext lifecycle for
verification, moderation, pins and deletion. It does not clone storage evidence or
inherit source availability. The destination requires its own explicit restore.
Re-copying the same physical ciphertext still changes logical G and reference
revision, fencing old jobs and pins. Bindings survive checkpoint/reconnect and are
bounded with the other service records. Model-transaction rollback includes Link,
binding, job, identity allocation, membership and accepted-response replay. Copy's
key, parent and context grants are checked again by its effect-time catalogue
authority. Reconciliation rechecks those retained grants and the live destination
binding/moderation, not the old source's execution-only availability lease or
continued existence. Repeated uploads of the same C use a distinct stable
per-upload storage-generation validator; repeatable C is never used as unique G.
Catalogue operation and storage-generation identities use the catalogue's shared
allocator, including when infrastructure callers interleave mutations. Public
handles and logical generations use a separate checkpointed service sequence.
Write-only replacement, copy destinations and deletion resolve the known logical
G through the catalogue's write-target contract plus tenant/revision/validator
binding; they do not acquire Read or treat a denied lookup as absence.

## Transfer and jobs

1. Initiation reserves a scoped reference-model handle and generation with a
   fixed expiry, budget and destination fence. No provider I/O occurs.
2. Trusted transfer I/O checkpoints exact monotonic ciphertext offsets with
   `staged`. `resume` reconciles the same handle after disconnect/reconnect.
3. A trusted full-byte verifier supplies `verify_staged` with a complete-copy
   receipt. Syntax or client checksum assertions do not establish this receipt.
   The current service profile carries only the full length/SHA-256 identity;
   auxiliary `CompleteCopy.checksums` must be empty because no auxiliary checksum
   algorithm/parts were negotiated. Nonempty lists are rejected, not verified or
   silently discarded.
4. Commit accepts a bounded job. `finish_upload` explicitly invokes the delivered
   `composition::ingest` against storage and policy ports. Storage must reconcile
   the staged inventory identified by the scoped intent, verify length/digest,
   and return a complete immutable copy. No transfer body enters REST/MCP fields.
5. The existing catalogue atomically commits reference, archive job and outbox.
   Its archive worker remains `composition::run_once` with the same engine pin.
6. Restore accepts an explicit whole-generation job/subscription. The existing
   worker fully reconstructs C, verifies its whole identity and publishes the
   catalogue lease before download authorization. Status/result never perform
   hidden provider I/O. Closing a polling connection does not cancel the job.
7. Download authorization acquires a generation-bound serving pin, bounded by
   the logical availability lease. `redeem` rechecks scope, current grant,
   generation, moderation, expiry and pin. Physical bytes alone grant nothing.

Cancellation is non-rollback: a committed job reports already committed; an
unstarted upload can stop before commit; restore cancellation removes only its
own accepted subscription. An interrupted/uncertain storage attempt retains a
cleanup/reconciliation obligation instead of claiming no effects. Polling does
not extend deadlines. Unknown effects remain unknown through fresh commit identities,
worker clock failures, record/byte-policy rejection, revision/expiry/cancellation
fences, pending NotReady results and deadline Result failures. Shared rejection
projection retains only authorized, scope-bound job effects; missing, foreign or
revoked handles still return a sanitized denial without job state. Rejected restore
replays likewise retain the accepted subscription obligation under tighter policy.
Retry waits after a claimed restore remain logically Running, including after reconnect.
Native commit receipts are retained before response authorization: losing Read
during storage denies delivery, not the already-committed reconciliation record.
Uncommitted upload job access and upload worker reconciliation (including successful
re-entry after reconnect) use Write. Stat, Status and Result disclosure of committed
objects still require Read. Restore admission/replay
and subscription cancellation require Restore; cancellation does not require Write.
Physical restore completion is projected as success only for the exact subscription
recorded at publication, never for an excluded logical reference. Native restore
`max_seconds` also bounds the worker deadline (the operation registry exposes the
same optional field independently of `availability_seconds`).
A new commit identity cannot clear cleanup-aware cancellation
or restart storage. Native resume/restore/status replays retain their original,
already-validated progress/status while still checking current request authority;
they do not falsely validate historical progress against the latest state.
The current byte ceiling is checked against retained upload descriptors at commit
admission and worker entry, and against resolved object lengths at restore/download
admission and pin redemption, including after reconnect with tighter limits.
Explicit model record, byte, lifetime and retry ceilings
are test parameters, not measured product entitlements. Resource reclamation and
production capacity policy are not implemented by this reference fixture.

## Restart and pagination

`ReferenceModel` is an explicit cloneable **non-durable** model value containing
catalogue, outbox, issuance history, request reconciliation, progress and cursors.
`checkpoint`/`reconnect` simulate restart/reconnect while rebinding fresh live
access; they are not disk persistence, backup, or a production database. Clock
rollback fails closed. Generated sequential IDs are reference-model identifiers,
not qualified production bearer tokens or claims of unguessability.

Browse cursors retain bounded immutable model snapshots, scoped to principal,
container, query limit and expiry. Each continued entry is rechecked against
current authority and generation, including direct `execute` calls. Cursor retries
do not mutate their position and reuse an equivalent unexpired successor rather
than allocating repeated continuation rows.
No global content identity, provider location, or key material appears in public
operation errors.

## Verification and qualification boundary

`tests/composition/service.rs` reuses the existing composition fixture and its
pinned velmora synthetic NNTP ARTICLE/yEnc path; no engine implementation or
second cold-store simulator is copied into the service. The golden path covers
native negotiation/initiate/interrupted resume/commit, metadata, REST/MCP
browse/stat/copy/cancel/status/result and explicit cold restore before a pinned
download. Requests pass through the bounded native JSON decoder and the merged
REST/MCP argument decoders, not just the typed projections. Negative cases record
matching errors and upload/job/transfer allocation counts (not a complete inventory
of auxiliary reference-model or catalogue rows). Regression coverage includes
clock-advanced retry, retained uncertain effects, cancellation without new I/O,
moderated upload/copy results and replays, allocation-free reconciliation at the
record limit, and native cleanup-aware cancellation with same-ID replay.

Admission reserves the actual delta for the combined upload/job/download/cursor/
operation-replay record pool, including a held completion-binding slot for each
accepted upload. Native capability negotiation reserves both session and replay
rows. Existing exact-request replays consume no capacity,
but still pass current authority, precondition and resource-policy checks.
Descriptor bindings and native sessions/replay each retain their own bounded pools;
these reference limits are not a production memory-budget qualification.

Actions uploads `service-positive.json`, `service-negative.json` and the exact PR
head SHA in `product-service-<head>` artifacts. PR jobs explicitly check out that
head, and evidence asserts `git rev-parse HEAD` matches it and records the tested
SHA separately. Merge-group jobs still test their queue SHA. The normal native, wasm, MSRV,
cargo-deny and aggregate checks remain required. No local full suite is used.
The artifact uploader is pinned to the verified v4.6.2 SHA, reads only the named
synthetic evidence directory, excludes hidden files by default and expires after
seven days. No Cargo manifest/lock or engine pin changes; Cargo has no stable
blanket release-age/build-script suppression, so the existing locked graph and
isolated Actions builds remain the controls, not a new supply-chain guarantee.

This proves transport/domain invariants and synthetic byte/metadata behavior
only. Trusted-client AEAD/OPRF, authenticated readability on genuinely independent
real backbones, browser delivery trust, provider/cold qualification, public hosting,
legal/abuse operations and launch acceptance remain separate gates. No UI,
preview, sharing/recovery experience, deployment or live provider probe is added.
