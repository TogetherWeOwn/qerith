# Drive first private production release

[Deploy Drive production](../.github/workflows/deploy-drive-production.yml)
is a protected manual workflow for the first private release. Run it only from
`main` in a dedicated release task after [staging verification](drive-staging.md),
exact-candidate review and independent release approval. The initial deployment
serves owner bootstrap, sign-in and settings with object storage unconfigured.
The owner verifies and saves external S3-compatible storage in the Drive web
UI. Keep member invites closed until storage is ready and file smoke passes.
The checked build caps uploads at 16 MiB + 257 bytes (16,777,473 bytes).
Permanent deletion and its scheduled drain are disabled.

## Before approval

1. Confirm required CI, PR standards, secret scanning and tier reviews for the
   candidate. Wait for the successful `ci` and `gitleaks` push runs on the exact
   main SHA. Run the protected `drive-first-release-smoke.yml` workflow at that
   SHA with `staging_venue=github-hosted-local`. Record its run ID, attempt,
   build digest and all passing outcomes. The
   single success-only artifact
   `drive-first-release-smoke-<full-sha>-attempt-<run-attempt>` contains
   `receipt.json` with the venue, source SHA, immutable build digest, staged
   Worker version, tested cap, case outcomes and cleanup result. An expired artifact,
   new attempt, changed build or changed main tip requires fresh evidence and
   approval.
2. Verify the GitHub `production` environment already exists, its custom branch
   policy allows only the `main` branch, and the production credentials and
   variables resolve from that environment. Check scope and custody through the
   established provider and GitHub authorities. Use dedicated production
   identities throughout. Verify the production-only D1 database named
   `qerith-drive-production` in the selected Cloudflare account. For the
   dedicated boundary, verify the account differs from the shared staging
   account. For the explicit shared-account boundary, follow the writer checks
   below. Read back the account's workers.dev namespace and the production
   boundary in GitHub. Record the actual D1 UUID, Worker name and
   `https://qerith-drive-production.<workerSubdomain>.workers.dev` origin. Confirm
   the production Worker is absent and the intended Worker has no custom route,
   preview, trigger or service binding. The workers.dev route is the sole
   intended serving surface and the
   switch-off control.
3. Establish the narrow production release window with the custodian. Confirm
   that the Worker and D1 have no other active consumers, writers or queued
   provider operations. Verify the effective scopes and custody of a Cloudflare
   metadata/D1 reader and the Cloudflare deploy identity. Keep the
   exclusion of other writers in effect through migration and activation.
   The workflow reads the exact targets. The release reviewer must independently
   establish the authority and coverage of those reads and the writer exclusion.
4. Confirm D1 has no app schema or migration ledger. Use a bounded D1 query
   against `main.sqlite_schema` and record the result without row data. Stop
   if any target, emptiness result, scope or writer status is unknown. A
   pre-existing app schema, even with no rows, needs a separate plan.
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
   evidence, production boundary, verified bookmark, writer exclusion, owner
   bootstrap, switch-off procedure and watch. If the evidence changes or any
   recovery condition is unsafe, stop and obtain a new decision.

## Configure the durable production boundary

Store `DRIVE_PRODUCTION_BOUNDARY` as a secret in the main-only GitHub
`production` environment. Encode the UTF-8 JSON as a single line of standard
Base64, with no line wrapping. The release script decodes it in process. Never
place the encoded or raw pin in Actions variables or dispatch inputs. If
either the boundary or target was stored as a `production` environment
variable, remove that variable before setting the corresponding secret.

Use one of these exact JSON shapes.

- **Dedicated account** has two fields. `accountId` is the dedicated
  Cloudflare account ID (32 lowercase hex characters). `workerSubdomain` is
  the account's workers.dev subdomain as a single lowercase DNS label, up to
  63 ASCII letters, digits and hyphens, starting and ending with a letter or
  digit. This shape refuses either shared staging identifier.
- **Shared account** has four fields. `mode` is `shared-account`, `accountId`
  and `workerSubdomain` match the exact existing pair already identified in
  the guard, and `d1Id` is the independently reviewed production D1 UUID.
  The guard refuses the staging D1 UUID and a release target with any other
  D1 UUID. The Worker and database name are fixed to `qerith-drive-production`.

All fields are strings. Both operations use the same pin and derive the
production Worker origin from it. The release sets both
private admission origin bindings to that Worker origin and verifies them on
the closed Worker before enabling its route.

Keep the verified pin and incident pair in protected custody across release
windows. Changes to the pin are protected target changes and require a
separately reviewed production change. Keep it stable while production jobs are
queued or running and while the Worker serves. Keep administration of the
boundary and incident secret names under the same custody at all scopes.
Configure these names only in the `production` environment. Preflight refuses
a boundary or incident secret visible outside that environment before either
operation.

