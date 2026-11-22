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
not a complete accessibility audit. The final artifact is published after the
existing scenario checks pass, then the separate registry coverage check reads it.
The artifact's `provenance.json` records the requested head, actual tested
checkout, base, integration snapshot, trusted policy commit, run and mode. For a pull request whose
head predates the fixture introduction and contains no browser fixture, CI
verifies both snapshot parents and runs the synthetic fixture from that separate
integration checkout. `head.txt` always identifies the actual tested checkout;
in legacy mode it is not fixture-from-head evidence. A head that includes the
introduction but deletes the fixture fails, as does a mismatched snapshot.
Local runs can include uncommitted changes and must not be treated as commit
provenance. After a CI change merges, a substantive pull request body edit starts
a fresh run on an unchanged head; rerunning an older run uses its old workflow.

On the matching head, CI builds the generated Worker once and runs the
registered generated commands with separate 90-second deadlines and 10-second
kill grace periods. The sign-in and staging-origin commands share the build
and evidence directory. Earlier heads either lack the staging split or run
staging from `sign-in.mjs`. The sign-in and root-upload evidence is separate from
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

The isolated K13 picker (`?share-recipient`) uses synthetic choices, not a provider.
`*share-recipient-*` evidence covers keyboard, axe and reflow at 1280×800, 390×844
and 320×844. Screen reader: carried to the first route rendering `ShareRecipientPicker`.

To add an isolated scenario, add one `<scenario>.mjs` module exporting
`exercise(browser, origin, axe, output, entry)` and a matching entry in
`scenarios.json`. Declare the states, widths `[390, 1280]`, and modes
`["screenshot", "axe", "keyboard", "greyscale", "forced-colours", "reflow"]`.
Use `captureAccessibility` for each state and width after asserting the
fixture is ready. The helper captures the keyboard focus and ARIA tree and
repeats the layout at 320 px for the reflow image.

CI validates the fixture on the tested commit and reads acceptance policy from
the verified main snapshot. Existing artifacts are named in the legacy
inventory. New scenario entries add requirements for their modules and full
accessibility sets. Coverage fails on an unregistered module, a missing
required artifact, or an artifact outside the claimed sets. Keep fixtures
synthetic and their artifacts free of secrets and real account data.

Dependency policy: npm 11.19.0, three-day release age for new resolution, and
lifecycle scripts disabled. The only browser-lock install-hook candidate is
optional macOS-only `fsevents@2.3.2`; it is not needed on CI and no hook exception
is enabled. Existing locks are not retroactively covered by the age setting.
