# gVisor Debian companion evidence

The inventory workflow authenticates the pinned Debian package via its signed
repository metadata and inspects archive members as inert data. In the
[authenticated inspection](https://github.com/TogetherWeOwn/qerith/actions/runs/43816057736/job/133128252497)
at `a0b6588d6a09315c8b6180c0b8f56afd2d662739`, `usr/bin/runsc` and each of
`checkpointgofer`, `gvisor-sentry-prewarmer`, `gvisor_sentry`,
`runsc-fd-parking` and `runsc-metric-server` under `usr/bin/gvisor-bin` were
regular files with mode 0755 and ELF64 little-endian x86-64 ET_EXEC headers.
The companion directory had mode 0755. The prewarmer (1,416 bytes) and FD
parking (1,320 bytes) were ELF, not scripts. These observations describe that
pinned package, not every gVisor distribution.

## Version-correlated source relationships

The upstream tag `release-20261005.0` resolves to annotated tag object
`e1987e70c70be06e89be3bad7934f02ec715e333` and source commit
`97e8e896904cb364319cd9758241d3f0bd27a6f4`. This is a version correlation,
**not a source-to-package build attestation**.

- The source [release mapping](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/tools/release.bzl#L21-L61)
  and [Debian packaging](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/debian/BUILD#L10-L39)
  identify the five standard sidecars and their location alongside `runsc`.
  The [lookup](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/gvisorbinaries/gvisorbinaries.go#L70-L77)
  and [standard list](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/gvisorbinaries/gvisorbinaries.go#L210-L235)
  are consistent with those names.
- Source [sandbox startup](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/sandbox/sandbox.go#L1009-L1056)
  uses the sentry and prepends the prewarmer; strict policy fails when either
  is unavailable. [FD parking](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/sandbox/sandbox.go#L1077-L1083)
  is an optional teardown optimization. The
  [checkpoint gofer](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/checkpointgofer/README.md)
  supports GCS checkpoint/restore; the [metric-server command](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/cmd/metric_server.go#L28-L40)
  delegates to the metric sidecar. Not all five are required on every invocation.
- Source declares [prewarmer](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/prewarmer/BUILD#L15-L40)
  and [FD parking](https://github.com/google/gvisor/blob/97e8e896904cb364319cd9758241d3f0bd27a6f4/runsc/fdparking/BUILD#L16-L40)
  as freestanding C executables, consistent with the observed headers but not
  proof of the package members' complete structure or behavior.

## Limits and downstream prerequisite

The probe requires the listed members and rejects unsupported prefixes, but
accepting an ELF header or a small UTF-8 script does **not** validate a whole
executable, its interpreter, dynamic dependencies or behavior. The source
mapping does not prove the binaries were built from that source, that the
installation contains every dependency needed for a particular runtime path,
or that the package is suitable for isolation. The separate tarball is not
authenticated by this inspection. No package member is executed or installed.

Before enabling a fixture runtime, a separate, bounded qualification must
establish the actual runtime installation and dependency closure for the
selected configuration and validate its isolation behavior under an authorized
safe test boundary. If those properties cannot be established, execution must
remain disabled; this inventory is not a fallback or an approval to run it.
