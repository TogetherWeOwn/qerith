# Drive staging

## First private release smoke

Rank 10 runs [the staging smoke workflow](../.github/workflows/drive-first-release-smoke.yml)
from protected `main` with `expected_main_sha` set to the reviewed full commit
SHA. The workflow validates the dispatch before entering its venue's queue.
Cloudflare runs join the shared staging queue. Confirm required checks and both reviews for the release candidate before
dispatch. The `staging` GitHub environment must allow the `main` branch only.

### GitHub-hosted staging

Select `github-hosted-local` to run the packaged Worker under local workerd
with a fresh D1 database and the committed migrations on a GitHub-hosted runner.
The same runner starts the SHA-256-pinned MinIO release over loopback TLS,
creates a private bucket with synthetic credentials, and restricts Worker S3
requests to the run's prefix. The Worker version in this venue is synthetic.

Repeat the dispatch for each exact candidate on protected `main`.

```sh
gh workflow run drive-first-release-smoke.yml --repo TogetherWeOwn/qerith --ref main \
  -f expected_main_sha="$reviewed_sha" -f staging_venue=github-hosted-local
```

The local venue reads back a three-day object expiry rule and a real part in an
incomplete multipart upload. After the Worker stops, cleanup uses bounded,
unfiltered bucket listings, requires the server to acknowledge the explicit abort,
and verifies that the entire bucket has zero objects and open uploads. The run
then removes its local Worker, D1, MinIO data, and key material. This venue
proves local S3 interoperability, object expiry configuration, and explicit
abort. Actual deployment bindings require their own provider readbacks.

### Cloudflare staging target and access

Select `cloudflare` for the Cloudflare staging venue. Use a new disposable D1
database for each attempt. Cleanup removes the published Worker and database.

Before dispatch, record dated provider custody evidence for the exact
Cloudflare account, workers.dev subdomain, disposable database UUID and name,
private bucket, and credentials. Confirm exclusive use of the database and the
reserved Worker and object namespaces for the attempt. Confirm the Cloudflare
credential can manage the disposable Worker and D1, and read the named bucket
metadata, domain settings and lifecycle. Confirm the S3 signer is scoped to the
dedicated bucket for object and multipart reads, writes and cleanup. Scope the
provider policy as narrowly as the service supports. Record the effective
policy and any limits in the custody evidence. The workflow checks the protected
target declaration and credential fingerprints, then verifies the named
resources through the provider.

- Use a fresh D1 database named `qerith-drive-first-release-smoke-<fixture>`.
  Its custody record must authorize deleting that exact UUID after the attempt.
  The preflight checks for an empty schema before it applies committed migrations.
- Use the default-jurisdiction private bucket `qerith-drive-first-release-smoke`
  or a bucket with that name as a hyphen-delimited prefix. Disable public
  r2.dev access and remove custom domain registrations. Preconfigure native
  expiry scoped to `drive-first-release-smoke/` for objects within three days
  and multipart attempts within seven days.
- Reserve the Worker name `qerith-drive-first-release-smoke-<run-id>-<attempt>`
  and the R2 prefix `drive-first-release-smoke/<run-id>/<attempt>/` for the
  workflow. It verifies both are unused before mutation. The Worker requires
  an attempt-only request secret and stops admitting requests after 12 minutes.

Set these environment secrets under `staging` after verifying the provider
evidence.

| Name | Value |
| --- | --- |
| `QERITH_FIRST_RELEASE_SMOKE_TARGET` | JSON with `accountId`, `databaseId`, `databaseName`, `bucket`, the single-label `workerSubdomain`, SHA-256 `scopeEvidenceDigest` of the custody record, Unix milliseconds `expiresAt`, and lowercase SHA-256 `deployTokenHash` and `accessKeyIdHash` of the exact credential strings |
| `QERITH_FIRST_RELEASE_SMOKE_CLOUDFLARE_TOKEN` | Authorized smoke Cloudflare API token |
| `QERITH_FIRST_RELEASE_SMOKE_R2_ACCESS_KEY_ID` | Smoke bucket S3 access key ID |
| `QERITH_FIRST_RELEASE_SMOKE_R2_SECRET_ACCESS_KEY` | Smoke bucket S3 secret access key |

