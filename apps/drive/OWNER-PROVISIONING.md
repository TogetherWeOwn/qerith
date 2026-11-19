# Owner provisioning integration boundary

Product requires a one-time deployer-held bootstrap, not a public registration
page. `OwnerProvisioning` is an **unwired protocol component**, not a CLI, a
privileged transport, or an authorization mechanism. The current Worker returns
503 and its configuration has no D1 binding. Do not expose this component from
`fetch` or use a challenge as proof of deployer authorization.

A future integrator must supply and independently test a deployer-only execution
path that authenticates **every** challenge and enrollment operation before
calling the component, connects to the intended D1 binding, and fixes the RP ID
and origin to the deployed Drive. The app and infrastructure owners must agree on
that boundary before wiring it. `{ operation: 'challenge' }` returns
`{ ok: true, options }`. The trusted browser client must pass those options
unchanged to `createOwnerEnrollment` on the configured RP origin. In particular,
it must not substitute a `user.id` or reconstruct options from the challenge.
Send the resulting `{ operation: 'enroll', challenge, response }` through the
private path. WebAuthn registration does not attest `user.id`; the server uses
only its pending ceremony to choose the principal and binding. `OwnerBootstrap`
writes the matching principal and credential and consumes the ceremony in one
transaction. Failures return only `{ ok: false }`; enrollment success returns
only `{ ok: true }`.
The transport must itself bound input sizes, prevent caching, avoid logging request
bodies, responses and credentials, and protect any deployer authentication secret
from arguments, shell history, logs and browser exposure. Never commit such a
secret or print it as diagnostic output. Revoke any temporary authorization after
use. This component does not create or manage secrets.

The private transport is still unwired: this slice alone cannot provision an
owner. Issuing new options supersedes the pending ceremony, which expires after
five minutes. Older credentials stay unbound; this is not a re-enrollment
mechanism. Recovery does not bind a replacement credential to this handle;
keep that recovery path unwired until a separate handle-aware flow is reviewed.
Before a real run, verify the target and its
migration ledger, use the approved deployment and release process, and retain the
existing forward-only migration policy. Do not use direct SQL inserts or treat a
failed ceremony as permission to bypass verification. A completed or revoked
owner cannot be replaced through bootstrap; replay and concurrent completion are
rejected by the database-backed primitive.
