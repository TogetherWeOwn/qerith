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

`target-fixture/` is a separate, trusted fixture for a future isolated build.
`prepare_target.py REPOSITORY COMMIT EMPTY_DESTINATION` assembles copies of the
fixture alongside a `source/` directory containing only extracted pinned blobs
and their manifest. The fixture's callbacks only simulate presentation states;
they do not authenticate. This assembly has not yet been built or connected to
the capture session and is not application speech evidence. Target source can
itself execute code, so assembly is not a sandbox: do not build or run it outside
the planned isolated, local-only runner boundary.

The self-test starts its polite atomic status with neutral text as a workaround
for observed Orca 46.1 empty-status text caching. The expected announcement is
still set only by the button click. This does not establish support for initially
empty live regions; that case is currently unsupported, not a passing result.
