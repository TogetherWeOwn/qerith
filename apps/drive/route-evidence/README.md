# Drive folder route evidence (NVDA + Firefox)

After the reviewed harness reaches `main`, an Actions write collaborator can invoke it while #139 is open, including while it is a draft:
```sh
head=$(gh pr view 139 --repo TogetherWeOwn/qerith --json headRefOid --jq .headRefOid)
gh workflow run drive-route-evidence.yml --repo TogetherWeOwn/qerith --ref main -f source_sha="$head"
```
Link the run and `drive-folder-route-<source SHA>-<attempt>` from #139. Compare `provenance.json` with the current #139 head and the run's `main` SHA; re-dispatch on drift. Pull requests changing the harness build and exercise a smoke route with NVDA, but have no product source SHA or product verdict.

The job projects the real route, app document and library into an ephemeral loopback preview, injecting synthetic authorization and `ReadAccess` at the existing loader call. No credential persistence, Worker, shipped hooks, real accounts or deployment. The [hosted example](https://github.com/guidepup/guidepup/actions/runs/42476096312/job/128717690171) used the same Windows image family, Playwright Firefox and [Guidepup NVDA](https://github.com/guidepup/nvda/releases/tag/0.2.1-2026.3). Both executable archives are digest-checked. The job checks manifest/lock agreement, locked registry age and integrity, and disables non-registry sources and install scripts. On the disposable hosted VM, an active inbound rule blocks non-loopback access to the NVDA relay before it starts, for both address families. The rule stays in force until the VM is destroyed. Refresh the pinned relay certificate before May 29, 2027.

- `provenance.json`, `tools.json`, `browser.json`: commits, run/attempt, Windows image, binary versions and archive hashes.
- `speech.jsonl`: keyboard steps (including activation via NVDA), destination URLs and unchanged NVDA speech. The runner compares denied/missing arrival, full title and heading speech after whitespace normalization. The synthetic continuation exercises cursor-row removal by the real loader, not live page-size or concurrent metadata changes. Missing speech or full navigation fails; no tree substitute.
- `unavailable-*.json`: denied, missing and signed-out document status, headers (excluding Date) and response body; the runner requires the same outward result.
- `axe-*.json`, `keyboard-*.json`, screenshots: 390 and 1280 evidence (including signed out), 320 px reflow, greyscale, forced colours and reduced motion. Open screenshots and review focus, labels, contrast/token pairs, layout and copy against [Drive accessibility](../../../docs/design/accessibility.md#12-design-qa-checklist). This is not integrated staging or complete manual design QA.
- `result.json`: `runner-self-check` or `exact-head-route` with `status: captured`. A failed job or incomplete artifact is not a pass; report the specific admission, tool, state or speech failure and link any partial artifact.
