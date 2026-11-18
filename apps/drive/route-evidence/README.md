# Drive folder route evidence (NVDA + Firefox)

After the reviewed harness reaches `main`, an Actions write collaborator can invoke it while #139 is open, including while it is a draft:
```sh
head=$(gh pr view 139 --repo TogetherWeOwn/qerith --json headRefOid --jq .headRefOid)
gh workflow run drive-route-evidence.yml --repo TogetherWeOwn/qerith --ref main -f source_sha="$head"
```
Link the run and `drive-folder-route-<source SHA>-<attempt>` from #139. Compare `provenance.json` with the current #139 head and the run's `main` SHA; re-dispatch on drift. Pull requests changing the harness build and exercise a smoke route with NVDA, but have no product source SHA or product verdict.

The job projects the real route, app document and library into an ephemeral loopback preview, injecting synthetic authorization and `ReadAccess` at the existing loader call. No credential persistence, Worker, shipped hooks, real accounts or deployment. The [hosted example](https://github.com/guidepup/guidepup/actions/runs/42476096312/job/128717690171) used the same Windows image family, Playwright Firefox and [Guidepup NVDA](https://github.com/guidepup/nvda/releases/tag/0.2.1-2026.3). Both executable archives are digest-checked; npm graphs use Drive's verifier and script-disabled frozen installs. The fixture relay client uses loopback. NVDA can listen on other interfaces; the job relies on GitHub-hosted VM isolation, requires default inbound firewall protection and opens no ports. Refresh the pinned relay certificate before May 29, 2027.

- `provenance.json`, `tools.json`, `browser.json`: commits, run/attempt, Windows image, binary versions and archive hashes.
- `speech.jsonl`: keyboard steps, destination URLs and unchanged Guidepup speech for headings, title, list, file/folder labels, EmptyFolder, paging and unavailable. Missing speech, disclosure or missing full navigation fails; no tree substitute.
- `axe-*.json`, `keyboard-*.json`, screenshots: 390 and 1280 evidence (including signed out), 320 px reflow, greyscale, forced colours and reduced motion. Open screenshots and review focus, labels, contrast/token pairs, layout and copy against [Drive accessibility](../../../docs/design/accessibility.md#12-design-qa-checklist). This is not integrated staging or complete manual design QA.
- `result.json`: `runner-self-check` or `exact-head-route` with `status: captured`. A failed job or incomplete artifact is not a pass; report the specific admission, tool, state or speech failure and link any partial artifact.
