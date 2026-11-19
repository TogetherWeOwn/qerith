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
that boundary before wiring it. The component accepts only `{ operation:
'challenge' }` and `{ operation: 'enroll', challenge, response }`, where
`response` is a WebAuthn registration response. It delegates verification and
atomic one-time persistence to `OwnerBootstrap`. Any failure returns only
`{ ok: false }`; success never returns the owner ID or credential material.
The transport must itself bound input sizes, prevent caching, avoid logging request
bodies, responses and credentials, and protect any deployer authentication secret
from arguments, shell history, logs and browser exposure. Never commit such a
secret or print it as diagnostic output. Revoke any temporary authorization after
use. This component does not create or manage secrets.

The owner must register using a browser on the configured RP origin. The missing
private transport and browser handoff remain a real integration gap: this slice
alone cannot provision an owner. Before a real run, verify the target and its
migration ledger, use the approved deployment and release process, and retain the
existing forward-only migration policy. Do not use direct SQL inserts or treat a
failed ceremony as permission to bypass verification. A completed or revoked
owner cannot be replaced through bootstrap; replay and concurrent completion are
rejected by the database-backed primitive.
