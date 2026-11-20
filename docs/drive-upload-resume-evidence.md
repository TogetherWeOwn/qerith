# Drive same-intent resume evidence

The disposable Worker/D1 fixture serves `GET /api/uploads/<intentId>/resume`
for one canonical lowercase UUID. Neither the app nor staging admits the route.
The request must be bodyless and have no query string. An `Origin` header, when
present, must match the Worker origin; `Sec-Fetch-Site` must be absent or
`same-origin`. The handler derives the active session, principal and login
generation on the server and uses the qualified, normalized upload storage
binding. The reader rechecks these inputs and the evidence in the same fresh
`first-primary` D1 snapshot.

The shared [`UploadResumeEvidence`](../apps/drive/src/lib/upload-resume-evidence.ts)
projection contains only:

- `declaredSize`: the intent's declared byte count (0 through 5 GiB).
- `parts`: ascending records of `{ partNumber, sizeBytes, sha256 }`, starting at
  part 1. `sha256` is a 64-character lowercase hexadecimal SHA-256 of the
  exact bytes acknowledged for that slot. Parts follow the picker's 16 MiB
  layout; the final part uses the exact remaining byte count. A zero-byte
  file has one planned part with size 0.

Every route response is `private, no-store`. Only a `200` carries JSON;
`parts: []` means the eligible allocation has **no** recorded part operations.
The reader's `null` becomes an empty-body `404`, indistinguishable from a
missing or foreign intent. A gap, wrong part length, unknown or uncertain
result, or legacy receipt without exact byte proof invalidates the entire
projection. Sealing, cleanup and publication fences also make it unavailable.
An initially missing or inactive session receives `401`; unavailable server
storage qualification receives `503`. The exact path rejects other methods
with `405` (`Allow: GET`), invalid query/body with `400`, and cross-origin or
non-same-origin fetch metadata with `403`.

This is evidence at the read snapshot only. There is no provider request,
permission to skip a byte span, or authority to send or complete an upload.
A later admitted consumer must compare the re-picked file's size to the
intent's declaration and hash the corresponding byte spans. Upload admission
must recheck current authority independently.
