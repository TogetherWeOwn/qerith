# Drive private production release runbook

**Do not dispatch the inert workflow.** It has no provider write, migration,
storage binding, or credential step. The environment job is deliberately
unreachable. Enabling a real release requires a separately reviewed change,
production storage authorization, and independent Release Manager acceptance
of the exact SHA. Never reuse staging storage or credentials.

## Prerequisites and preflight

- Before merging the inert workflow, verify the `production` GitHub environment
  exists and its custom policy allows only the `main` branch (no tags). Do not
  let a workflow create the environment or add secrets during scaffold setup.
- Release Manager approval is recorded on the release task, not in GitHub
  environment reviewers. The Operator initializes the nonsecret repository
  Actions variable `PRODUCTION_ACCEPTED_SHA` to `UNAPPROVED` and writes a real
  SHA only after the Release Manager accepts that exact SHA on the release task.
  Reset it to `UNAPPROVED` if that acceptance is withdrawn.
- The only trigger is a manual dispatch from `main`. `accepted_sha` must be a
  lowercase full commit SHA reachable from protected `main` and match
  `PRODUCTION_ACCEPTED_SHA` exactly. An unset variable, the setup sentinel,
  or a different SHA fails before the GitHub evidence lookups.
- Only after staging verification and cleanup succeed, publish
  `drive-staging-qualification-<tested-sha>-attempt-<GITHUB_RUN_ATTEMPT>`
  from the same-repo, main-only `drive-staging-qualification.yml` dispatch at
  that tested SHA. Never publish on failure or skip.
  Preflight checks GitHub metadata for the successful attempt's unexpired
  receipt; it does not read its payload or confer production approval. Missing
  evidence, including an unavailable API, is a stop.
- Use the [staging runbook](drive-staging.md): pipeline-owned on-demand startup
  and SHA-bound readiness, a bounded active window and native cleanup/expiry on
  success, failure or cancellation. Verify zero recurring idle staging/preview
  runtime charges; never use a keep-alive to keep qualification available.

## Before an approved production release

1. Record the candidate SHA, qualification run and artifact, required CI and
   Security/QA results, and the Release Manager's exact-SHA acceptance. Confirm
   private admission (owner plus invites) and approved production-only bindings.
2. Read the production D1 `d1_migrations` ledger and compare names/order against
   the migrations at the accepted SHA. Record which forward entries are already
   applied and which are pending, or record no migration. Stop on drift,
   unexpected entries or an unreviewed change; never rewrite applied migrations.
3. Before applying anything, capture a production D1 Time Travel bookmark,
   confirm its restore window and database identity, and record the prior
   known-good Worker version/config and rollback owner. On a first release with
   no prior version, record the tested route-disablement plan instead. Retain
   sanitized before/after ledger and target evidence in the release record.

## After an approved deploy

- Check health and the deployed SHA without exposing credentials or private
  data. Verify an invited principal can sign in and an anonymous, uninvited or
  revoked principal is denied; check direct API access as well as the UI.
- With a dedicated permitted identity and a disposable object, upload, list,
  download and compare bytes/checksum. Verify another principal cannot read
  it. Clean up only the smoke fixture and record sanitized outcomes.
- On failed health, auth, smoke or ledger verification, stop rollout and notify
  the Release Manager. Disable admission or revert to the recorded known-good
  Worker if compatible with the current ledger. If database recovery is needed,
  stop writes and reconcile changes made since the bookmark before an authorized
  Time Travel restore; do not discard post-bookmark writes or assume a D1 restore
  rolls back object storage. Verify ledger, bindings, private denial, health and
  permitted data access before reopening. Record rollback and cleanup evidence.
