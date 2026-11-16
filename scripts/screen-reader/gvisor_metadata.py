"""Authenticate the pinned gVisor Debian candidate's metadata, not its contents.

The installation guide delegates archive-key distribution to gvisor.dev/archive.key.
The full fingerprint below was reviewed against that HTTPS endpoint and publisher
source; it was not independently published as a fingerprint. Rotation requires a
new trust review. A valid signature does not attest source-to-binary provenance,
package suitability, or authenticate the separately distributed tarball.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile

from debian_metadata import index_entry, verify_bytes

BASE = "https://storage.googleapis.com/gvisor/releases/"
KEY_URL = "https://gvisor.dev/archive.key"
FINGERPRINT = "6F1DF85E3A71C24918E727D56FC6D554E32BD943"
INDEX = "main/binary-amd64/Packages"
INDEX_SHA256 = "43da44ae3e85d56d62146c93984d0425c278d8a76552fb529d21038a630e7570"
PACKAGE = "pool/20261005.0/binary-amd64/runsc.deb"
SHA256 = "2e7193c95424de28ac1a936fd5f0ec615dd288b74517bba697aa87c06df4a7c4"
SHA512 = ("06a4cb93a539d544bbb25224867734774e8d55c52eb1b8ca63b17aa65d056144"
          "4342542852a7d93fae6a12635899415349b149012a64e484aaf038f0136e4968")


def fetch(url, path, maximum):
    path.parent.mkdir(mode=0o700)
    subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
        "--proto-redir", "=https", "--max-time", "60", "--max-filesize", str(maximum),
        "--output", str(path), url,
    ], check=True, timeout=70)
    data = path.read_bytes()
    if len(data) > maximum:
        raise ValueError("download exceeds limit")
    return data


def check_key(colons):
    lines = [line.split(":") for line in colons.splitlines()]
    public = [line for line in lines if line[0] == "pub"]
    fingerprints = [line[9] for line in lines if line[0] == "fpr" and len(line) > 9]
    if len(public) != 1 or fingerprints != [FINGERPRINT]:
        raise ValueError("unexpected archive key")


def check_signature(returncode, status):
    lines = status.splitlines()
    if returncode != 0 or any(not line.startswith("[GNUPG:] ") for line in lines):
        raise ValueError("signature verification failed")
    records = [line.split()[1:] for line in lines]
    valid = [record for record in records if record and record[0] == "VALIDSIG"]
    newsig = [record for record in records if record and record[0] == "NEWSIG"]
    if (len(newsig) != 1 or len(valid) != 1 or len(valid[0]) != 11
            or valid[0][1] != FINGERPRINT or valid[0][-1] != FINGERPRINT):
        raise ValueError("unexpected release signature")
    allowed = {"NEWSIG", "KEY_CONSIDERED", "SIG_ID", "GOODSIG", "VALIDSIG", "PLAINTEXT"}
    if any(not record or record[0] not in allowed for record in records):
        raise ValueError("unexpected signature status")


def check_package(index):
    paragraphs = index.decode("utf-8", "strict").strip().split("\n\n")
    if len(paragraphs) != 1:
        raise ValueError("unexpected package index structure")
    fields = {}
    critical = {"package", "version", "architecture", "filename", "size", "sha256", "sha512"}
    key = None
    for line in paragraphs[0].splitlines():
        if line.startswith((" ", "\t")):
            if key is None or key in critical:
                raise ValueError("unexpected field continuation")
            continue
        key, separator, value = line.partition(":")
        key = key.lower()
        if not separator or key in fields:
            raise ValueError("invalid or duplicate package field")
        fields[key] = value.strip()
    expected = {"package": "runsc", "version": "20261005.0", "architecture": "amd64",
                "filename": PACKAGE, "size": "171393970", "sha256": SHA256, "sha512": SHA512}
    if any(fields.get(key) != value for key, value in expected.items()):
        raise ValueError("unexpected candidate metadata")


def verified_release(root):
    key = root / "key-download" / "archive.key"
    fetch(KEY_URL, key, 100_000)
    home = root / "keyring"
    home.mkdir(mode=0o700)
    shown = subprocess.run([
        "gpg", "--homedir", str(home), "--batch", "--with-colons", "--import-options",
        "show-only", "--dry-run", "--import", str(key),
    ], check=True, capture_output=True, text=True, timeout=30)
    check_key(shown.stdout)
    subprocess.run(["gpg", "--homedir", str(home), "--batch", "--import", str(key)],
                   check=True, capture_output=True, timeout=30)
    signed = root / "release-download" / "InRelease"
    fetch(BASE + "dists/20261005/InRelease", signed, 1_000_000)
    release = root / "Release"
    result = subprocess.run([
        "gpgv", "--keyring", str(home / "pubring.kbx"), "--status-fd", "1",
        "--output", str(release), str(signed),
    ], capture_output=True, text=True, timeout=30)
    check_signature(result.returncode, result.stdout)
    return release.read_bytes()


def verify_metadata(root):
    release = verified_release(root)
    size, digest = index_entry(release, INDEX)
    if (size, digest) != (598, INDEX_SHA256):
        raise ValueError("unexpected signed index metadata")
    index = fetch(BASE + "dists/20261005/" + INDEX, root / "index-download" / "Packages", size)
    verify_bytes(index, size, digest)
    check_package(index)
    return {"signer": FINGERPRINT, "index_sha256": digest, "package": PACKAGE,
            "size": 171393970, "sha256": SHA256, "sha512": SHA512}


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("metadata verification must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="gvisor-metadata-") as directory:
        print(json.dumps(verify_metadata(Path(directory)), sort_keys=True))


if __name__ == "__main__":
    main()