Target authorization must cover at least 15 minutes when the exercise starts.
Record the claim and live run in the release task. A missing or unverified
binding stops the workflow before staging writes. The existing shared staging
credentials and full-qualification evidence apply to their own target.

### Cases and receipt

The workflow builds with the full source SHA as the asset version and packages
with locked Wrangler. From `apps/drive` use the same Node and npm versions as
the workflow and run these commands.

```sh
DRIVE_BUILD_SHA="$GITHUB_SHA" npm run build
node_modules/.bin/wrangler deploy .svelte-kit/cloudflare/_worker.js \
  --config wrangler.build.jsonc --dry-run --outdir .svelte-kit/first-release-package
node scripts/first-release-build-digest.mjs
```

The build digest hashes the prebundled Worker and path-sorted asset hashes.
The local runtime loads that Worker directly. Cloudflare uploads it with
`--no-bundle`. The smoke checks the serving SHA and venue's Worker version
using a fresh nonce before and after the cases.
It enrolls a synthetic owner using a short-lived, release-bound one-shot
bootstrap and enrolls two invited members. It checks that uninvited access is
denied. It stops after the first acknowledged 16 MiB part, signs in again,
checks the saved prefix, and uploads only the remaining 257 bytes. The
uploader and grantee downloads must match the source byte count and SHA-256.
The run proves grant revocation and membership revocation, refuses cap plus one
and an oversized final part, and verifies permanent deletion is unavailable.
The first-release picker checks the same limit before hashing. The owner upload
preview has a one-part limit. Shared staging keeps its existing upload policy.

Cloudflare cleanup first removes and verifies absence of the attempt Worker. It then
removes and verifies the exact R2 attempt prefix and the named disposable D1
UUID. This includes aborting any remaining multipart upload in that prefix. An incomplete run or
cleanup leaves the release without a receipt. If a runner is lost, wait for the
Worker deadline, verify and remove the exact attempt Worker using its source,
run, attempt, build digest and D1 bindings, then reconcile the known fixture
prefix and database under the same custody authorization. Record the readbacks
before retrying with a fresh database. Provider expiry bounds orphaned R2
fixtures while reconciliation is pending.

A successful run publishes exactly one artifact
`drive-first-release-smoke-<full-sha>-attempt-<run-attempt>` containing
`receipt.json` for seven days. The version 2 receipt records the staging venue,
source SHA, run ID and attempt, build digest, Worker version, tested cap in bytes
(16,777,473), and the passed cases including cleanup. The local venue also
records the MinIO release, read-back object expiry rule, explicit abort, and
empty bucket results. Record the exact successful run and artifact for the
production release preflight.

## Shared staging preparation metadata

The credential-free Drive CI job tests a closed-admission metadata contract. It
validates an immutable source SHA, GitHub run ID and attempt, the corresponding
run-scoped prefix, and `admission: closed`. Mismatched fields, missing fields and
fields outside the v1 contract are rejected. These tests use synthetic values and
do not access staging secrets.

The manually dispatched preparation job checks the GitHub repository, event,
main ref, source SHA and checked-out commit before recording metadata. It does
not access the staging environment or credentials. The dependent publish job
requires a trusted `main` dispatch and the protected GitHub `staging` environment.
Supply `expected_main_sha` as the reviewed 40-character lowercase SHA. It must
match both the immutable dispatch SHA and the checkout; if `main` moved before
dispatch, stop rather than substituting another commit. This pin is not approval.

The metadata contract does not deploy a Worker, apply migrations, create fixtures, prove
cleanup or retention, or authorize live qualification. No metadata generated by
this code grants admission to staging. Live deployment and qualification require
separately reviewed controls and evidence, including trusted main-only staging
access, verified bindings, bounded cleanup and real integrated interfaces.

## Zero-idle staging requirement

