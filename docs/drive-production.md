# Drive first private production release

[Deploy Drive production](../.github/workflows/deploy-drive-production.yml)
is a protected manual workflow for the first private release. Run it only from
`main` in a dedicated release task after [staging verification](drive-staging.md),
exact-candidate review and independent release approval. Keep admission limited
to the owner and invited members. The checked build caps uploads at 16 MiB +
257 bytes (16,777,473 bytes). Permanent deletion and its scheduled drain are
disabled.

## Before approval

1. Confirm required CI, PR standards, secret scanning and tier reviews for the
   candidate. Wait for the successful `ci` and `gitleaks` push runs on the exact
   main SHA. Run the protected `drive-first-release-smoke.yml` workflow at that
   SHA. Record its run ID, attempt, build digest and all passing outcomes. The
   single success-only artifact
   `drive-first-release-smoke-<full-sha>-attempt-<run-attempt>` contains
   `receipt.json` with the source SHA, immutable build digest, staged Worker
   version, tested cap, case outcomes and cleanup result. An expired artifact,
   new attempt, changed build or changed main tip requires fresh evidence and
   approval.
2. Verify the GitHub `production` environment already exists, its custom branch
   policy allows only the `main` branch, and the production credentials and
   variables resolve from that environment. Check scope and custody through the
   established provider and GitHub authorities. Use dedicated production
   identities throughout. Verify the production-only D1 database and private
   R2 bucket named `qerith-drive-production` in the existing Cloudflare account.
   Record the actual D1 UUID, bucket jurisdiction, storage epoch, Worker name
   and `https://qerith-drive-production.5150.workers.dev` origin. Confirm the
   dedicated Worker does not exist, both R2 public-domain surfaces are off,
   and no custom route, preview, trigger or service binding can reach the
   Worker. The workers.dev route is the sole intended serving surface and the
   switch-off control.
3. Establish the narrow production release window with the custodian. Confirm
   that D1 and R2 have no other active consumers, writers, queued provider
   operations or outstanding write URLs. Verify the effective scopes and
   custody of a Cloudflare metadata/D1 reader, the Cloudflare deploy identity,
   a bucket-only R2 reader, and the dedicated Worker R2 signer. Keep the
   exclusion of other writers in effect through migration and activation.
   The workflow reads the exact targets. The release reviewer must independently
   establish the authority and coverage of those reads and the writer exclusion.
4. Confirm D1 has no app schema or migration ledger and R2 has no objects or
   open multipart uploads. Use a D1 query against `main.sqlite_schema` and
   whole-bucket S3 `ListObjectsV2` and `ListMultipartUploads` with a one-item
   provider limit, no prefix or delimiter and explicit non-truncated results.
   Count only. Record classifications and outcomes without row data or object
   names. Stop if any target, emptiness result, scope or writer status is
   unknown. A pre-existing app schema, even with no rows, needs a separate plan.
5. Obtain the current Time Travel bookmark for that exact D1 UUID. Verify
   Time Travel is available and read back the bookmark around the empty-target
   checks. Confirm the provider's retention window. Retain the actual bookmark
   in the restricted release record with the database identity and timestamp.
   Record its SHA-256 for the workflow. Prepare and rehearse the route switch-off
   on disposable infrastructure, and confirm the release operator can run it and
   observe denial. Under working model §2 step 8d, a confirmed empty first
   release defers the restore drill. The bookmark and switch-off plan are
   required before the first schema change.
6. Have the independent release reviewer record `APPROVE` on the dedicated
   release task for the SHA, staging run/attempt, build digest, provider
   evidence, verified bookmark, writer exclusion, owner bootstrap, switch-off
   procedure and watch. If the evidence changes or any recovery condition is
   unsafe, stop and obtain a new decision.

## Configure the accepted release

The release operator updates the repository Actions variable
`PRODUCTION_ACCEPTED_SHA` from `UNAPPROVED` only after independent acceptance.
Set the following JSON variables in the `production` environment.

- `DRIVE_PRODUCTION_TARGET` contains `accountId`, `worker`, `origin`, `d1Id`,
  `r2Bucket`, `storageEpoch` (a dedicated `prod-…` epoch), and
  `credentials`. The credential keys are `cfRead`, `cfDeploy`, `r2Read`,
  `r2App` and `owner`. Each value is the lowercase SHA-256 of the matching
  secret, or of the access key ID and secret joined by one NUL byte in that
  order for R2. Compute the digests in credential custody. Keep raw values and
  operator input out of shell history and the release record.
- `DRIVE_PRODUCTION_APPROVAL` contains `sourceSha`, `buildDigest`,
  `stagingRunId` (string), `stagingRunAttempt` (integer), `targetDigest`,
  `bookmarkDigest`, and `expiresAt` (UTC, at most one hour from deployment).
  Use lowercase SHA-256 of the target's sorted-key compact UTF-8 JSON with no
  trailing newline for `targetDigest`. Use the lowercase SHA-256 of the
  approved bookmark bytes with no trailing newline for `bookmarkDigest`.
  Set the expiry within the independently approved custody and write-exclusion
  window. Keep the reviewer decision and private evidence in the release task.

