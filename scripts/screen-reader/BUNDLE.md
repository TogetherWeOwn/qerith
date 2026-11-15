# Offline bundle bytes

`python3 -I scripts/screen-reader/bundle_bytes.py acquire apps/drive/package-lock.json NEW_DIRECTORY`
downloads Node.js 24.21.0 Linux x64 and the locked registry tarballs; `verify`
instead of `acquire` verifies an existing directory offline. A failed acquisition
may leave a partial directory; discard it before retrying. No archive is extracted
or executed. The Node SHA-256 pin comes from the Node.js release checksum list;
a checksum from the same publisher is not independent proof of publisher identity.
Review pin and lock changes as supply-chain changes.

The caller must protect both the trusted lockfile and bundle from modification
between verification and use. Verification rejects missing, extra, altered,
empty, oversized and symbolic-link entries. A future cache consumer must use
only the verified set and must not accept unverified glob inputs. This tool does
not establish network isolation, a sandbox, or release-age compliance.
