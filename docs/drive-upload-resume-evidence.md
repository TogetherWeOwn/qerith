# Drive same-intent resume evidence

`readUploadResumeEvidence` is a server-only reader exercised by the disposable
Workers/D1 fixture. There is no HTTP route. The reader looks up one opaque
intent ID using a live session bearer and a trusted server-side principal ID
and login generation. The generation must not come from the browser. The
storage identity must be the server's normalized endpoint, bucket and epoch.
The first and only D1 statement uses a fresh `first-primary` session to check
those inputs and read the evidence from the same snapshot.

The shared [`UploadResumeEvidence`](../apps/drive/src/lib/upload-resume-evidence.ts)
projection contains only:

- `declaredSize`: the intent's declared byte count (0 through 5 GiB).
- `parts`: ascending records of `{ partNumber, sizeBytes, sha256 }`, starting at
  part 1. `sha256` is a 64-character lowercase hexadecimal SHA-256 of the
  exact bytes acknowledged for that slot. Parts follow the picker's 16 MiB
  layout; the final part uses the exact remaining byte count. A zero-byte
  file has one planned part with size 0.

`parts: []` means the eligible allocation has **no** recorded part operations.
`null` means unavailable or ineligible, not an empty prefix. A gap, wrong
part length, unknown or uncertain result, or legacy receipt without exact byte
proof invalidates the entire projection. Sealing, cleanup and publication
fences also make it unavailable.

This is evidence at the read snapshot only. There is no provider request,
permission to skip a byte span, or authority to send or complete an upload.
A later admitted consumer must compare the re-picked file's size to the
intent's declaration and hash the corresponding byte spans. Upload admission
must recheck current authority independently.
