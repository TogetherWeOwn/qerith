# Enroll the first staging owner

**Do not activate** until DevOps has verified pre-Worker ingress on the exact
staging SHA, including coverage or disablement of all alternate hosts, and
Security and QA have accepted that evidence. Verify the protected publish run,
staging D1 migration ledger and rollback target. Confirm live `/sign-in` has
been activated on that same SHA; source or CI enrollment alone does not open
it. The [staging preview publisher](../../docs/drive-staging.md) does not arm
owner enrollment in either mode. The procedure below applies only to a
separately authorized release that binds an enrollment grant. Never use the real
owner's identity or files in CI. Staging data is not durable or backed up.

1. Agree on a short live enrollment window with the owner and deployer. The
   authorized Operator supplies `QERITH_STAGING_OWNER_ENROLLMENT` in the GitHub
   `staging` environment as `<approved-main-sha>:<expiry-unix-ms>:<base64url-token>`.
   Use 32 random bytes encoded without padding. Allow at most five minutes from
   publish preflight. A grant for a different SHA is rejected before migration;
   an expiry during migration leaves enrollment off. Never give the browser the
   bearer or put it in a URL, argument, shell history, trace, or log.
2. The deployer sends `POST /api/deployer/owner-enrollment` to
   `https://qerith-drive-staging.5150.workers.dev` through verified ingress. Use
   `Origin: https://qerith-drive-staging.5150.workers.dev`, `Content-Type:
   application/json` and `Authorization: Bearer <token>` (the token only, without
   the expiry). Supply the header through private client input, not argv. First
   send `{"operation":"challenge"}`. Transfer only the returned `options` object
   to the owner over the approved private channel. Do not open another challenge:
   it would supersede this one.
3. On the owner's own device, confirm the exact staging origin in the browser.
   In the approved browser session on that origin, pass `options` unchanged to
   `createOwnerEnrollment` (`src/lib/owner-registration.ts`). Equivalently, use
   `PublicKeyCredential.parseCreationOptionsFromJSON(options)` as `publicKey` in
   `navigator.credentials.create`, and build `{ operation: 'enroll', challenge:
   options.challenge, response: credential.toJSON() }`. Transfer that envelope
   back privately without logging it. Do not reconstruct the options or alter the
   user handle. The deployer sends the envelope to the same endpoint with the
   same headers and checks for `200` and `{ "ok": true }`.
4. Have the owner sign out (if needed) and sign in with the enrolled passkey at
   `/sign-in`. Confirm bootstrap is closed: a still-unexpired authorization now
   gets `409`, even if the owner is later revoked. Clear the temporary GitHub secret
   and local exchange material. The next approved publish without a grant
   disarms any inherited Worker secret. Without an active release-bound grant,
   an unready preview returns `503`; a qualified preview returns a bodyless `404`
   without dispatching enrollment. Neither response means enrollment is open.
   Never direct-insert or reset an owner in D1 to retry.

If the enrollment response was lost, verify using sign-in before requesting
another ceremony. If the window or the challenge expired before an owner was
created, stop and arrange a new authorized window. Bootstrap cannot replace a
credential for an existing or revoked owner.
