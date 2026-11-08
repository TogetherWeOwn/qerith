# Synthetic archive adapter parity

`crates/qerith-core/tests/archive_parity.rs` exercises the existing product
service, byte-decoding native/REST/MCP adapters, catalogue, composition worker,
and the shared `archive_clients/storage.rs` synthetic NNTP fixture. It adds no
scheduler, provider adapter, dependency or engine fork. The only storage wrapper
supplies native upload staging; all POST, verification, cold reconstruction,
whole-copy validation and completed-inventory reuse delegate to that fixture.

## Row mapping

These are executable assertions, not a claim that an unexecuted revision passed.
The exact-head GitHub Actions `rust test (native)` job runs the test target as
part of `cargo test --locked --workspace`. A failed assertion is a red row.
No local suite or service execution is used as CI evidence.

| Test | Assertions |
| --- | --- |
| `empty_spool_post_exact_eviction_and_three_adapter_restore_states` | ARTICLE verification fails on initially unposted spools; the worker performs six real synthetic engine POSTs; exact-G deletion candidate/finalization/dispatch/ack empties delivery and staging. Queued and actually claimed Running states deny reads; the worker reconstructs once, validates the full generation and publishes; all three projections authorize equivalent handles, expiry and exact bytes. Lease expiry denies reads even while complete bytes remain. |
| `twenty_scoped_subscribers_coalesce_cancel_one_and_reconnect` | Twenty distinct authenticated principal scopes receive twenty distinct logical handles but one physical restore/outbox event. Cancel-one leaves nineteen live; an explicit model reconnect and lost-response identity replay add no job. One cold reconstruction completes the remaining subscribers. A foreign principal and tenant cannot inspect another scope's job. |
| `last_cancel_avoids_physical_work_across_adapters` | Cancelling the last demand retires the job with no additional I/O trace events, cold fetch, cache entry or outbox work. Native, REST and MCP agree on cancellation and terminal state. |
| `failed_and_deadline_expired_restore_never_authorize_reads` | Injected integrity failure and exact job-deadline expiry produce failed projections, no authorized bytes, no completed cache, and no cold retrieval. REST/MCP Result returns an error. |
| `lost_publication_reuses_verified_completion_without_second_cold_fetch` | Full physical completion without publication does not authorize a read; a stale fence cannot publish. Reconnect and worker retry verify/adopt the original immutable completion without another cold retrieval or replacement version. |
| `current_tenant_revocation_removal_and_moderation_gate_all_projections` | After successful restoration, tenant mismatch, current reference revocation, tombstone and prohibited moderation deny status, stat, new restore, new download and old-handle redemption without allocations or new outbox work. |

Each native projection runs from the same pre-operation explicit service
checkpoint as REST and MCP, with the same live access/storage ports and clock.
REST and MCP domain outputs/errors and allocation counts are compared exactly.
Native admission/status/transfer fields are compared after their declared schema
projection. Fresh polling request IDs avoid confusing issued native replay
history with current status. The main lifecycle advances through REST while
independent native/MCP checkpoint projections exercise the same real handlers.

Twenty scopes here share authorization to one tenant's logical reference; these
are independent scoped job handles, not twenty sockets or twenty different ACLs.
Cancellation removes demand, not the principal's independent read grant to that
reference. Per-reference cancellation/revocation/removal with separate linked
names is also covered in the existing composition test
`cold_restore_coalesces_twenty_scoped_subscribers_before_delivery`.

## Deliberate API boundaries and unqualified rows

- Native Stat returns the exact object descriptor, **not** an availability field.
  REST/MCP Stat reports logical availability. Native availability is checked by
  Download admission, not an invented native Stat flag.
- Native has no separate Result action. REST/MCP Result is tested; native Status
  is the supported terminal-state projection. No three-way Result PASS is claimed.
- Native Download and REST/MCP AuthorizeDownload issue scoped handles, **not**
  HTTP/MCP byte streams. Tests redeem the actual issued serving pin, revalidate
  the catalogue, and read/hash the full immutable generation through the shared
  qualified-cache port. They do not claim a network download-server test.
- The concrete native service bridge rejects ranged Download; the operations
  download schema has no range field. S3 range and raw signing vectors remain
  separate existing tests, unchanged by this contribution.
- Wire error vocabularies differ: REST/MCP `NotAvailable` maps to native
  `Unavailable`; authority resolution can fail closed before the native bridge
  exposes the more specific operations error. Authority-negative rows assert
  denial/no disclosure and no side effects, not invented identical wire enums.
- Reconnect imports an explicit **non-durable reference model**. It is not a
  database restart, process crash, socket-disconnect or remote exactly-once proof.
- The 3 KiB opaque fixture and SHA256 checks are software test inputs, **not**
  encryption/AEAD/OPRF, trusted-client readability, provider durability or real
  backbone-independence evidence. Two simulated spools are explicitly not
  independently qualified providers. Sizes and durations select no product limit,
  customer plan, price or retention policy.
- Native copy/clone has no action. The supplied reference-model clone/reconnect
  is exercised; REST/MCP logical Copy and S3 Copy retain their existing tests.
  This contribution does not relabel copy as a native operation.

Existing Security, Crypto, QA, required Actions and review gates remain in force.
The contribution is integrated through the archive-client integration PR; it is
not independently merged or evidence of deployment/production qualification.
