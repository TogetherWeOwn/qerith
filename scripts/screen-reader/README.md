# Screen-reader evidence (under construction)

`fixture.html` is a synthetic self-test only. It has no account, authentication,
production service or external resource. It is not evidence for any application.
The self-test records Orca diagnostics and raw PCM, but it is not evidence for
an application and audio intelligibility requires independent assessment. The
pinned-source application capture route is not implemented yet.

`extract_source.py` is a preliminary source-separation primitive, not a capture
route. It requires a full commit SHA and copies only its fixed allowlist of Git
blobs into an existing empty directory, recording blob IDs and SHA-256 hashes.
It does not run the source checkout, build the component, provide a separate test
fixture, or validate application speech; none of those capabilities is implied by
a successful extraction.

The self-test starts its polite atomic status with neutral text as a workaround
for observed Orca 46.1 empty-status text caching. The expected announcement is
still set only by the button click. This does not establish support for initially
empty live regions; that case is currently unsupported, not a passing result.
