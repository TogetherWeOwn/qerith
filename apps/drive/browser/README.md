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

On the matching head, CI builds the generated Worker once and runs `sign-in.mjs`
and then the staging-origin fixture in separate Chromium steps. Each entrypoint,
including its cleanup, has a 90-second timeout and a 10-second kill grace within
the same 15-minute job. Both steps use the same build and evidence directory.
The second step uses `staging-root-standalone.mjs` to run `staging-root.mjs` only
on heads with the split; earlier heads either lack staging coverage or run it
from `sign-in.mjs`. The sign-in and root-upload evidence is separate from
`staging-root-round-trip.json`: the latter uses the exact staging origin, a
disposable D1, and synthetic storage with no sign-in fixture flag or remote requests. It asserts passkey sign-in, keyboard picker, a root data refresh
without navigation, full and range byte equality, and admission denials. For
notice recovery, the relay seeds one synthetic Worker document request at a time
and checks the Worker's expiration header; Chromium checks the rendered notice
and focus, not cookie-jar deletion.

The isolated RootUpload continuation fixture writes `root-continuation-*.json`,
finishing, publication and interruption screenshots, and axe results at 1280 and
390 px. Its injected fetcher records requests for a fully acknowledged file, an
absent or acknowledged empty part, a refused nonempty suffix, a canceled picker,
and a deliberate fresh upload of the exact refused file on the same page.
It holds completion to verify accepted bytes without early publication, and
holds the suffix evidence response to verify zero credit before refusal. Raw
API and listing data requests are blocked and fail the scenario. The CI artifact
validator requires the trace, screenshots and axe report at both widths. The
fixture does not enable continuation on any Worker route.

The owned-file K7/K10 fixture (`?delete-file`) uses only synthetic rows. Playwright
intercepts `POST /api/entries/:id/delete` and asserts the exact JSON bytes. It
never forwards the mutation to a Worker; mocked `202` means request acceptance,
not proof of physical removal. `delete-file-*-keyboard.json` records the request
trace, keyboard focus and Playwright ARIA snapshots; `delete-file-*.png` and
`axe-delete-file-*.json` cover open, saving, error and accepted states at 1280×800
and 390×844, with extra captures for greyscale, forced colours and 320px reflow.
Screen reader: carried (`DeleteFileFixture`); run the pass on the first route that
renders it. No live listing, admission, folder deletes or storage are exercised.

The isolated K13 picker (`?share-recipient`) consumes synthetic choices, never a
provider or Worker. `share-recipient-*.png`, `axe-share-recipient-*.json` and
`share-recipient-*-keyboard.json` capture empty selection, options, picked chips
and no matches at 1280×800, 390×844 and 320px reflow. The scenario checks that
Enter never commits free text or submits the enclosing form, and that chip
removal returns focus to the input. Screen reader: carried (`ShareRecipientPicker`)
to the first route that renders it; fixture ARIA snapshots are supplementary.

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
