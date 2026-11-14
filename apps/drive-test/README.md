# Workers D1 test fixture

This fixture exercises the Workers Vitest integration and local D1 migration
helper with a test-only migration. It uses an ephemeral local binding and no
Cloudflare credentials; it does not establish remote D1 deployment parity or
cover the Drive metadata contract.

CI uses Node 24.21.0 and npm 11.19.0, checks the npm version, performs `npm ci`
with lifecycle scripts disabled, and runs `npm test`. The project `.npmrc`
sets `ignore-scripts=true` and `min-release-age=3` (days). Explicit `npm test`
still runs the named test script. No dependency lifecycle-script exceptions are
approved.

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
