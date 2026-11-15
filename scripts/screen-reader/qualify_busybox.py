"""Actions-only historical Debian BusyBox qualification; never execute it."""

import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile

from debian_metadata import decompress_index, index_entry, package_entry, verify_bytes

PRIMARY = "B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8"
SIGNER = "4CB50190207B4758A3F73A796ED0E7B82643E131"
SNAPSHOT = "https://snapshot.debian.org/archive/debian/20260712T000000Z/"
INDEX = "main/binary-amd64/Packages.xz"
PACKAGE = "pool/main/b/busybox/busybox-static_1.35.0-4+deb12u1+b1_amd64.deb"


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
    keydir = root / "key"
    keydir.mkdir(mode=0o700)
    key = root / "key-download" / "archive-key.asc"
    fetch("https://ftp-master.debian.org/keys/archive-key-12.asc", key, 100_000)
    show = subprocess.run(
        ["gpg", "--homedir", str(keydir), "--batch", "--with-colons", "--import-options",
         "show-only", "--dry-run", "--import", str(key)], check=True, capture_output=True, text=True,
        timeout=30,
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
         "--output", str(release), str(signed)], check=True, capture_output=True, text=True, timeout=30,
    )
    signatures = [line.split() for line in result.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
    if len(signatures) != 1 or signatures[0][2] != SIGNER or signatures[0][-1] != PRIMARY:
        raise ValueError("unexpected release signer")
    return release.read_bytes(), hashlib.sha256(raw).hexdigest()


def data_archive(deb):
    if not deb.startswith(b"!<arch>\n"):
        raise ValueError("invalid deb archive")
    offset, members = 8, {}
    while offset < len(deb):
        header = deb[offset:offset + 60]
        if len(header) != 60 or header[58:60] != b"`\n":
            raise ValueError("invalid ar header")
        name = header[:16].decode("ascii").strip().removesuffix("/")
        size = int(header[48:58].decode("ascii").strip())
        start, end = offset + 60, offset + 60 + size
        if size < 0 or end > len(deb) or name in members:
            raise ValueError("invalid ar member")
        members[name] = deb[start:end]
        offset = end + (size % 2)
    if offset != len(deb) or set(members) != {"debian-binary", "control.tar.xz", "data.tar.xz"}:
        raise ValueError("unexpected deb members")
    if members["debian-binary"] != b"2.0\n":
        raise ValueError("unsupported deb format")
    return decompress_index(members["data.tar.xz"], 16 * 1024 * 1024)


def binary_from_tar(data):
    binary = None
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            name = member.name.removeprefix("./").rstrip("/")
            if name in ("", ".", "bin", "usr", "usr/share", "usr/share/doc", "usr/share/doc/busybox-static", "usr/share/man", "usr/share/man/man1") and member.isdir():
                continue
            if name == "bin/busybox" and member.isfile() and binary is None and 0 < member.size <= 8 * 1024 * 1024:
                binary = archive.extractfile(member).read(member.size + 1)
                if len(binary) != member.size:
                    raise ValueError("truncated binary")
                continue
            # Documentation is not extracted or interpreted; reject links and special files.
            if name.startswith(("usr/share/doc/busybox-static/", "usr/share/man/man1/")) and member.isfile() and member.size <= 2 * 1024 * 1024 and "/../" not in name:
                continue
            raise ValueError("unexpected tar entry: " + repr(member.name))
    if binary is None:
        raise ValueError("missing BusyBox binary")
    return binary


def verify_static_amd64(data):
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        raise ValueError("not little-endian ELF64")
    kind, machine = struct.unpack_from("<HH", data, 16)
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    if kind != 2 or machine != 62 or phentsize != 56 or not 0 < phnum <= 128 or phoff + phentsize * phnum > len(data):
        raise ValueError("unexpected ELF header")
    types = [struct.unpack_from("<I", data, phoff + i * phentsize)[0] for i in range(phnum)]
    if 3 in types or 2 in types or 1 not in types:
        raise ValueError("ELF has interpreter or dynamic segment, or no load segment")


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("qualification must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="busybox-qualification-") as directory:
        root = Path(directory)
        release, release_digest = verified_release(root)
        size, digest = index_entry(release, INDEX)
        if not 0 < size <= 64 * 1024 * 1024:
            raise ValueError("index size outside bound")
        index = fetch(SNAPSHOT + "dists/bookworm/" + INDEX, root / "index-download" / "Packages.xz", size)
        verify_bytes(index, size, digest)
        index = decompress_index(index, 256 * 1024 * 1024)
        filename, size, digest = package_entry(index, "busybox-static", "1:1.35.0-4+deb12u1+b1", "amd64")
        if filename != PACKAGE or not 0 < size <= 4 * 1024 * 1024:
            raise ValueError("unexpected package path or size")
        deb = fetch("https://deb.debian.org/debian/" + filename, root / "package-download" / "package.deb", size)
        verify_bytes(deb, size, digest)
        binary = binary_from_tar(data_archive(deb))
        verify_static_amd64(binary)
        print(json.dumps({"snapshot": SNAPSHOT, "inrelease_sha256": release_digest,
                          "primary_fingerprint": PRIMARY, "signer_fingerprint": SIGNER,
                          "index_path": INDEX, "index_sha256": hashlib.sha256((root / "index-download" / "Packages.xz").read_bytes()).hexdigest(),
                          "package_path": filename, "package_size": size, "package_sha256": digest,
                          "binary_sha256": hashlib.sha256(binary).hexdigest(), "binary_size": len(binary),
                          "elf": "ELF64 little-endian x86-64 ET_EXEC; no PT_INTERP or PT_DYNAMIC",
                          "historical_snapshot": True}, indent=2))


if __name__ == "__main__":
    main()
