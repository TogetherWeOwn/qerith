# Qerith repository guidance

[README.md](README.md) describes the private Drive direction and the Rust
workspace checks. Follow the relevant app or fixture instructions when working
in a subdirectory.

## Model selection and effort

- Select the provider, model, and effort when setting up each task or
  independent review. Set the effort explicitly where supported.
- Use GPT/Sol for routine implementation and Claude Opus 5.5 for design or
  high-risk work when appropriate.
- For tasks and reviews, use Opus 5.5 at `medium` effort and Sol at `high`
  effort by default. Use `high` or `xhigh` for Opus 5.5, or `xhigh` for Sol,
  only when the brief justifies the higher effort.
- Never use `max`, `ultra`, or `ultrathink` on any model.
- Choose independent reviewers from a different model family than the author.
  Follow the review tiers and owner approval requirements below.
- Keep shared guidance in `AGENTS.md` and keep `CLAUDE.md` to the single
  `@AGENTS.md` import. Keep harness-specific model settings, model-forcing
  hooks, model pins, and internal provider IDs out of tracked configuration.

## Shell hygiene

In any harness, never use forced removal (`rm -f`, `rm -rf`, or `rm --force`),
including in `trap` cleanups and `bash -lc` strings. For authorized cleanup,
use `rm -r -- "$dir"` for a directory or `rm -- "$file"` for a file.

## Checks and review

- Run `git diff --check` and the focused checks relevant to the change. For
  Drive code, use `npm run check --prefix apps/drive` and targeted tests as
  applicable. For Rust, use the relevant checks from the README. Leave full
  suites to CI and follow the fixture instructions for dependency setup.
- Open a PR with a Conventional Commit title and record the risk tier,
  attestation, and observed verification results in the
  [organization PR template](https://github.com/TogetherWeOwn/.github/blob/main/.github/pull_request_template.md).
- Standard changes (T1) need one independent review by a model from a different
  family than the authoring model. Changes to repository instructions are at
  least T1, including Markdown-only changes. Ordinary docs-only changes (T2)
  need a self-check and green CI.
- Critical changes (T0) need two independent cross-model reviews, one general
  and one security-focused. Treat authentication, sessions, sharing and grants,
  secrets, cryptography, and data-critical work such as storage mutations,
  migrations, backups, and erasure as critical.
- Use the highest attestation tier that applies, including the path and content
  minimums in the [organization contribution guide](https://github.com/TogetherWeOwn/.github/blob/main/CONTRIBUTING.md#5-attestation-in-the-pr-template).
  Assess path sensitivity separately using the [repository path map](.github/review-tiers.yml).
- Answer automated review findings in their threads. Start each reply with
  `Fixed in <sha>`, `Rejected: <proof>`, or `Duplicate of <link>` as applicable.
- Verify the required reviews on the final PR head. Confirm `ci-ok` and the
  required PR standards and secret-scanning workflows pass for that same commit.
  Squash-merge pinned to the reviewed SHA through the repository's rulesets.
  Never bypass a required gate.

## Data safety and production

- Use synthetic data in local fixtures, tests, and evidence. Follow the
  [staging runbook](docs/drive-staging.md) for isolated, run-tagged fixtures,
  bounded use, and cleanup on success and failure. Keep credentials and private
  user data out of commits, logs, and artifacts.
- Stop before any merge or operation that would deploy to or change production.
  Treat unclear impact as production. Obtain explicit approval for the exact
  candidate and action from the repository owner acting as Release Manager.
  This applies to deploys, migrations, storage changes, credentials, and grants.
  Record the independent exact-SHA acceptance and meet the other release
  prerequisites in the [production runbook](docs/drive-production.md).

## Modern Web Guidance

Use the `modern-web-guidance` skill before editing browser-facing Drive HTML,
CSS, or client-side JavaScript and TypeScript. If the skill is unavailable,
use the CLI with telemetry disabled. Search one browser capability at a time,
then retrieve the relevant guide.

```sh
DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true npx -y modern-web-guidance@1.0.1 search "<2–5 word capability>"
DISABLE_TELEMETRY=1 npm_config_ignore_scripts=true npx -y modern-web-guidance@1.0.1 retrieve "<id>"
```
