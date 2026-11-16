"""Qualify a historical Debian package in Actions, without executing it."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from debian_archive import binary_from_tar, data_archive, verify_static_amd64
from debian_metadata import decompress_index, index_entry, package_entry, verify_bytes
from debian_signatures import PRIMARY, SIGNER, check_signatures

SNAPSHOT = "https://snapshot.debian.org/archive/debian/20260712T000000Z/"
INDEX = "main/binary-amd64/Packages.xz"
PACKAGE = "pool/main/b/busybox/busybox-static_1.35.0-4+deb12u1+b1_amd64.deb"
LOCK = Path(__file__).with_name("busybox.lock.json")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, path, maximum):
    path.parent.mkdir(mode=0o700)
    subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
         "--proto-redir", "=https", "--max-time", "180", "--max-filesize", str(maximum),
         "--output", str(path), url], check=True, timeout=190,
    )
    if path.stat().st_size > maximum:
        raise ValueError("download exceeds size bound")
    return path.read_bytes()


def verified_release(root):
    keydir = root / "keyring"
    keydir.mkdir(mode=0o700)
    key = root / "key-download" / "archive-key.asc"
    fetch("https://ftp-master.debian.org/keys/archive-key-12.asc", key, 100_000)
    show = subprocess.run(
        ["gpg", "--homedir", str(keydir), "--batch", "--with-colons", "--import-options",
         "show-only", "--dry-run", "--import", str(key)], check=True, capture_output=True,
        text=True, timeout=30,
    ).stdout.splitlines()
    fingerprints = [line.split(":")[9] for line in show if line.startswith("fpr:")]
    if sum(line.startswith("pub:") for line in show) != 1 or fingerprints != [PRIMARY, SIGNER]:
        raise ValueError("unexpected archive key fingerprints")
    subprocess.run(["gpg", "--homedir", str(keydir), "--batch", "--import", str(key)],
                   check=True, capture_output=True, timeout=30)
    signed = root / "release-download" / "InRelease"
    raw = fetch(SNAPSHOT + "dists/bookworm/InRelease", signed, 2_000_000)
    release = root / "Release"
    result = subprocess.run(
        ["gpgv", "--keyring", str(keydir / "pubring.kbx"), "--status-fd", "1",
         "--output", str(release), str(signed)], capture_output=True, text=True, timeout=30,
    )
    check_signatures(result.returncode, result.stdout)
    return release.read_bytes(), digest(raw)


def qualify(root):
    release, release_digest = verified_release(root)
    size, index_digest = index_entry(release, INDEX)
    if not 0 < size <= 64 * 1024 * 1024:
        raise ValueError("index size outside bound")
    index = fetch(SNAPSHOT + "dists/bookworm/" + INDEX, root / "index-download" / "Packages.xz", size)
    verify_bytes(index, size, index_digest)
    index = decompress_index(index, 256 * 1024 * 1024)
    filename, size, package_digest = package_entry(index, "busybox-static", "1:1.35.0-4+deb12u1+b1", "amd64")
    if filename != PACKAGE or not 0 < size <= 4 * 1024 * 1024:
        raise ValueError("unexpected package path or size")
    deb = fetch(SNAPSHOT + filename, root / "package-download" / "package.deb", size)
    verify_bytes(deb, size, package_digest)
    binary = binary_from_tar(data_archive(deb))
    verify_static_amd64(binary)
    return {"snapshot": SNAPSHOT, "inrelease_sha256": release_digest,
            "primary_fingerprint": PRIMARY, "signer_fingerprint": SIGNER,
            "index_path": INDEX, "index_sha256": index_digest,
            "package_path": filename, "package_size": size, "package_sha256": package_digest,
            "binary_sha256": digest(binary), "binary_size": len(binary),
            "elf": "ELF64 little-endian x86-64 ET_EXEC; no PT_INTERP or PT_DYNAMIC",
            "historical_snapshot": True}


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("qualification must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="busybox-qualification-") as directory:
        result = qualify(Path(directory))
        if result != json.loads(LOCK.read_text(encoding="utf-8")):
            raise ValueError("qualification does not match provenance lock")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