Staging and preview runtimes must not incur recurring always-on runtime charges
when idle. Before admitting live use, inventory the actual Worker, D1 compute,
Containers, Durable Objects and their alarms, scheduled Workers, Stream inputs,
and any other database compute. A sleeping container alone is not evidence that
the rest of the estate is idle or unbilled. Do not add keep-alives, probes,
alarms or schedules that resurrect or sustain resources outside an authorized
use window. Preserve required health and security checks during active use.

A trusted pipeline must start the required resources and verify readiness for
the tested SHA and environment before qualification. It must bound the use
window and retain evidence of startup, readiness and native stop, scale-to-zero,
cleanup or expiry, including after failures and cancellation. Use existing
platform or pipeline controls, not host timers or a new scheduler. An
unsupported control is a prerequisite, not a successful cleanup result.

A recurring always-on exception requires explicit dated owner authorization
recording the resource and environment, recurring cost and expiry or review
date. This requirement authorizes neither new spend nor weaker security, and it
does not replace exact-SHA qualification.

## Staging fixtures and migration admission

Use only synthetic fixtures tagged with the originating run ID in D1 and R2.
Enforce the staging-only absolute deadline, clean up on success and failure and
via a trusted main-only completion workflow, and sweep older tags before new
writes. Record leftover rows as cleanup defects, not app-admission gates. The
full-v0 inventory below still requires its reserved migration keys to be absent;
reconcile older residue separately before retrying, since exact-attempt cleanup
will not remove it. Reported R2 expiry covers only `drive-qualification/` (three
days); the seven-day multipart-abort rule remains. Neither proves that
qualification cleanup ran.

The manual staging storage proof does not deploy a Worker. Before dispatch,
review provider evidence that the staging signer is scoped to the Drive
namespace, no other writer can overwrite acknowledged parts or generations,
and native lifecycle rules cover `drive-qualification/storage-proof/` if the
runner is lost. Supply only the two SHA-256 digests from that review at
manual dispatch: the reviewed scope evidence digest and the identity digest
of `JSON.stringify([storageConfigId, region, accessKeyId])`, computed within
trusted custody. `storageConfigId` is the JSON array string of normalized
endpoint origin, bucket and storage epoch. Never pass the raw identity inputs
as dispatch inputs. Missing digests or an identity mismatch stop the probe
before any S3 request. The receipt correlates the run to the independent
review; the probe cannot itself establish exclusive writer scope. Only a
passing exact-run artifact with verified cleanup can qualify storage.

The publisher uses the reviewed copy of [the passing protected proof][proof]
(artifact [14601057765][artifact]). It recomputes the storage identity from
protected settings before migrations and again at publish. The recorded 932 ms
completion uses a 3,000 ms budget. A signer namespace or writer-scope change
requires a fresh epoch and a newly reviewed passing receipt, even if the bucket
and endpoint are unchanged; the local digest check is not a policy readback.
The signer credentials are passed only as Worker secrets.

[proof]: https://github.com/TogetherWeOwn/qerith/actions/runs/44674630242/attempts/1
[artifact]: https://github.com/TogetherWeOwn/qerith/actions/runs/44674630242/artifacts/14601057765

The dry run and fake tests do not prove live readiness. Before the first
main dispatch, require exact-head Actions, independent Security then QA review,
and verify that `staging` is restricted to `main`. Place only the authorized
`QERITH_STAGING_CLOUDFLARE_ACCOUNT_ID` and `QERITH_STAGING_CLOUDFLARE_API_TOKEN`
secrets for the deploy step in that environment. The token needs Workers Scripts
edit and D1 edit on the staging account; the workflow validates the fixed Worker
and D1 config before remote migrations or publication. Step-scoped secrets are not build isolation:
this job trusts the reviewed source and locked build tools in its workspace.
Timeouts and output limits bound local commands, not hard cancellation, runner
loss or an accepted provider request. The shared concurrency group does not
fence external writers or stale dispatches.

