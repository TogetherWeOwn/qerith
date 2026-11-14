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

## Bounded active use and idle inventory

Staging is on demand and must not incur recurring always-on runtime charges.
Before enabling a staging environment, inventory every component and record
its actual idle behavior and billing: Worker requests, D1 compute, Containers,
Durable Objects including alarms and keep-alive, scheduled Workers, Stream
inputs and any other provisioned compute. An absent component should be recorded
as absent; a sleeping container alone does not establish that the estate is idle.
No schedules, alarms, probes or keep-alives may resurrect or sustain staging
outside its authorized window.

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
