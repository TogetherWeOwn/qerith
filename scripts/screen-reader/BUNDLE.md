# Screen-reader fixture tool inputs

The intended bundle targets Linux x86-64 and uses the existing Drive lockfile,
`apps/drive/package-lock.json` (npm lockfile v3), including its exact registry
URLs and SHA-512 integrity values. Its tool input is the official Node.js
24.21.0 Linux x64 distribution, `node-v24.21.0-linux-x64.tar.xz`:

- Source: <https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz>
- SHA-256: `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`
- Published checksum list: <https://nodejs.org/dist/v24.21.0/SHASUMS256.txt>

The checksum list was inspected on 2026-11-15; a checksum copied from the same
origin is an integrity pin, not independent proof of publisher identity. Review
updates to the pin and lockfile as supply-chain changes. The lockfile includes
install-hook candidates for esbuild, fsevents, workerd and nested esbuild
versions. Offline consumption must use frozen `npm ci`, refuse lifecycle
scripts, and verify downloaded bytes against the pins. Existing locks do not
establish a release-age audit. There are no approved script exceptions.

`bundle_inputs.py acquire LOCK NEW_DIRECTORY` downloads the pinned tool and
lockfile artifacts into a newly created directory and verifies their digests.
`bundle_inputs.py verify LOCK DIRECTORY` checks the required bytes offline
against the supplied trusted lockfile and pinned Node checksum. A failed download
may leave a partial directory; discard it before retrying. Neither operation
extracts or runs artifact contents. Unit tests cover simulated acquisition and
verification; actual downloads and an offline npm install remain unverified.

## Offline consumption (pending Actions validation)

Use a private, immutable copy of the verified bundle and trusted lockfile; no
other process may modify either between verification and consumption. In an
empty Linux x64 working area, with `BUNDLE`, `LOCK`, and `SCRIPT` set to the
absolute paths of the bundle, trusted lockfile, and `bundle_inputs.py`:

```sh
set -eu
python3 -I "$SCRIPT" verify "$LOCK" "$BUNDLE"
mkdir tool cache
# Extract only the digest-verified official tool archive, never a fixture archive.
tar -xJf "$BUNDLE/node-v24.21.0-linux-x64.tar.xz" -C tool
export PATH="$PWD/tool/node-v24.21.0-linux-x64/bin:$PATH"
test "$(node --version)" = v24.21.0
test "$(npm --version)" = 11.19.0
for artifact in "$BUNDLE"/*.tgz; do
  npm cache add "$artifact" --offline --ignore-scripts --cache "$PWD/cache"
done
```

Then use that cache with a trusted copy of the Drive `package.json` and the
same lockfile: `npm ci --offline --ignore-scripts --no-audit --no-fund
--min-release-age=3 --cache /absolute/path/to/cache`. Run it in a new disposable
project directory, with no alternate lockfile or pre-existing `node_modules`.
`npm ci` must fail if the manifest and lock disagree or required content is
missing. The age setting does not audit existing lock entries; the separate
Drive release-age verification still applies. This recipe does not prove network
isolation, guard concurrent mutation, or provide a sandbox. Do not run extracted
fixture code here; the parent owns confinement and integration. The cache-seeding
and install recipe is not yet validated with real artifacts.
