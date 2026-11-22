# Qerith PR attestation

Use `path/to/test_file::test_name` in the PR attestation. The named declaration
must be present at the PR head and new or revised since the PR's merge base.
Moving the same declaration during a Git-detected rename leaves it unchanged.
Put unchanged regression checks in Verification. The organization template's
path-only citations and documentation-only exemption still apply.

Use the literal Node or Vitest test title, the `each` format title, the Rust
test function name, or the Python `test_` function or method name. The checker
also resolves Node subtests, Rust module-qualified names, Python class-qualified
names, and JavaScript templates with one variable bound by a literal `for…of`
array or tuple table. For titles computed by other code, cite the source
template or use the existing path-only form and describe the run in `proof=`.
The matcher compares declarations and does not verify execution or test results.

## CI rollout

`Qerith PR attestation` publishes the `pr-attestation` job on `pull_request_target`
for PRs targeting `main`, including body edits. The job checks out the workflow's
protected revision and a pinned copy of the organization parser. It reads the
current PR body through the read-only API and examines bare Git data by SHA.
An invalid attestation or an evaluation error fails the job.

The workflow's `pull_request` run exercises synthetic fixtures as
`pr-attestation fixtures`. The protected PR job first runs after the workflow
lands on the default branch. The main push runs the fixtures under
`pr-attestation`. Collect the successful main run and successful runs for at
least two later PRs before considering any ruleset change. Confirm that GitHub
associates the live check with each evaluated PR head and that a body edit reruns
it. A required status name alone cannot authenticate a workflow's definition.
