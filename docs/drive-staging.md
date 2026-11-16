# Drive staging and qualification

This document defines the staging requirements for Drive. It is not evidence
that a staging environment or qualification pipeline exists. The legacy Rust
CI and CodeQL checks remain required and are not replaced by Drive checks.

## Trust and deployment boundaries

- Run builds and full tests on GitHub Actions for the exact immutable commit
  being qualified. Record the commit, workflow run, jobs and artifact links.
- Only trusted repository-controlled workflow code and a trusted, explicitly
  selected commit may access the `staging` environment or deploy. Never run
  fork pull-request code with environment secrets. Use GitHub environment and
  ref controls as well as workflow checks; do not rely on a branch name alone.
- Use the existing staging S3 environment secrets by name:
  `QERITH_S3_ENDPOINT`, `QERITH_S3_BUCKET`, `QERITH_S3_REGION`,
  `QERITH_S3_ACCESS_KEY_ID`, and `QERITH_S3_SECRET_ACCESS_KEY`. Never print
  values or place them in artifacts, source, or test reports.
- Use the application's maintained-library WebAuthn authentication and D1
  sessions, including single-use invite and recovery flows and privileged,
  one-time owner bootstrap. Do not provision a Cloudflare Access application
  or deploy an auth-bypass mode. Actions must exercise real authentication with
  browser virtual authenticators and supported test identities.
- Apply only reviewed D1 migrations to the intended staging database. Record
  the migration ledger or explicitly record that no migration was needed, and
  record the previous known-good deployment and rollback procedure.
- No pipeline in this scope deploys or promotes production. A production deploy
  requires the separate release gate.

## Proposed main-only Actions / Wrangler path

This section is a design for review, not an enabled deploy workflow. The
current Worker deliberately returns 503, and the staging account's database,
resource bindings and native expiry controls have not been verified. Do not
run a deploy or migration until those prerequisites are met.

1. A manually dispatched workflow must reject any ref other than
   `refs/heads/main`. Check out the dispatch SHA without persisting credentials,
   verify the checkout SHA, and use pinned Actions and the repository's locked
   Node dependencies. Run the existing release-age and lockfile controls before
   installation and build. No pull-request code may access the environment.
2. Only after verifying that the `staging` environment enforces a main-only
   deployment branch policy may a privileged job use the existing environment.
   The intended Wrangler credential names are
   `QERITH_STAGING_CLOUDFLARE_API_TOKEN` and
   `QERITH_STAGING_CLOUDFLARE_ACCOUNT_ID`. Their availability and permitted
   scope are unverified; this design does not authorize creating them. Keep
   secrets out of command output, artifacts and the checkout.
3. Bind the reviewed staging Worker configuration explicitly to the verified
   staging D1 database and existing `qerith-drive-staging` bucket. Verify the
   actual database ID and binding names rather than guessing them. Review the
   migration set and target before `wrangler d1 migrations apply --remote`;
   retain the pre/post migration ledger and a known-good rollback target.
   Deploy the reviewed built Worker with `wrangler deploy` only after those
   checks and the real application integration are available.
4. Bind readiness and qualification to the dispatch SHA, actual deployed
   version, environment and explicit UTC use window. A reviewed staging-only
   deadline guard may reject new access after that window, before database or
   storage work; sessions and upload capabilities must not extend the window.
   This guard is admission expiry, not physical deletion or provider TTL.
   Bound in-flight work using supported provider execution limits.
5. Implement scoped cleanup and an independent trusted `workflow_run: completed`
   cleanup workflow for the originating run, including cancellation. Validate
   repository, workflow, main ref, run ID, attempt and deployed SHA before using
   cleanup credentials. Never execute downloaded artifacts or scripts from the
   originating run with those credentials. An independent workflow can itself
   fail or be cancelled; neither it nor `always()` proves provider cleanup.
   Live fixture admission remains held until the independent physical cleanup
   and retention controls below are verified.

No repository workflow, environment policy, Worker, database, credential, or
bucket has been created or changed by this design.

## Bounded active use and idle inventory

