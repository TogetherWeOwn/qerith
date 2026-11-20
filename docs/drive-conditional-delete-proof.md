# Drive conditional-delete probe: protected-dispatch handoff

`apps/drive/scripts/conditional-delete-proof.ts` exports `proveConditionalDelete`
and the `ConditionalDeleteTarget` / `ConditionalDeleteProof` types. Only offline
fixtures call it today. It does not admit app deletion or authorize a dispatch.

For a separately approved run, the qualification owner supplies the capability:

- Verify the exact configured endpoint, bucket and storage epoch; set
  `versioning: 'never-enabled'` only with provider evidence that the bucket has
  never been versioned (including a provider that does not support versioning).
  Unknown, suspended or enabled is not eligible. Missing response headers alone
  do not establish this prerequisite.
- Under exclusive mutation of an isolated attempt namespace, use existing setup
  to create a fresh synthetic object without overwriting any existing object.
  Supply the strong ETag from creation and the original fixture bytes (1–1024).
  Close over that exact server-derived key in `target.request`, using the app's
  `createS3Transport` (fixed authority, no retries/redirects, ≤5 s per request).
  Do not construct the capability from client input or after an ambiguous create.
- Pass the dispatch cancellation signal. The probe makes at most five calls in
  25 seconds: pinned read, wrong-ETag `412 PreconditionFailed`, pinned read of the
  same bytes and ETag, matching-ETag empty `200`/`204`, and unconditional GET with
  `404 NoSuchKey`. Both deletes sign `If-Match`; neither selects a version. Any
  version/marker header fails the probe, even if its value is `null` or `false`.
- Record the typed pass or failure phase with the exact provider identity and
  source revision in protected evidence. A failure never means deletion is
  confirmed; re-use the workflow owner's cleanup, not a retry or fallback in
  this helper. A pass is scoped to that run and is not app admission or a rule
  for interpreting arbitrary DELETE responses.