The parent qualification task owns all dispatches. Leave `activate_preview`
false (the default) to publish closed, including to disable an active preview.
Closed publish still checks storage identity and records the D1 bookmark and
empty pending list. Keep edge access restrictions in place. Set
`activate_preview: true` only after Security then QA qualify the exact SHA. This
sets the fixed HTTPS `DRIVE_ORIGIN` from the checked-in staging config. Neither
mode enables fixture sign-in, invite acceptance or owner enrollment, even if a
prior enrollment secret is retained. Verify the deployed SHA and readiness;
a dashboard variable is not readiness evidence. Staging data is not durable
or backed up.

Use Wrangler's native `d1_migrations` ledger. Log the exact SHA, pre-apply Time
Travel bookmark and before/after pending lists; the final list must be empty.
The first list can initialize `d1_migrations` before the bookmark is captured.
Neither the lists nor the source manifest attest applied bytes or schema. Before
retrying an uncertain apply, restore the bookmark or rebuild from committed
migrations.
Recreation requires reviewed updates to the Wrangler binding and publisher UUID
pin before dispatching the new SHA; do not relax validation. Record the previous
Worker version or its absence; Worker rollback is separate from D1 recovery.

## Exact-SHA qualification (disabled)

`drive-staging-qualification.yml` verifies that `tested_sha` is one lowercase
40-hex SHA, equal to the manual dispatch head and checked-out commit, and an
ancestor of fetched `origin/main`. A dispatch of today's head with yesterday's
SHA as input cannot qualify yesterday's head. Only after source validation does
the protected `staging` job enter the shared `drive-staging-lifecycle` queue.
The protected job independently checks out the dispatch commit, requires the
workflow definition's own SHA to match, and compares its existing staging
settings with the target config and reviewed native R2 binding in that commit.
This check is local: it neither authenticates to a provider nor establishes app
admission, writer scope, or native expiry. The job still intentionally fails
and has no receipt step. Do not dispatch this increment. Required `ci-ok` now
includes all qualification adapter and policy tests through `drive-bootstrap`;
fixture transports, local Git history, and Wrangler local mode are not live proof.

The qualification-only D1 adapter is not called by either staging workflow.
It snapshots verified SQL and D1 config from the tested commit outside the checkout.
It awaits the recovery writer for the Time Travel bookmark before any ledger
initialization or apply, then reads the native
`d1_migrations` rows before and after apply. It requires the full committed set
without changes to existing ledger entries. The native ledger records names,
not the historical applied bytes. A failed or cancelled apply does not prove
remote rollback; use the recorded bookmark to recover before retrying an
uncertain apply. The future caller must validate storage and recovery
preconditions before invoking the adapter and route runner termination into
its abort signal.

The unwired Worker adapter requires a known, single-version staging baseline
with the reviewed storage configuration, the staging D1 binding, and assets.
It uses pinned Wrangler `versions upload`, with version previews disabled on the
existing target. Wrangler inherits secrets from the latest upload, which may
not be serving traffic. The adapter requires the baseline to be the newest
upload before it runs Wrangler, then requires the candidate and baseline to
be the two newest versions in order. It does not write or rotate secrets. It
reads back the candidate's tag and bindings and requires unchanged deployment
identity before activation. This check does not attest secret values; live
storage checks must use the qualified signer. An older baseline restored after
a prior attempt is not eligible for another upload while a newer version
remains. The lifecycle stops before D1 changes on this retry path. Reconcile
staging through the reviewed recovery path before retrying: a non-candidate
baseline with the reviewed bindings must both serve traffic and be the newest
upload. Qualification does not automatically republish the baseline or change
secrets to make it eligible. The caller must build from the tested SHA under
the shared lock.
The adapter records the prior deployment before changing traffic and never
forces a restore. The readiness helper uses a fresh, credential-free
HEAD challenge on the fixed staging origin. The responding Worker proves its
version-scoped `DRIVE_QUALIFICATION_SHA` and native `DRIVE_QUALIFICATION_VERSION`
metadata ID when its D1, assets and reviewed storage bindings are ready. It
reads no app data, and does not infer identity from the request or upload tag.
Neither readiness binding is configured in the existing publisher or workflow.
The adapter restores the previous version after the checks, including on
cooperative cancellation, and confirms the restored deployment by readback.
The probe and cases have separate deadlines; the callbacks must stop and settle
all work before rollback. A hard stop is not verified cleanup. It
refuses to replace a deployment it does not own. Readback is not atomic fencing;
the shared lock must cover all active writers. An ambiguous write without proof
of rollback, hard cancellation, or runner loss still requires reconciliation.
Worker rollback does not restore D1 or establish idle state.

