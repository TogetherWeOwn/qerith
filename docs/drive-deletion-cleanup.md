# Drive deletion cleanup (closed)

Both paths are off by default. The generated Worker's default export supplies no
capability, and no Wrangler config adds a trigger or opt-in. Request headers,
flags, upload receipts and offline probes cannot supply the capability.

The exact staging confirmation POST and the staging scheduled event are
admitted separately (`DRIVE_STAGING_DELETE_REQUESTS` and
`DRIVE_STAGING_DELETE_DRAIN`, respectively). Both require a server-supplied
permanent-removal rule for the actual normalized endpoint, bucket, storage epoch,
and signing region. The scheduled callback only accepts the designated cron
expression and has no HTTP entry point.

## Protected Worker composition

Trusted Worker entrypoint code can call `createDriveWorker(capability)` on the
generated module. Both callbacks use the same `WorkerDeletionCapability`:

- `sourceSha`, `workerVersion` and `expiresAt` must exactly match the active
  qualification bindings, including native Worker version metadata and a live
  qualification window. Expected values must come independently from the
  protected lane's verified candidate record for the exact upload attempt, not
  from the active bindings themselves. That record is not a runtime transport;
  the version is only known after upload. No handoff is implemented here.
- `storageConfigId` and `region` must match `storageIdentity` for the active
  endpoint, bucket, epoch and signing region. The protected lane must pass
  `proveConditionalDelete` against that exact storage using an exclusively held
  synthetic object and authoritative reads, and separately verify that the
  provider exposes a positive signal for permanent removal on each signed
  conditional DELETE. `confirmsRemoval` is the reviewed code-held matcher for
  that signal, not the probe's pass bit, a status code, subsequent absence or
  the provider's name. Delete markers and ambiguous or lost replies cannot
  qualify as permanent removal.

No live provider rule or trusted runtime handoff is currently supplied. If either
is unavailable, leave the binding closed; do not emit a passing qualification.

After a committed journal, HTTP can attempt one bounded pass scoped to that
journal. HTTP 202 reports the commit, not provider removal. Unconfirmed and
unattempted jobs remain in D1; a scheduled invocation needs no request state
or journal ID. It uses the same historical-identity and lease fences. An
ambiguous reply, including apparent absence after a lost reply, is not a receipt.

## Proposed cadence and capacity

After separate qualification and release approval, propose one invocation every
15 minutes. Each invocation attempts at most eight due ledger jobs, oldest
`available_at` first. It uses the existing 60-second fenced leases, five-second
storage request bound and five-minute retry delay for unconfirmed attempts.
No invocation loops over batches. At that cadence the theoretical ceiling is
768 attempts per day, including retries, not 768 confirmed deletions. Missed
ticks, contention, D1 latency and provider failures reduce usable throughput.

## Deadline detection and response

A separately operated check should sample the primary ledger every 15 minutes,
independently of drain success. Use D1 time and `created_at`, never the mutable
`available_at`, to compute age. Count all jobs with `completed_at IS NULL` and
`created_at <= unixepoch() - 23 * 3600` as approaching the deadline. At
`24 * 3600`, page the Drive on-call for overdue undelivered work, including
leased, deferred and storage-identity-mismatched jobs. Also page on missing
observations and on durable receipts where `completed_at - created_at > 86400`
so a late completion between samples does not hide a breach. Alert on counts
and ages, not object keys or credentials. On-call checks scheduler and ledger
health, escalates unresolved removal proof to the storage incident owner and
keeps the job unconfirmed until exact evidence exists. No evidence is inferred
from absence, and no fallback delete is authorized.

## Required qualification

Fixtures prove bounded catch-up and fenced settlement with synthetic proof;
moving a job's due time does not establish the live 24-hour objective. Qualify
exclusive mutation, atomic conditional deletion and permanent removal for each
exact endpoint, bucket and epoch, including distinguishing removal from absence
and version markers. Measure enqueue-to-receipt elapsed time against real
scheduler delivery, queue load, missed ticks, storage outages, lost responses,
and D1 recovery. Demonstrate escalation and catch-up under those conditions and
account separately for objects that do not qualify for a ledger job. No live
qualification, activation or deployment is part of this change.
