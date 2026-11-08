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
| `empty_spool_post_exact_eviction_and_three_adapter_restore_states` | ARTICLE verification fails on initially unposted spools; the worker performs six real synthetic engine POSTs; exact-G deletion candidate/finalization/dispatch/ack empties delivery and staging. Queued and actually claimed Running states deny reads; the worker reconstructs once, validates the full generation and publishes; all three projections authorize equivalent handles, expiry and exact bytes. Lease expiry denies fresh reads and already-issued handle redemption even while complete bytes remain; the native lane also replays its issued download response at expiry. |
| `twenty_scoped_subscribers_coalesce_cancel_one_and_reconnect` | Twenty distinct authenticated principal scopes receive twenty distinct logical handles but one physical restore/outbox event. Cancel-one leaves nineteen live; an explicit model reconnect and lost-response identity replay add no job. One cold reconstruction completes the remaining subscribers. A foreign principal and tenant cannot inspect another scope's job. |
| `same_reference_second_scope_is_conflict_not_another_subscription` | A second principal on an already-subscribed reference revision receives an explicit native/REST/MCP precondition failure, without allocations or extra outbox work. Same-name subscriber fanout remains unsupported. |
| `last_cancel_avoids_physical_work_across_adapters` | Cancelling the last demand retires the job with no additional I/O trace events, cold fetch, cache entry or outbox work. Native, REST and MCP agree on cancellation and terminal state. |
| `failed_and_deadline_expired_restore_never_authorize_reads` | Injected integrity failure and exact job-deadline expiry produce failed projections, no authorized bytes, no completed cache, and no cold retrieval. REST/MCP Result returns an error. |
| `lost_publication_reuses_verified_completion_without_second_cold_fetch` | Full physical completion without publication does not authorize a read; a stale fence cannot publish. Reconnect and worker retry verify/adopt the original immutable completion without another cold retrieval or replacement version. |
| `current_tenant_revocation_removal_and_moderation_gate_all_projections` | After successful restoration, tenant mismatch, current reference revocation, tombstone and prohibited moderation deny status, stat, new restore, new download and old-handle redemption without allocations or new outbox work. |

Each native projection runs from the same pre-operation explicit service
checkpoint as REST and MCP, with the same live access/storage ports and clock.
REST and MCP domain outputs/errors and allocation counts are compared exactly.
Native admission/status/transfer fields are compared after their declared schema
projection. Fresh polling request IDs avoid confusing issued native replay
history with current status. Every scenario runs three lanes, retaining native,
REST and MCP mutation history in turn. Later worker, cancellation, serving-pin
redemption and reconnect assertions therefore exercise each adapter's retained
side effects. In the native lane, lost-response replay uses the actual issued
native replay record rather than only a REST-created operation identity.

The catalogue admits only one live subscription per logical reference revision;
a second principal on the same reference gets an explicit conflict, not a second
subscription. `same_reference_second_scope_is_conflict_not_another_subscription`
asserts that unsupported shape in all adapters. The twenty-subscriber fixture
uses the supported shape: a one-second retained-source availability lease and
public REST/MCP logical Copy create twenty independent names sharing the exact
same immutable storage generation. After expiry and lawful cache eviction,
twenty principal-scoped jobs on these names coalesce into one physical cold job.
Cancelling one leaves that name unavailable while the nineteen others publish.
These are scoped jobs/reference subscriptions, not twenty sockets. No private
service binding or second scheduler is invented to make same-name fanout pass.

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
  exposes the more specific operations error. Expired issued native Download
  replay fails response validation with `GenerationMismatch`; fresh admission
  fails with `Unavailable`. Both deny access. Authority-negative probes have
  valid negotiated sessions, including the foreign tenant, and assert native
  `NotAuthorized` plus equal REST/MCP failures and no side effects.
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