Under the shared staging lifecycle lock, the protected job verifies the dispatch
SHA and reviewed storage settings, then builds that checkout from the reviewed
npm lock with dependency lifecycle scripts disabled. The build step has no
staging credentials. It checks that the generated Worker entry
and at least one JavaScript client asset are nonempty in the job workspace. The job still ends at the
explicit hard stop.

The offline lifecycle coordinator now sequences full-v0 preflight and initial
inventory, immutable upload, D1 migration, Worker activation and readiness,
then cases. It requires the recovery writer to acknowledge the D1 bookmark and
previous Worker deployment before their respective changes. Any case that starts
must settle before cleanup, which uses its own bounded signal and the exact
run/attempt prefix while the candidate is still active. Final inventory is
checked after Worker recovery, even after an error or cooperative cancellation.
The offline entry point rechecks the committed staging target and reviewed R2
binding, then binds the case runner, estate checks, and signed recovery writer
to a single SHA/run/attempt. It verifies recovery record retention before the
candidate upload and again before each record write. It requires explicit
admission evidence, app case, estate, writer-fence, and transport adapters. The
case runner requires every case to pass and binds the results to the exact
invocation.

Before the first inventory read, app admission requires two independent
approvals for the exact main commit, browser workflow and candidate settings.
It checks the same commit's successful main-push CI run, exact-head browser
policy and checkout, generated fixture step, verified artifact identity and
digest, and selected passkey, invite, grant and shared-listing observations.
The latest CI attempt must contain the capture, verification, registry
coverage, and `ci-ok` successes. A failed-jobs-only rerun can leave some
successes in an earlier attempt. A full rerun can also fail if an earlier
artifact already uses a required upload name. A candidate without a complete
record remains ineligible. If CI cannot produce that record for the commit, a
new candidate needs its own review and successful main-push evidence.

The future protected evidence reader must authenticate the approvals and CI
metadata independently and extract the claims from the same digest-verified
archive. The offline tests inject synthetic records for that interface.

The resulting attempt-bound admission pins invite acceptance, read grants
and shared listing to `1`, fixture sign-in to `0`, and owner enrollment to
`disabled`. The Worker lifecycle verifies the settings on the immutable
version before activation. Full-v0 composition requires an explicit candidate
uploader. A protected implementation must build the admitted commit in an
exclusive checkout and keep the Worker entry, its transitive sources, assets,
migrations, and pinned build tools isolated through Wrangler upload. Before
Wrangler inherits bindings, require the version serving all staging traffic
to be the latest upload. After upload, require the candidate to immediately
follow that version in upload history and require the serving deployment to
stay the same. Verify the candidate's complete binding set, including the
exact admitted settings and inherited secret names, on version readback.
These checks must finish before the adapter returns a version for migration
or activation. The stock uploader continues to use closed opt-ins.
Synthetic owner provisioning requires its own reviewed path under the writer
fence after the initial clean census.

The estate composer runs the bounded inventory before mutation and after Worker
restore. R2 prefix and D1 migration-fixture cleanup require a quiescence
snapshot for the exact attempt and a fence-loss signal. The composer waits for
both adapters to settle before Worker restore. Both inventory passes run the
native, read-only app census for the exact SHA, run, attempt, staging account,
and pinned database.
The census requires the reviewed committed migration tree, a complete ledger,
the exact schema catalog, and zero rows across all app tables. The narrower
migration-fixture check still covers both fixture keys across every full-v0
attempt. Missing tables, unknown schema, any app rows, denied reads, and
incomplete responses make inventory unverified. The tests execute this
point-in-time census against SQLite through a synthetic transport. The
protected job still stops before inventory.

