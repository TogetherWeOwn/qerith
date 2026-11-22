# PR test mutations

The `ci / PR test mutations` check compares the GitHub PR integration commit
against its base parent. It verifies that both parents match the event's base
and PR head SHAs. This excludes changes already on the base branch. On main,
the check reports success without running mutants. It stands outside `ci-ok`.

- Targets are added, modified or Git-detected renamed `*.test.mjs` files. The
  first four paths in lexical order are sampled. The job logs omitted targets.
  A source-only diff has no targets. The gate's own test file invokes its
  synthetic proof separately when the controller or proof changes.
- Within each target, eligible source is a direct static relative import with
  an explicit `.mjs`, `.js` or `.ts` extension. The source must be a regular
  repository file. Test/spec/declaration files and files under `fixtures`,
  `node_modules` and `.svelte-kit` are excluded. Transitive imports, aliases,
  dynamic imports and SQL are outside this pass.
- Each mutant swaps a single binary comparison operator: `===` with `!==`,
  `<` with `<=`, or `>` with `>=`. The first four eligible operators per
  target are sampled, ordered by source path and position, with added or
  edited source lines first. An unchanged line is eligible only if Git maps
  it to a base line and the old test directly imports that base module with
  the same operator at the same column. Git-detected renames use the old paths.
- The selected test first runs on clean source. Node runs ordinary tests and
  Vitest runs the offline D1 tests. The migration test enables its local
  Wrangler assertion. A mutant survives when the same file reports passing
  tests with the changed operator. On an unchanged line, a
  survivor is grandfathered only if the corresponding base mutant also
  survives the old test on its own cleanly passing checkout. A survivor on
  an added or edited line or one the base test killed fails the job.

Each test invocation has a 30-second limit and the job has 15 minutes. Clean
test failures, timeouts and runner errors fail the check as execution errors.
The job logs both commit SHAs, target and candidate counts, and the verdict
for each sampled operator. The synthetic hosted proof uses the same command
on tiny Git diffs and asserts exit status for a strong assertion, a weak
assertion, a weakened existing assertion, and an unrelated diff. The strong
case also asserts that an existing survivor is accepted.
