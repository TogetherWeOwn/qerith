# Offline bundle bytes

`python3 -I scripts/screen-reader/bundle_bytes.py acquire apps/drive/package-lock.json NEW_DIRECTORY`
downloads Node.js 24.21.0 Linux x64 and the locked registry tarballs; `verify`
instead of `acquire` verifies an existing directory offline. A failed acquisition
may leave a partial directory; discard it before retrying. No archive is extracted
or executed. The Node SHA-256 pin comes from the Node.js release checksum list;
a checksum from the same publisher is not independent proof of publisher identity.
Review pin and lock changes as supply-chain changes.

## Offline consumption

Protect the trusted lockfile and bundle from modification between verification
and use. Verification rejects missing, extra, altered, empty, oversized and
symbolic-link entries, so the glob below selects only verified package bytes.
With absolute paths `REPO` (the trusted checkout), `BUNDLE` and `LOCK`, run
from an empty private working directory:

```sh
set -eu
python3 -I "$REPO/scripts/screen-reader/bundle_bytes.py" verify "$LOCK" "$BUNDLE"
mkdir tool cache project
tar -xJf "$BUNDLE/node-v24.21.0-linux-x64.tar.xz" -C tool
export PATH="$PWD/tool/node-v24.21.0-linux-x64/bin:$PATH"
test "$(node --version)" = v24.21.0
test "$(npm --version)" = 11.19.0
for artifact in "$BUNDLE"/*.tgz; do
  npm cache add "$artifact" --offline --ignore-scripts --cache "$PWD/cache"
done
cp "$REPO/apps/drive/package.json" "$LOCK" project/
npm ci --prefix project --offline --ignore-scripts --include=dev --include=optional --no-audit --no-fund \
  --min-release-age=3 --cache "$PWD/cache"
```

The lock must be named `package-lock.json` and match the trusted manifest.
There are no approved lifecycle-script exceptions. The age flag does not audit
existing lock entries; the separate Drive release-age verification still applies.
The recipe does not establish network isolation, guard concurrent mutation, or
provide a sandbox. Do not run extracted fixture code; the parent owns confinement
and integration. The CI acquisition job exercises the frozen offline install.