The first inventory runs before upload and migration, so the pinned database
must already be fully migrated and empty. An uninitialized or partly migrated
database needs separate, reviewed preparation before it can enter this
lifecycle. The qualification migration adapter records its pre-apply
bookmark before ledger initialization. A reset to that bookmark can satisfy
the final census only if independent evidence ties it to the same verified,
fully migrated baseline. A bookmark from before the required schema was
applied would restore an incompatible catalog. The final inventory runs after
Worker recovery. The current D1 cleanup removes only migration fixtures.
App fixtures can leave permanent upload key reservations, so clearing them
requires a verified D1 reset before the final census.

The unwired R2 cleanup callback uses the reviewed binding from the tested SHA
and the exact `drive-qualification/full-v0/<run>/<attempt>/` prefix. It rejects
other providers, incomplete listings and more than 100 objects plus uploads;
it validates both listings before any deletion and rereads both after cleanup.
The cases must stop all writes before cleanup and keep all fixture keys in that
prefix. This is not evidence of D1 cleanup.

The qualification version uploader binds the dispatch run and attempt to the
immutable candidate and verifies both at upload and before activation. An
admitted candidate allocates a random key under that prefix in the same D1
claim that reserves the key, before multipart initiation. A lost initiation
response leaves a key that the attempt inventory can enumerate. Ordinary app
deployments allocate bare UUIDs, and existing intents keep their stored keys.

A separate, unwired [native R2 lifecycle readback](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/lifecycle/methods/get/)
uses the same reviewed bucket and requires a scoped object deletion rule within
three days and a multipart abort rule within seven days. Both must cover the
entire attempt prefix; conflicting slower or date-based rules fail closed. The
readback requires existing R2 lifecycle read access. It checks configured age
thresholds, not actual deletion timing or rollback after runner loss. It never
changes bucket policy and does not replace direct attempt cleanup.

The unwired Worker inventory uses Cloudflare's unfiltered account script list
and requires a complete response containing only the Worker named in the tested
configuration. It also requires no schedules, one unchanged non-candidate
deployment, and no resource bindings beyond the pinned D1 database and assets.
The script list does not cover other compute surfaces, external invokers, D1
fixture rows or billing. It cannot satisfy whole-estate zero-idle inventory or
establish that a lost runner's deployment was restored.

Both offline inventory passes also require the unfiltered Cloudflare D1 account
list to contain only the database UUID and name pinned in the tested commit.
The check uses a bounded first page and rejects conflicting pagination or partial
responses. This checks the roster visible to the existing credential. The
estate reader must independently cover every required surface and verify D1
on-demand compute. Writer exclusion and restore attribution require separate
evidence.

Both passes also check the native R2 bucket roster in the account from the
reviewed storage binding. The headerless list and the explicit `default` list
must each contain only the bound bucket; the `eu`, `us`, `fedramp`, and
`fedramp-high` lists must be empty. The six sequential reads are unfiltered by
name and share a 15-second deadline. Each must return one page of at most 64 KiB
with an exact total count and no continuation. Denied reads, including on
restricted jurisdictions, make inventory unverified; they do not count as empty.
This checks what the existing credential can list in the documented R2
jurisdictions. It does not replace the estate reader, lifecycle policy readback,
or direct object and multipart listings.

Both inventory passes read the [native R2 bucket job roster][r2-bucket-jobs]
for the reviewed default-jurisdiction bucket before the signed object and multipart
listings. They require a complete first page within five seconds, 100 job
descriptors, and 64 KiB. The read includes all statuses and job types.
Queued or running prefix deletion, bucket emptying, and storage-class migration
jobs make inventory unverified. Unknown statuses and types, denied reads,
and continuation also fail. Terminal job status describes that job at the time
of the read. Writer exclusion still requires a held fence covering other writes,
other provider operations, and new jobs.

[r2-bucket-jobs]: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/jobs/methods/list/