| Durable production environment secrets | Effective scope |
| --- | --- |
| `DRIVE_PRODUCTION_CF_SWITCH_READ_TOKEN` | Workers Scripts Read for the selected account and Worker subdomain readback |
| `DRIVE_PRODUCTION_CF_SWITCH_WRITE_TOKEN` | Workers Scripts Write for route disablement, scoped to the exact production Worker for the shared account |

The custodian issues distinct incident identities without D1, storage or zone
grants and rotates them under incident custody. Workers Scripts Write also
grants script and binding edits. Keep the incident writer in
protected custody and use it only for switch-off.

### Shared-account writer checks

Cloudflare grants the deployment operations for assets and D1 migrations at
account scope. The workflow's fixed addresses constrain this release job.
Other jobs retain the authority granted by their own credentials. The known
remote Drive staging publisher has used a reusable account-wide Worker and
D1 writer. In the dedicated release task, drain its pending work, disable
that publishing path and revoke the exact credential before preparing the
production targets. The deployed staging Worker and its bucket-scoped
runtime signer can keep serving. Check the actual targets of recurring
same-account publishers with Worker or D1 write authority. Resolve any
deployed path or accepted operation that could change this Worker or its
ingress or write or restore this D1. If a recovery-conflicting path cannot be
resolved, keep the shared-account target closed and use the dedicated account
path when available.

## Configure the accepted release

The release operator updates the repository Actions variable
`PRODUCTION_ACCEPTED_SHA` from `UNAPPROVED` only after independent acceptance.
Set the release inputs in the `production` environment.

- The `DRIVE_PRODUCTION_TARGET` secret uses the same single-line Base64 format
  as the boundary. Its JSON contains `accountId`, `worker`, `origin`, `d1Id` and
  `credentials`. The account and origin must match the durable boundary, as
  must the D1 UUID when the shared-account mode is selected. The credential
  keys are `cfRead`, `cfDeploy` and `owner`. Each value is the lowercase SHA-256
  of the matching secret. Compute the digests in credential custody. Keep raw values and
  operator input out of shell history and the release record.
- The `DRIVE_PRODUCTION_APPROVAL` JSON variable contains `sourceSha`, `buildDigest`,
  `stagingRunId` (string), `stagingRunAttempt` (integer), `targetDigest`,
  `bookmarkDigest`, and `expiresAt` (UTC, at most one hour from deployment).
  Use lowercase SHA-256 of the target's sorted-key compact UTF-8 JSON with no
  trailing newline for `targetDigest`. Use the lowercase SHA-256 of the
  approved bookmark bytes with no trailing newline for `bookmarkDigest`.
  Set the expiry within the independently approved custody and write-exclusion
  window. Keep the reviewer decision and private evidence in the release task.

| Production environment secrets | Effective scope |
| --- | --- |
| `DRIVE_PRODUCTION_CF_READ_TOKEN` | Cloudflare read authority for exact Worker, D1 and Time Travel metadata plus read-only D1 SQL |
| `DRIVE_PRODUCTION_CF_DEPLOY_TOKEN` | Cloudflare authority for the dedicated Worker and D1 deployment operations |
| `DRIVE_PRODUCTION_OWNER_TOKEN` | Fresh 43-character base64url token delivered by the authorized custodian to the owner for this bootstrap |

Plan the owner ceremony before dispatch. The workflow binds the token to the
approved SHA and a five-minute expiry just before the Worker upload. The owner
enrolls over the production origin with a passkey. A successful owner enrollment
closes bootstrap permanently for that D1. Reset acceptance to `UNAPPROVED`,
clear the temporary target, approval and bootstrap inputs, and withdraw the
release-only credentials when the release window closes. Retain the durable
boundary and incident pair.
A failed or expired bootstrap requires the switch-off procedure and a reviewed
recovery plan. Never insert or reset the owner directly in D1.

## Dispatch and initial checks

Dispatch `release` from protected `main` with `accepted_sha`,
`staging_run_id` and `staging_run_attempt`. Preflight verifies the current
protected main SHA, exact green push runs, the production branch policy,
and the trusted smoke workflow's current successful attempt. It verifies the
unexpired archive against GitHub's digest and requires the exact SHA, build
digest, cap and complete passing case set from `github-hosted-local`. It
verifies the local MinIO fixture and its cleanup. A separate job outside the
production environment rebuilds the Worker and assets and compares their
digest. On a fresh runner, the deploy job installs the pinned deployment
CLI with lifecycle scripts disabled, rechecks the receipt, and restores the
bounded current-attempt build artifact. It verifies the restored Worker
and asset digest before receiving production credentials.

Before contacting Cloudflare, the workflow matches the durable boundary to
the approved target and verifies the custody fingerprints and release window.
It checks emptiness with read-only credentials and reads back the approved
D1 snapshot. Only then can Wrangler apply the exact source's migrations. The
post-apply D1 ledger must exactly match the checked-in migration order. The
workflow checks again that the production Worker is absent before deploying
the checked Worker with the route and previews off. The deployment
has no object-store endpoint, bucket, credentials or qualification binding.
The workflow reads back its version and bindings before enabling the route.
After enablement,
the workflow checks the serving version, HTTP 200 on `HEAD /sign-in`, and HTTP
401 on anonymous `GET /api/owner/invitations`. Both origin checks use the same
curl transport as switch-off. A serving probe failure triggers switch-off.

