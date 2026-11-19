# Drive upload intent creation

Send a same-origin `POST /api/uploads` with `Content-Type: application/json`,
the live Drive session cookie, and `JSON.stringify({ size: file.size })` as the
body. The browser supplies the exact `Origin`; do not set `Content-Length`
yourself. `size` is an integer byte count from 0 through 16 MiB (inclusive), not
a filename, a part count, or file data. The server buffers at most 64 request
bytes, with a two-second read deadline. It requires a complete UTF-8 object with
only `size`, and
checks the received length against `Content-Length` when present.

| Reply | Meaning |
| --- | --- |
| `201` with `{ "id": "…" }` | Use this opaque intent ID for the subsequent part and [completion](drive-upload-completion.md) requests. It is not an entry ID, provider upload ID, or storage key. |
| `400` | Invalid or incomplete request body, or invalid size. |
| `401` / `403` | No live session/member access, or the request did not originate at the configured Drive origin. |
| `503` | The request could not proceed with the available bindings or qualified storage. |
| Empty `409` | Allocation was not confirmed for the caller. This is not a name conflict. |

The route returns private, non-cacheable responses. On any unsuccessful or
missing response, leave the attempt interrupted. Do not automatically replay
this POST, resend later steps, or start a replacement upload: a lost
acknowledgement does not prove that storage did nothing.

Allocation requires the existing HTTPS origin, live session and membership in
D1, upload claim and evidence migrations, and matching qualified S3 config,
storage epoch and verifier bindings. The server retains provider identifiers
and signs the request itself. An unconfigured Worker remains fail-closed; this
route does not provision bindings, admit deployment, or establish a browser
byte round-trip.