| Production environment secrets | Effective scope |
| --- | --- |
| `DRIVE_PRODUCTION_CF_READ_TOKEN` | Cloudflare read authority for exact Worker, D1, Time Travel and R2 metadata plus read-only D1 SQL |
| `DRIVE_PRODUCTION_CF_DEPLOY_TOKEN` | Cloudflare authority for the dedicated Worker and D1 deployment operations |
| `DRIVE_PRODUCTION_R2_READ_ID`, `DRIVE_PRODUCTION_R2_READ_SECRET` | Dedicated private bucket, object and open multipart inventory only |
| `DRIVE_PRODUCTION_R2_APP_ID`, `DRIVE_PRODUCTION_R2_APP_SECRET` | Dedicated private bucket, Drive object operations |
| `DRIVE_PRODUCTION_OWNER_TOKEN` | Fresh 43-character base64url token delivered by the authorized custodian to the owner for this bootstrap |

Plan the owner ceremony before dispatch. The workflow binds the token to the
approved SHA and a five-minute expiry just before the Worker upload. The owner
enrolls over the production origin with a passkey. A successful owner enrollment
closes bootstrap permanently for that D1. Reset acceptance to `UNAPPROVED`
and clear the temporary approval and bootstrap secret after the attempt.
A failed or expired bootstrap requires the switch-off procedure and a reviewed
recovery plan. Never insert or reset the owner directly in D1.

## Dispatch and initial checks

Dispatch `release` from protected `main` with `accepted_sha`,
`staging_run_id` and `staging_run_attempt`. Preflight verifies the current
protected main SHA, exact green push runs, the production branch policy,
and the trusted smoke workflow's current successful attempt. It verifies the
unexpired archive against GitHub's digest and requires the exact SHA, build
digest, cap and complete passing case set. A separate job outside the
production environment rebuilds the Worker and assets and compares their
digest. On a fresh runner, the deploy job installs the pinned deployment
CLI with lifecycle scripts disabled, rechecks the receipt, and restores the
bounded current-attempt build artifact. It verifies the restored Worker
and asset digest before receiving production credentials.

The workflow verifies the approved target, custody fingerprints and release
window, checks emptiness with read-only credentials, and reads back the approved
D1 snapshot. Only then can Wrangler apply the exact source's migrations. The
post-apply D1 ledger must exactly match the checked-in migration order. The
checked Worker is deployed with the route and previews off, and its version
and bindings are read back before the route can be enabled. After enablement,
the workflow checks the serving version, `HEAD /sign-in` and anonymous denial
on `GET /api/owner/invitations`. A serving probe failure triggers switch-off.

A failed or interrupted migration or deploy may leave provider writes in flight
or committed. Stop, keep admission off, and reconcile the exact Worker,
D1 ledger, bookmark and R2 state in the release task. A rerun cannot assume the
targets are pristine. Any recovery write needs its own reviewed plan.

## Bounded production smoke and watch

Start the watch when the production route is enabled. Restrict invites during
the watch to the planned owner and two controlled synthetic member identities.
Finish the authenticated smoke in the first ten minutes. Use one run-tagged
synthetic object at or below the cap, one read grant and one revoke. Record
statuses, counts and checksums. Keep passkeys, tokens, session cookies, signed
URLs, member identifiers and response bodies out of evidence.

- Verify the Workflow's source SHA and Worker version against the currently
  serving production deployment. Check sign-in and anonymous direct API denial.
  Complete the owner's passkey enrollment promptly and verify its one-time
  behavior.
- Accept the two controlled invitations. Confirm an uninvited principal is
  denied. Upload and list the tagged object and compare the downloaded bytes
  against the known checksum. Verify the second principal cannot read the
  object before a grant, can read it after the grant and is denied immediately
  after revocation. Verify permanent deletion is denied.
- Revoke the temporary invitations, grant and synthetic members' access,
  verifying denial with their existing sessions. Record the isolated fixture
  as retained pending authorized exact-object erasure. Its data must be
  synthetic and within this run's cap and count.
- Observe the Worker version, request 5xx/errors and D1/R2 errors at activation
  and at least every five minutes for at least 30 minutes. Use the dedicated
  provider metrics and bounded no-credential sign-in and anonymous-denial
  requests, with a five-second maximum per request. Stop on version drift,
  unexpected 5xx, credential or data exposure, failed auth/denial or smoke,
  or loss of observability. Keep other invitations closed until the smoke and
  watch pass. Record the timestamps, checks, errors and outcome in the release
  task and product log.

## Switch off the first release

On regression, stop inviting users and immediately dispatch `switch-off` from
protected `main`. A queued switch-off remains valid if main advances and the
dispatch SHA is still on main. The two production jobs share a durable Actions
queue. This operation requires the dedicated Worker credentials and namespace
and works after the release receipt or approval expires. It disables the
workers.dev route and preview URLs, verifies the
provider flags and probes the production origin for denial without following
redirects. Alert the release reviewer and incident owner immediately if either
verification is unavailable or fails.

The initial release has no earlier serving Worker. Route disablement stops
serving and leaves D1 and R2 intact. Review any accepted writes and current
data before reopening or considering a restore. A D1 snapshot never rolls
back R2. Reopening requires a separately reviewed recovery plan and observed
private admission, binding and data checks.
