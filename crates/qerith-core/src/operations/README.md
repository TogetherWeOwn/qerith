# Operations contract v1

This is a transport-independent Rust contract and executable reference fixtures,
not a production REST, JSON-RPC or MCP server. There is no listener, database,
job runner, transfer implementation, crypto construction or second authority.
The existing immutable velmora pin and its mechanism boundary are unchanged.

## One definition, two projections

`REGISTRY` defines stable operation names, closed input schemas, output variants,
preconditions, effect class and implementation status. `rest_routes()` and
`mcp_tools()` refer to those exact definitions. Both call the same `dispatch`:

1. Require a trusted authenticated scope and supported contract version.
2. Validate exact fields, types, bounds, duplicates and mutually exclusive fences.
3. Authorize every target/handle before state disclosure or resource allocation.
4. Reject a recognized but unimplemented feature.
5. Check preconditions, then tenant/global resource and moderation policy.
6. Resolve a scoped cursor, when supplied.
7. Execute through the **one integration port**, then validate the output shape.

All REST descriptors currently use `POST /v1/operations/<name>` (including reads);
MCP descriptors use the same names but include only implemented operations, matching
capabilities. REST retains recognized unimplemented routes for explicit Unsupported
responses; direct calls to an unimplemented MCP name also return Unsupported.
These are internal projection contracts, not an assertion of S3/HTTP caching or MCP
wire conformance. The in-process `rest_request` and `mcp_request` wrappers decode
only a flat JSON argument object, not an HTTP request or JSON-RPC envelope. They
bound raw input (including whitespace/escapes) to `MAX_MESSAGE_BYTES` (65,536),
reject nested/null values, duplicate decoded keys, unknown fields, signed/floating
or overflowing numbers, and trailing data. A streaming visitor rejects unknown
keys before reading their values; only bounded scalar values enter `Fields`.
Existing registry validation still owns required fields, token syntax, numeric
ranges and destination fences. Scope and MCP session/mode are trusted caller
inputs, never JSON fields. Authentication, unsupported routes and experimental
MCP modes keep the existing projection precedence without parsing arguments or
entering the port. Parse errors use the same sanitized InvalidInput projections.
Unknown fields are never discarded. Serializers must preserve unsigned integers exactly (no
JavaScript floating-point rounding), absent totals as null/absence, and the
closed enum discriminants. Output schemas are the Rust `Output` variants, not
arbitrary backend JSON. A later wire serializer/schema emitter must project
these definitions rather than independently restating authorization semantics.

| Operation | Input binding / precondition | Output |
| --- | --- | --- |
| capabilities | authenticated scope, read policy | version and implemented operations; tasks=false |
| upload_initiate | destination reference, exactly one expected generation or if_absent=true, max_bytes, identity | scoped upload transfer plus job targeting the newly allocated generation |
| upload_commit / upload_abort | scoped transfer, exact reference+generation, identity | job / explicit cancellation outcome |
| browse | authorized parent, 1–100 limit, optional scoped cursor | bounded page of logical references+generations and opaque next cursor |
| stat | authorized reference+exact generation | metadata and logical availability, no physical locators |
| download_authorize | reference+generation, identity, valid logical availability lease | scoped, expiring, bounded download transfer |
| restore | reference+generation, positive requested availability_seconds, identity | durable authority-owned job handle |
| status / result | authorized scoped job | job / successful logical result; pending result is NotReady |
| cancel | scoped job and identity | best-effort cancellation with durable final outcome |
| copy | authorized source+generation, destination fence, identity | destination job/new generation; source must be logically available |
| delete | reference+exact generation, identity | logical deletion job, not remote erasure |
| versions | recognized, not implemented | Unsupported, never advertised as available |

The generic schema's integer ceilings are representation bounds, **not admitted
production object sizes, restore durations, costs, trial entitlements or SLOs**.
`admit` must enforce stricter measured/configured byte, lifetime, request, job,
waiter, concurrency, temporary-storage and cost ceilings. If those prerequisites
are unavailable it must reject, not use these representation bounds as defaults.
No current schema accepts keys, base64 bodies, hashes-as-authorization, integrity
bypasses, retention promises, provider selection or caller-supplied scope. An
unsupported required integrity/crypto feature is rejected, not silently ignored.

## The authority contract (integration must satisfy all of it)

`Scope` comes only from a credential-validating adapter; `Opaque::new` validates
syntax and proves neither authority nor unpredictability. The authority issues
unpredictable logical/transfer/job/cursor identities. Their redacted Debug output
is deliberate. There is no global content identity or existence API. Resolve
scope before existence and treat missing and foreign handles identically. Check
both copy endpoints, all nested generations and each status/result/cancel poll.
Never return a cross-tenant job, reference, result, entry or transfer, even if
physical bytes happen to be shared. The trusted port must validate each page
entry's ACL, not merely the parent ACL. Projection shape checks cannot substitute
for authority checks or make a malicious integration safe.

