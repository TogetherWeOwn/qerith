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
  Supply the creation ETag, the original fixture bytes (1–1024), and `wrongEtag`
  from a different synthetic generation in the trusted setup. Both tags must be
  distinct, strong, and valid for the exact provider's `If-Match` comparison;
  the helper checks HTTP syntax and length, not provider-specific formats. Do
  not invent an arbitrary mismatch token or replace the target to get this tag.
- Close over the same server-derived key in `target.request` and
  `target.matchesBoundKey`. The comparison uses the exact XML-decoded key, with
  no trimming or URL decoding. Do not construct the capability from client input
  or after an ambiguous create. Use the app's `createS3Transport` (fixed
  authority, no retries/redirects, ≤5 s per request).
- Set `readConsistency: 'authoritative'` only with documented strong read
  consistency after create and delete for the exact provider endpoint and bucket.
  Honor `cache: 'no-store'` on **every** GET at the fetch boundary and issue each
  directly to that authority. Do not use a CDN, cached/revalidated response,
  memoized response, or replica with unknown consistency. The offline fixtures
  check the request policy, not the provider's consistency guarantee.
- Pass the dispatch cancellation signal. The probe makes at most five calls in
  25 seconds: pinned read, wrong-ETag `412 PreconditionFailed`, independent pinned
  read of the same bytes and ETag, matching-ETag empty `200`/`204` with no
  `Content-Length` or exactly `0`, and unconditional GET with `404 NoSuchKey`.
  If the error XML names a key it must unambiguously match the bound key. Both
  deletes sign `If-Match`; neither selects a version. Any version/marker header
  fails the probe, even if its value is `null` or `false`.
- Record only the typed pass or failure phase with the exact provider identity
  and source revision in protected evidence. A failure never confirms deletion;
  re-use the workflow owner's cleanup, not a retry or fallback in this helper.
  A pass describes sequential behavior on one isolated object. It cannot prove
  atomicity under concurrent mutation, admit app deletion, or define a rule for
  interpreting arbitrary DELETE responses.
