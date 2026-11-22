# Qerith repository guidance

[README.md](README.md) describes the private Drive direction and the Rust
workspace checks. Follow the relevant app or fixture instructions when working
in a subdirectory.

## Checks and review

- Run `git diff --check` and the focused checks relevant to the change. For
  Drive code, use `npm run check --prefix apps/drive` and targeted tests as
  applicable. For Rust, use the relevant checks from the README. Leave full
  suites to CI and follow the fixture instructions for dependency setup.
- Open a PR with a Conventional Commit title and complete the PR template,
  including the risk tier, attestation, and observed verification results.
- Standard changes (T1) need one independent review by a model from a different
  family than the authoring model. Changes to repository instructions are at
  least T1, including Markdown-only changes. Ordinary docs-only changes (T2)
  need a self-check and green CI.
- Critical changes (T0) need two independent cross-model reviews, one general
  and one security-focused. Treat authentication, sessions, sharing and grants,
  secrets, cryptography, and data-critical work such as storage mutations,
  migrations, backups, and erasure as critical.
- Address review findings and verify the required reviews on the final PR head.
  Confirm `ci-ok` and the required PR standards and secret-scanning workflows
  pass for that same commit. Squash-merge pinned to the reviewed SHA through
  GitHub's branch protections. Never bypass a required gate.

## Data safety and production

- Use synthetic data in local fixtures, tests, and evidence. Follow the
  [staging runbook](docs/drive-staging.md) for isolated, run-tagged fixtures,
  bounded use, and cleanup on success and failure. Keep credentials and private
  user data out of commits, logs, and artifacts.
- Stop before any merge or operation that would deploy to or change production.
  Obtain explicit owner approval for the exact candidate and production action,
  including deploys, migrations, storage changes, credentials, or grants. If
  production impact is unclear, resolve it before merging. Follow the
  [production runbook](docs/drive-production.md) for an approved release.

## Modern Web Guidance

Use the `modern-web-guidance` skill before editing browser-facing Drive HTML,
CSS, or client-side JavaScript and TypeScript. If the skill is unavailable,
use the CLI with telemetry disabled. Search one browser capability at a time,
then retrieve the relevant guide.

```sh
DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true npx -y modern-web-guidance@1.0.1 search "<2–5 word capability>"
DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true npx -y modern-web-guidance@1.0.1 retrieve "<id>"
```