Both passes require an empty, unfiltered native Durable Objects namespace list
in the pinned Worker account. The first page must explicitly report zero total
namespaces, with no conflicting pagination, within five seconds and 64 KiB.
Denied or partial reads make the namespace roster unverified. The check covers
namespaces visible to the existing credential in that account. The estate reader
must separately establish alarm absence.

Both passes also read the unfiltered native Containers application list in the
pinned Worker account. The result must be an explicit empty array with no
continuation within five seconds and 64 KiB. An existing application fails even
if it has zero instances. Denied, partial, and nonterminal responses fail.
This covers only applications visible to the existing credential in that
account.

Both passes also read the native Stream live-input roster in the pinned Worker
account. The unfiltered list requests counts and must return an explicitly empty
`liveInputs` array with `total` and `range` both zero, within five seconds and
64 KiB. Disabled inputs, missing counts, denied reads, and continuation evidence
all fail. Offline fixtures cover the empty-response shape. The read is scoped
to live inputs visible to the existing credential in the pinned account.
Stored recordings, billing, and other accounts require separate evidence.

Both passes also read the unfiltered native Workflows definition roster in the
pinned Worker account. The first page must explicitly contain no definitions,
report `total_count: 0`, and give no evidence of continuation, within five
seconds and 64 KiB. Workflows and Durable Object page counts must be written
as canonical JSON integers. Any Workflows definition fails, even with no active
instances. Offline fixtures cover the definition response shape. Instance
absence and other accounts require separate evidence.

Both passes also require an explicitly empty native Queues roster in the pinned
Worker account. The unfiltered first page uses the provider's default page size
and must report `total_count: 0` with no continuation, within five seconds and
64 KiB. Even a queue without consumers fails. Offline fixtures cover the roster
response shape for the pinned account.

The native R2 bucket, lifecycle and job roster, Durable Objects, Containers, Stream,
Workflows, and Queues inventory reads reject duplicate JSON fields, even when
the last value would otherwise satisfy the check.

A qualification candidate carries an immutable 25-minute request window starting
at version upload. Upload and activation read back the exact deadline; activation
requires more than 20 minutes left for deployment, readiness, cases and cleanup.
The generated Worker rejects new requests at or after the deadline before app,
asset or readiness routing. This bounds candidate request admission without a
runner, but does not stop in-flight work, revoke issued storage URLs, restore the
previous deployment, or clean up D1. Neither existing staging workflow uses it.
The offline lifecycle gives D1 only the time left after upload and after
reserving 21 minutes for Worker checks, recovery recording, activation and
cases. D1 apply starts only if its full two-minute command budget and a
45-second post-apply ledger read fit. The lifecycle rechecks the wall-clock
budget while D1 work is pending and stops apply if a clock step consumes the
ledger reserve. A timeout stops activation and drains the local subprocess;
it does not prove that D1 rolled back. Reconcile any uncertain D1 mutation
before retrying.

The unwired Worker recovery adapter reads the pinned staging config from the
lost attempt's main-ancestor SHA. It verifies the recorded candidate against
both the current deployment and the immutable uploaded version, and reads back
one tagged baseline restore. It does not retry ambiguous writes or overwrite a
superseding deployment. Observing the original baseline is not proof that a late
activation cannot arrive. A protected completion caller must authenticate the
completed source attempt and its durable pre-activation record, hold the shared
lifecycle lock and exclude pending writes. This is Worker recovery only, not D1
or R2 cleanup or authorization to issue a receipt.

The offline recovery coordinator can authenticate a historical source through
bounded GitHub Actions reads: the exact attempt, its successful source job and
exact-dispatch check, and the latest run metadata. It rejects superseded or
ambiguous sources before making signed reads of the two records at the source
SHA's reviewed binding. A later rerun is excluded by the authoritative writer
fence, not by the GitHub read. The coordinator verifies that fence against the
recorded candidate and enforces its loss signal and the earlier of wall-clock
expiry and the original monotonic deadline through the final readback. It checks
the deadline at I/O boundaries, samples wall time every second during pending
I/O, and waits for the adapter to drain after abort. The v1 bookmark and a
post-list ledger are not independent D1 restore attribution.
The offline factory binds the native Worker restore, D1 Time Travel and
exact-prefix R2 cleanup adapters to the historical source SHA. These adapters
issue requests only under the held fence; source and record reads precede it.
The factory requires a separate D1 proof provider: unverified attribution stops
before D1 restoration or R2 cleanup, even if Worker rollback has already
completed. An interruption after D1 restore requires reconciliation; rerunning
is not an R2-only resume. The protected workflow supplies neither proof provider
and does not invoke recovery.

