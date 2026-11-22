# PR test mutations

GitHub Actions compares the integration commit with its first parent. The second parent must match
the PR head. The first must contain the event base and belong to the target branch. Main is a no-op.

The first four added, modified or Git-detected renamed `*.test.mjs` paths in lexical order are
targets. Source-only PRs have no targets. Synthetic proofs run with Node and Vitest.

Eligible source is a tracked regular file in a direct relative static import ending in `.mjs`,
`.js` or `.ts`. Tests, specs, declarations, fixtures, dependencies and SvelteKit output are excluded.
Sample four comparisons per target by path and position, with added or edited lines first. Each
mutant swaps one operator from the pairs `===` and `!==`, `<` and `<=`, or `>` and `>=`.

A survivor on an added or edited line fails the check. On unchanged lines Git must map the operator
and column to a module directly imported by the base test. Renames use old paths. That survivor
fails only if the base test kills it. New tests of unchanged source have no eligible mutants.

Node enables the local Wrangler case. Vitest runs the offline Workers tests. Missing test results,
clean failures and timeouts are execution errors. Each test run has a 30-second limit.
`staging-qualification-inventory.test.mjs` has 60 seconds for its isolated Git and
SQLite fixtures. The job has a 25-minute limit. Logs record commit SHAs, omitted
targets, candidate counts and verdicts.
