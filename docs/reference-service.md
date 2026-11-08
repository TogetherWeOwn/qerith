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
result variant. Native status exposes the same job; REST/MCP result exposes its
committed logical target. Native ciphertext ranges are explicitly unsupported by
this adapter, rather than silently expanded to whole-object downloads.

## Transfer and jobs

1. Initiation reserves a scoped reference-model handle and generation with a
   fixed expiry, budget and destination fence. No provider I/O occurs.
2. Trusted transfer I/O checkpoints exact monotonic ciphertext offsets with
   `staged`. `resume` reconciles the same handle after disconnect/reconnect.
3. A trusted full-byte verifier supplies `verify_staged` with a complete-copy
   receipt. Syntax or client checksum assertions do not establish this receipt.
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
not extend deadlines. Explicit model record, byte, lifetime and retry ceilings
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
current authority and generation. Cursor retries do not mutate their position.
No global content identity, provider location, or key material appears in public
operation errors.

## Verification and qualification boundary

`tests/composition/service.rs` reuses the existing composition fixture and its
pinned velmora synthetic NNTP ARTICLE/yEnc path; no engine implementation or
second cold-store simulator is copied into the service. The golden path covers
native negotiation/initiate/interrupted resume/commit, metadata, REST/MCP
browse/stat/copy/cancel/status/result and explicit cold restore before a pinned
download. Negative cases record matching errors and allocation counts.

Actions uploads `service-positive.json`, `service-negative.json` and the exact PR
head SHA in `product-service-<head>` artifacts. The normal native, wasm, MSRV,
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