`authorize`, `preconditions` and `admit` are required hooks, not transaction locks.
`execute` must recheck all three **atomically with publication/effect**, using the
existing catalogue/job/outbox authority. It must reject stale-generation,
revoked, moderated, expired-transfer, incomplete-upload and missing-integrity
states. Upload commit means retained exact bytes, recoverable metadata and a
durable archival obligation committed together; it is not completed Usenet
verification or a restore lease. Abort wins only before commit. Copy creates its
own generation and no inherited download lease; incompatible encryption context
requires an explicitly supported client workflow, never provider decryption.
Delete removes a scoped reference, not propagated Usenet bytes or other tenants'
references. It must preserve reference-safe safety/serving leases.

`Request::reconciliation(scope)` binds version, tenant, principal, operation and
client identity. The authority also compares the **entire validated Request**;
reusing an identity with different input conflicts before any new effect.
Current authorization still applies to replay. Persist the accepted response and
job/outbox identity in the same commit; return that acceptance on a lost-response
retry, then use explicit status for current progress. Retention, expiry,
crash-recovery and retry limits belong to the authority's policy, not to a new
map in this module. `retryable()` is true only for Unavailable/QuotaExceeded with
None effects. Accepted, Committed and Unknown effects require explicit
reconciliation, not a blind retry, regardless of error code. Non-retryable integrity,
predicate and permission failures must not become an endless retry loop.

Cursor verification uses an authority lookup or a separately reviewed
authenticated encoding, **not** unsigned serialized offsets or a crypto invented
here. Bind tenant+principal, contract version, operation, parent/query, page limit,
snapshot/ordering and absolute expiry. Stable ordering/snapshot handling must
avoid duplicate/omitted entries across changes. Expired, forged, foreign or
mismatched cursors return InvalidCursor without exposing the binding. The
in-memory test fixture demonstrates lookup binding and invalidation, not durable
snapshot pagination or a production token generator.

Transfers are opaque bounded handles, scoped to identity/reference/generation,
direction, absolute expiry and byte ceiling. Resolving/redeeming one must check
current ACL/moderation and range/integrity policy again; returning the handle is
not permission to skip serving authorization. No bytes or decryption keys cross
this operation surface. An unrestored reference cannot be downloaded just
because a safety/cache copy exists. Restore publishes only verified whole-
generation bytes and a logical availability lease; GET never implicitly starts
restore. No time/STAT/sample evidence authorizes safety-copy eviction. Exact-
generation full readability/integrity on two independent backbones remains an
external requirement; this contract does not implement or certify it.

## Jobs, progress, errors and MCP tasks

Job handles refer to the existing authority's durable records. The fixture's
cloned in-memory maps model reconnect/reconciliation only; they prove no
persistence, crash safety or production scheduling. All long work is external.

`Progress` freezes its declared unit and optional total and rejects regressions
or exceeding a known total. None stays unknown, including after completion;
there is no invented percent. The authority persists monotonic sequence/fencing
across restart. `JobState::permits` defines terminal-state immutability and allows
cancel-requested work to finish if commit wins. A disconnect does nothing: only
explicit cancel/abort requests change job intent. Cancellation reports requested,
stopped-before-commit, already-committed or already-terminal; never rollback or
remote erasure. Coalesced work keeps per-waiter authorization and cancellation;
one caller cannot cancel another caller's required work.

`Failure` exposes only an enumerated code, static sanitized message, retry
classification and None/Accepted/Committed/Unknown effects. It cannot carry a
provider exception, credential, raw locator or another tenant's details. Output
schema violations become Internal+Unknown because a side effect may already
have committed. REST status is an envelope over the same outcome MCP returns as
`is_error`; structured domain codes/effects remain identical. This is not a
production MCP error-code/content-block specification.

Baseline MCP always uses operation handles plus explicit status/result/cancel
tools. Experimental task requests are rejected unless negotiated **and**
implemented; v1 implements none and capabilities always reports false. Even a
negotiated task request therefore returns Unsupported. Session negotiation is
trusted adapter input, not an ignored operation field.

## Verification

`tests/operation_parity.rs` exercises separately projected REST paths and MCP tool
names against the synthetic authority: every operation's authentication and
permission failure, closed/bounded inputs, precondition/quota ordering, sanitized
unknown-effect errors, upload lost-response reconciliation and abort/commit races,
status/result/cancel across transports, tenant/principal/reference/transfer/job
isolation, cursor query/operation/scope binding and invalidation, logical cold
state, unsupported tasks and monotonic unknown-total progress. Regression cases
also cover publication-time destination fences, fresh replacement generations,
unique accepted handles, immutable cursor receipts, authorized parent membership,
and terminal failed/cancelled results (never a perpetual NotReady).
`tests/operation_wire.rs` compares wire and typed calls for every implemented
operation, exact unsigned integers, malformed/duplicate/nested/forbidden inputs,
byte/token bounds, caller-scope isolation, replay, all domain error projections
and unchanged side-effect/hook counts. Full suites run in GitHub Actions via the
existing native, wasm, MSRV and dependency gates.

These are contract tests, not production conformance, cryptographic qualification,
real provider/cold-restore evidence or an approval to select a database/supplier.
Map this port once on integration; do not grow another authority in either
transport. REA angle: reuse accepted archive/client and lifecycle semantics and
the pinned engine, without copying/reimplementing its mechanisms.