A failed or interrupted migration or deploy may leave provider writes in flight
or committed. Stop, keep admission off, and reconcile the exact Worker,
D1 ledger and bookmark in the release task. A rerun cannot assume the targets
are pristine. Any recovery write needs its own reviewed plan.

## Bounded production smoke and watch

Start the watch when the production route is enabled. Finish the authenticated
shell smoke in the first ten minutes. Record statuses, counts and checksums.
Keep passkeys, tokens, session cookies, signed URLs, member identifiers and
response bodies out of evidence.

- Verify the workflow's source SHA and Worker version against the currently
  serving production deployment. Check sign-in and anonymous direct API denial.
  Complete the owner's passkey enrollment promptly and verify its one-time
  behavior. Verify the owner can sign in and reach storage settings and that
  file operations are unavailable while storage is unconfigured.
- Observe the Worker version, request 5xx/errors and D1 errors at activation
  and at least every five minutes for at least 30 minutes. Use the dedicated
  provider metrics and bounded no-credential sign-in and anonymous-denial
  requests, with a five-second maximum per request. Stop on version drift,
  unexpected 5xx, credential or data exposure, failed auth/denial or smoke,
  or loss of observability. Record the timestamps, checks, errors and outcome
  in the release task and product log.

The owner can verify and save an external S3-compatible target from Drive
settings after deployment. Keep member invitations closed until storage is
verified. Before inviting members, smoke the configured file path with two
controlled synthetic identities, one run-tagged object at or below the cap,
one read grant and one revoke. Check uninvited denial, byte-identical
download, immediate denial after revoke and permanent deletion denial.
Revoke the temporary invitations and member access, verify session denial,
and record the isolated object as retained pending authorized exact-object
erasure.

## Switch off the first release

On regression, stop inviting users and immediately dispatch `switch-off` from
protected `main`. A queued switch-off remains valid if main advances and the
dispatch SHA is still on main. The two production jobs share a durable Actions
queue. Freeze new release dispatches and cancel any unstarted release that
could delay switch-off. A running deploy may hold the queue up to its
15-minute job timeout. Switch-off uses the durable boundary and incident pair
after the temporary inputs and release credentials have been withdrawn. It
verifies the account namespace, disables the workers.dev route and preview
URLs, and verifies both provider flags and HTTP 404 on HTTPS `HEAD /sign-in`
using curl with redirects disabled. Each sign-in probe uses a fresh query key.
The invitations probe uses the query-free route required by owner API
admission. The workflow rejects cache hits, stale responses, and unrecognized
`CF-Cache-Status` values. Alert the release reviewer and incident owner
immediately if either verification is unavailable or fails.

The initial release has no earlier serving Worker. Route disablement stops
serving and preserves D1 and any subsequently configured object storage.
After storage setup, reconcile any issued write URLs and accepted object
writes before reopening or restoring D1. A D1 restore affects only the
database. Reopening requires a separately reviewed recovery plan and observed
private admission, binding and data checks.

### Hosted switch-off rehearsal evidence

Before live use, qualify the effective incident permissions and GitHub gates
with synthetic resources in an approved disposable repository and Cloudflare
account. In the disposable copy, substitute only the repository identity in
the workflow's repository guard and the preflight script's `REPO` constant.
Record both substitutions and the exact source SHA used for the rehearsal.

- Confirm protected main and its main-only environment policy, both jobs'
  input visibility, and refusal when the protected pin is absent or available
  only at repository or organization scope. Confirm the pin and incident
  secrets resolve in the protected job and are unavailable outside it. Verify
  that the runner output contains neither the raw pin, its encoded value, its
  account ID or namespace, nor any incident credential values.
- In the disposable repository, set an incident secret name at repository
  scope to a synthetic value with no provider access. Dispatch both operations
  without acceptance or a staging receipt and verify each stops at the
  input-scope preflight step before reaching any protected job. Remove the
  synthetic secret before continuing.
- With only the durable inputs present, record the transition from HTTP 200 to
  404 on `HEAD /sign-in`, the refusal's `CF-Cache-Status` or its absence, and
  both provider flags reading false. Verify the incident pair's effective
  permissions and denial outside the scoped synthetic account using
  disposable targets.
- Occupy the shared queue, advance main, and confirm an ancestor switch-off
  dispatch still works without release acceptance, receipt or credentials.
  Record queue and disablement timing, cancellation of an unstarted release
  and the running deploy timeout bound.
- Exercise provider denial or an unconfirmed origin probe and verify
  escalation. Record the responsible incident operator and verify cleanup of
  all rehearsal resources and credentials.