Staging is on demand and must not incur recurring always-on runtime charges.
Before enabling a staging environment, inventory every component and record
its actual idle behavior and billing: Worker requests, D1 compute, Containers,
Durable Objects including alarms and keep-alive, scheduled Workers, Stream
inputs and any other provisioned compute. An absent component should be recorded
as absent; a sleeping container alone does not establish that the estate is idle.
No schedules, alarms, probes or keep-alives may resurrect or sustain staging
outside its authorized window. A separately named request-driven Worker and D1
may remain deployed without inherently consuming idle compute; verify the
actual estate and account charges rather than assuming zero total cost. Storage,
existing subscriptions, lifecycle operations and database limits are separate
from idle compute. Worker Previews do not establish time-based expiry.

The trusted pipeline must establish startup and readiness before qualification,
with evidence binding the deployed revision, environment and bounded active-use
window. It must use supported native stop/scale-to-zero and cleanup or expiry
controls on success, failure and cancellation. Record actual cleanup/expiry
outcomes, not just a scheduled retry. If cancellation or provider controls
cannot guarantee bounded teardown, keep qualification held and identify the
missing control and its owner; do not add a host timer or scheduler as a
substitute. An always-on exception requires a separately authorized, dated
record naming its scope, cost and expiry or review date.

## Qualification and cleanup

Use synthetic data only and a unique, validated prefix per workflow run and
attempt. Cleanup must be restricted to that run's objects, outstanding
multipart uploads and test-identity-owned D1 rows; never empty a bucket or
remove another run's data. Preserve sanitized evidence of cleanup and report
failures without exposing credentials, JWTs, object contents or customer data.

Before fixture writes, verify the actual endpoint and its existing prefix-scoped
lifecycle policies for completed objects and incomplete multipart uploads; do
not overwrite unrelated bucket rules. R2 lifecycle expiry is asynchronous, not
proof of deletion at the active-window deadline. Do not assume that the named
S3 secrets identify an R2 endpoint or establish a policy or permission. Verify
an independently effective physical cleanup mechanism for test-owned D1 rows
and other residual state: session expiry, an inaccessible Worker, a queued
workflow or a later-run sweep does not establish physical deletion. If no such
mechanism is verified, record the affected retention bound and hold live fixture
admission; do not invent D1 TTL, a scheduler or a new resource.

Retain a sanitized manifest recoverable without the cancelled runner's final
artifact upload: SHA, environment, Worker version, run ID and attempt, UTC
window, fixture prefix and test-identity references, policy identifiers,
migration ledger and rollback target. Exercise cancellation after fixture
creation before live enablement. Record the independent cleanup run and its
scoped results, including verification of object, multipart and D1 row absence.
Provider expiry eligibility is not observed deletion; unresolved residual state
blocks further live fixture admission.

The real deployed application must pass bounded, authenticated UI and API
positive and negative checks, including cross-user isolation and nested read-only
sharing and revocation. Exercise the configured S3 provider through real multipart
upload, complete, list, head, get, range, abort and delete; verify sizes and
checksums, retries and uncertain completion, and persistence after restart.

Qualification includes an upload of at least 5 GiB and full download with
SHA-256 verification; interrupted and resumed upload and download of at least
1 GiB each; a zero-byte file; 20 selected uploads; and a 5,000-item folder.
Bound fixture generation, storage, artifacts and runtime to the existing resource
limits. Fixture provisioning must not add a public backdoor. Timeouts are
failures, not successful cleanup or proof of qualification.

The staging run must tie readiness, tests, migration ledger, cleanup and
sanitized artifacts to the same exact commit and environment. Keep exact-head
Actions links and conclusions with the change. Do not treat the synthetic
archive-server qualification as evidence for this outbound S3 client.

## Prerequisites still to establish

Before enabling deployment, verify the actual Cloudflare account and existing
Worker, D1, deploy authorization, supported fixture identities and native
expiry/cleanup capabilities. Verify the app's real
integration interfaces and reviewed migration/rollback behavior. A connected
provider alone does not prove any of these capabilities. Missing access,
credentials, paid capacity or unsupported lifecycle controls must be routed to
their proper owner; this document authorizes none of those changes.