The offline lifecycle and recovery entry points use the recovery store at the
source SHA's reviewed staging R2 binding.
It stores separate, versioned D1 and Worker records per exact SHA, run and
attempt under `drive-qualification/recovery/`, outside attempt fixture cleanup.
A signed `If-None-Match: *` PUT must be acknowledged before a fresh signed GET.
The transport caps readback at 2 KiB before buffering excess bytes and returns
raw bytes unchanged for comparison against the canonical UTF-8 record. Each S3
operation has a five-second budget. A collision, missing or ambiguous write,
byte mismatch or cancellation fails closed without retry or overwrite.

Before PUT, the store requires a complete, unpaginated lifecycle policy with a
three-day native expiry rule covering the recovery prefix and no conflicting
overlaps. GET requires a provider `Date` within 30 seconds of the runner clock
and rejects records at or beyond three days on either clock, even if physical
deletion is delayed. This is not deletion proof, and the store cannot list or
delete. Live use still requires
a private binding, a signer allowed on this prefix, provider-enforced conditional
writes, and a protected caller that authenticates the exact source attempt before
any read and holds the staging lifecycle lock. Offline fixtures prove none of
those live prerequisites. Recovery records are neither success receipts nor
runner-local files.

The unwired large-transfer verifier reads an unencoded, full `200` app download
as a stream. It requires the five GiB boundary (also the current app maximum),
checks the actual byte count through EOF, and compares SHA-256 with the digest
of the independently hashed upload fixture. Offline CI feeds a synthetic body
without a five GiB allocation. The verifier does not upload a file, establish
app authentication, or exercise interrupted resume. The protected caller must
obtain the authenticated response under its bounded case signal.

Remaining source slices, in dependency order:

1. Establish complete estate enumeration, native D1 on-demand compute
   evidence, and verified stop or expiry for resources outside R2. Establish
   an authoritative abortable writer fence covering the runner, candidate,
   external writers, issued storage URLs, and pending provider operations.
   Prove native census response compatibility on the pinned synthetic estate.
2. Verify a reset to an independently attributed, fully migrated empty D1
   checkpoint for app cases that leave permanent rows. Bind recovery to the
   exact attempt, account and database, independently prove the before state
   and all intervening writes, and hold the fence through reset and readback.
   Stop on an unknown checkpoint or ambiguous restore. Wire the protected
   caller only once these checks, durable recovery recording, and reviewed
   full-v0 prerequisites are available. Keep artifact publication disabled.
3. Wire the real app and storage checks: live virtual-authenticator pass/fail,
   invite acceptance and revocation, cross-user and signed-out denial,
   authenticated reads, multipart/range/retry/persistence, a ≥5 GiB upload and
   download with matching digests, a ≥1 GiB interrupted/resumed transfer,
   folders, sharing and revocation, and qualified deletion (combined envelope,
   boundary and safe fallback, rollback/retry, and exact-provider cleanup).
   Keep the receipt disabled until all these cases and lifecycle checks are
   wired and covered offline.
4. Wire the sole upload, last and success-only after verified cleanup, named
   `drive-staging-qualification-<tested-sha>-attempt-<GITHUB_RUN_ATTEMPT>`.
   The consumer also requires the matching successful workflow attempt on
   `main`. Preview, fixture, skipped, failed and cancelled runs do not qualify.

Before a live dispatch, verify that its exact SHA includes reviewed full-v0
app admission and the reviewed S3 binding, and that the protected staging
prerequisites above are satisfied. This does not change preview or production.
