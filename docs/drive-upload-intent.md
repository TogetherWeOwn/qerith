# Drive upload intent creation

Send a same-origin `POST /api/uploads` with `Content-Type: application/json`, the live Drive session cookie, and `JSON.stringify({ size: file.size })`.
The browser supplies the exact `Origin`; do not set `Content-Length` yourself.
The UTF-8 body must contain only the literal `size` key and a decimal integer byte count from 0 through 16 MiB (inclusive), with no fraction or exponent.
The server buffers at most 64 bytes, enforces a two-second read deadline, and checks `Content-Length` when present.

| Reply | Meaning |
| --- | --- |
| `201` with `{ "id": "…" }` | Use this opaque intent ID for the subsequent part and [completion](drive-upload-completion.md) requests. It is not an entry ID, provider upload ID, or storage key. |
| `400` | Invalid or incomplete request body, or invalid size. |
| `401` / `403` | No live session/member access, or the request did not originate at the configured Drive origin. |
| `503` | The request could not proceed with the available bindings or qualified storage. |
| Empty `409` | Allocation was not confirmed for the caller. This is not a name conflict. |

Responses are private/no-store. Leave any unsuccessful or missing response interrupted: a lost acknowledgement does not prove that storage did nothing.
Do not automatically replay this POST, resend later steps, or start a replacement upload.

Allocation requires the configured HTTPS origin, live session and membership in D1, and the D1 upload claim and evidence migrations.
The S3 config, epoch, and verifier must match; the verifier must attest a usable completion budget for that storage identity.
The server retains provider identifiers and signs the request. An unconfigured Worker remains fail-closed; this route does not admit deployment or establish a browser byte round-trip.
