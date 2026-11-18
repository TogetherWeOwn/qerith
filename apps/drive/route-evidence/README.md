# Drive folder route evidence (NVDA + Firefox)

## Run from the reviewed workflow

After this harness reaches `main`, a repository collaborator with Actions write access can run it while #139 is still open (draft is fine):

```sh
head=$(gh pr view 139 --repo TogetherWeOwn/qerith --json headRefOid --jq .headRefOid)
gh workflow run drive-route-evidence.yml --repo TogetherWeOwn/qerith --ref main -f source_sha="$head"
```

Link the run and `drive-folder-route-<source SHA>-<attempt>` artifact from the source PR. Compare `provenance.json` with the current #139 head and the workflow run's `main` SHA. If the head moves, dispatch again. The selector accepts only the live head of the open same-repository PR to `main`, not arbitrary refs. Pull requests changing the harness run a **runner self-check only**. A self-check has no source SHA and is not a product pass.

The job checks out both commits without persisting credentials. It copies the source route, app document and library into an ephemeral build, injecting synthetic `authorize` and `ReadAccess` only at the existing loader call. The original route checkout is not edited. The preview does not load the Worker, Worker bindings, production hooks or other routes and listens on a fresh loopback port. The harness sends only a synthetic fixture cookie; it uses no real accounts, credentials, data or deployment.

## Read the artifact

- `provenance.json`, `tools.json`, `browser.json`: exact commits, run/attempt, Windows image, binary versions and archive hashes.
- `speech.jsonl`: keyboard steps, destination URLs and unchanged Guidepup NVDA speech entries. Use it to review the populated title, heading, list, folder link and file label; EmptyFolder; the next/first-page links and full document announcements; and equivalent unavailable speech without revealing the denied folder title. A silence, missing state or missing full document navigation fails the job. An accessibility tree is not a replacement.
- `axe-*.json`, `keyboard-*.json`, and screenshots: route evidence at 390 and 1280, including the signed-out state; 320 px reflow, greyscale, forced colours and reduced motion. Open the screenshots and review visible focus, state legibility, contrast/token pairs, layout and copy against the [Drive accessibility checklist](../../../docs/design/accessibility.md#12-design-qa-checklist). This is synthetic route evidence, not integrated staging or complete manual design QA.
- `result.json`: either `runner-self-check` or `exact-head-route` with `status: captured`. A failed job or incomplete artifact is not a pass. Keep the failure log and partial artifact and report the specific admission, tool, state or speech failure rather than substituting screenshots.

## Tool provenance

The [Guidepup hosted example](https://github.com/guidepup/guidepup/actions/runs/42476096312/job/128717690171) used the same Windows image family, Playwright Firefox and Guidepup NVDA `0.2.1-2026.3`. This lane pins the portable [Guidepup release](https://github.com/guidepup/nvda/releases/tag/0.2.1-2026.3) SHA-256 and the [Playwright 1.62.1 Firefox build](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/browsers.json) archive SHA-256 before extraction. npm dependencies are lockfile-bound with lifecycle hooks disabled. The NVDA fixture uses its local relay at `127.0.0.1:6837`; the relay binary can listen on other interfaces, so the job requires hosted runner inbound firewall protection and never opens a firewall port. The portable relay certificate is tied to the pinned archive; renew the pin and rerun the hosted self-check before May 29, 2027 (30 days before certificate expiry).
