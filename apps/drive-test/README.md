# Workers D1 test fixture

This fixture exercises the Workers Vitest integration and local D1 migration
helper with a test-only migration. It uses an ephemeral local binding and no
Cloudflare credentials; it does not establish remote D1 deployment parity or
by itself cover the Drive metadata contract.

The folder-count migration backfills existing entries and installs its triggers
in the same D1 migration transaction. Deploy the migration successfully before
using code that lists `item_count`; the previous application can run with the
new schema, but the new listing query cannot run against the old schema. On
failure, retain the previous application and repair forward; removing the count
schema while new code is running is not supported. The owner-usage migration
likewise backfills and installs its triggers in one transaction; apply it before
serving the usage query. Keep the previous application on migration failure and
repair forward. Do not delete entries to roll back a migration. Local D1 results
are not deployed-binding evidence. Apply the folder-listing index migration
before deploying code that uses the new ordered listing query: that query names
its indexes explicitly and fails against the old schema. If migration fails,
retain the previous application and repair forward; keep the indexes while the
new query is in use.

CI uses Node 24.21.0 and npm 11.19.0. Before running this fixture, prepare the
sibling Drive project: shared metadata imports use its generated `$app/tsconfig`.
From the repository root, with those Node and npm versions, run:

```sh
set -eu
test "$(npm --version)" = '11.19.0'
(
  cd apps/drive
  bash scripts/reject-shrinkwrap.sh .
  node scripts/verify-lock-age.mjs
  npm ci --ignore-scripts --no-audit --no-fund
  npm run check
)
(
  cd apps/drive-test
  npm ci --ignore-scripts
  npm test
)
```

This mirrors CI's guarded, age/integrity-verified Drive preparation before the
D1 tests. `npm run check` explicitly generates the SvelteKit configuration
and checks the Drive project; do not commit generated files. Each project's
`.npmrc` sets `ignore-scripts=true` and `min-release-age=3` (days). Explicit
`npm run check` and `npm test` still run their named scripts. No dependency
lifecycle-script exceptions are approved.

The initial lockfile was resolved in GitHub Actions on the bootstrap commit
`328b9d5b05a7ec8ac18444915d47d57c250a6d93` with npm 11.19.0 using
`npm install --package-lock-only --ignore-scripts --min-release-age=3`. The
artifact came from run 43571246153. The lock's `hasInstallScript` candidates
are esbuild 0.28.2, fsevents 2.3.3 and workerd 1.20261109.1; this is an
inventory, not an approval of those scripts. The pinned platform packages must
work without enabling them. The root manifest has no lifecycle hooks.

Release-age filtering applies during resolution, not as a retrospective audit
of an existing lock. Missing registry timestamps and non-registry sources may
limit the age guarantee. Age filtering can delay a fresh security fix; handle
such a conflict through a narrowly reviewed exception, not a global relaxation.

## Synthetic K2 seek benchmark

In the prepared `apps/drive-test` project, run `npm test -- test/k2-listing-benchmark.test.mjs`.
The fixture traverses 5,001 and 10,001 synthetic rows in both name directions
and reports first-page time and fixture bytes, plus D1 rows read when available.
It measures seeks over precomputed integer ranks, not locale key generation,
authorized counts, cursor validation, or route rendering. This is not evidence
for the deployed Worker/D1 CPU or three-second first-render target.
