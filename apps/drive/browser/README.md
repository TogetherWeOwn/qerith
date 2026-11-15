# Test-only browser evidence

This isolated Vite/Svelte fixture does not use the Worker, app hooks, routes,
authentication or storage. It proves the harness only; it does not test sign-in.
The server binds loopback on an ephemeral port, and browser requests outside its
origin are aborted, WebSockets are closed, and service workers are blocked. This
is browser request interception, not an OS-level network sandbox. No preview is
published.

CI installs `apps/drive` and this package with `npm ci --ignore-scripts`, installs
Playwright's pinned Chromium on the Actions runner, and runs:

```sh
DRIVE_BROWSER_HEAD="$(git rev-parse HEAD)" DRIVE_BROWSER_EVIDENCE_DIR="$RUNNER_TEMP/drive-browser" npm test --prefix apps/drive/browser
```

The `drive-browser-<head SHA>` artifact contains `head.txt`, screenshots, axe
WCAG 2/2.1 A/AA and 2.2 AA JSON reports, and keyboard JSON for 1280x800 and
390x844. Missing files, head mismatch, axe violations and scenario failures fail
the job. Axe `incomplete` items need human review; a passing automated scan is
not a complete accessibility audit. Evidence is uploaded only after success.
The artifact's `provenance.json` records the requested head, actual tested
checkout, base, integration snapshot, run and mode. For a pull request whose
head predates the fixture introduction and contains no browser fixture, CI
verifies both snapshot parents and runs the synthetic fixture from that separate
integration checkout. `head.txt` always identifies the actual tested checkout;
in legacy mode it is not fixture-from-head evidence. A head that includes the
introduction but deletes the fixture fails, as does a mismatched snapshot.
Local runs can include uncommitted changes and must not be treated as commit
provenance. After a CI change merges, a substantive pull request body edit starts
a fresh run on an unchanged head; rerunning an older run uses its old workflow.

To integrate another Svelte component, replace `fixture/Fixture.svelte` and
`scenario.mjs` in the consuming change. The scenario must wait for the intended
fixture state before capture, assert real keyboard focus and activation behavior,
and return a nonempty JSON-serializable record;
the runner applies it at both sizes. Keep this test isolated and synthetic; do
not introduce secrets, real accounts or network dependencies into artifacts.

Dependency policy: npm 11.19.0, three-day release age for new resolution, and
lifecycle scripts disabled. The only browser-lock install-hook candidate is
optional macOS-only `fsevents@2.3.2`; it is not needed on CI and no hook exception
is enabled. Existing locks are not retroactively covered by the age setting.
