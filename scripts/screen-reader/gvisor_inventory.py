"""Inventory the authenticated Debian candidate without extracting or executing it."""

import gzip
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

import gvisor_metadata as metadata

SIZE = 171393970
GENERATION = "1791482698896843"
MAX_TAR = 1024 * 1024 * 1024
MAX_MEMBERS = 10000


def download(path):
    url = metadata.BASE + metadata.PACKAGE + "?generation=" + GENERATION
    subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--proto-redir", "=https", "--max-time", "180",
                    "--max-filesize", str(SIZE), "--output", str(path), url],
                   check=True, timeout=190)


def authenticate(path, pins):
    if pins != {"signer": metadata.FINGERPRINT, "index_sha256": metadata.INDEX_SHA256,
                "package": metadata.PACKAGE, "size": SIZE, "sha256": metadata.SHA256,
                "sha512": metadata.SHA512}:
        raise ValueError("unexpected authenticated metadata")
    h256, h512, total = hashlib.sha256(), hashlib.sha512(), 0
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            total += len(chunk)
            if total > SIZE:
                raise ValueError("oversized package")
            h256.update(chunk)
            h512.update(chunk)
    if (total, h256.hexdigest(), h512.hexdigest()) != (SIZE, metadata.SHA256, metadata.SHA512):
        raise ValueError("package size or digest mismatch")


def ar_members(f):
    if f.read(8) != b"!<arch>\n":
        raise ValueError("invalid ar magic")
    members = []
    while f.tell() < SIZE:
        header = f.read(60)
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("invalid ar header")
        try:
            name = header[:16].decode("ascii").strip().removesuffix("/")
            raw_size = header[48:58].decode("ascii").strip()
        except UnicodeDecodeError as exc:
            raise ValueError("invalid ar encoding") from exc
        if not re.fullmatch(r"[0-9]+", raw_size):
            raise ValueError("invalid ar size")
        size = int(raw_size)
        start = f.tell()
        if start + size + size % 2 > SIZE:
            raise ValueError("truncated ar member")
        members.append((name, start, size))
        print(json.dumps({"ar_member": name, "size": size}, ensure_ascii=True, sort_keys=True))
        if len(members) > 3:
            raise ValueError("unexpected ar member")
        f.seek(start + size)
        if size % 2 and f.read(1) != b"\n":
            raise ValueError("invalid ar padding")
    names = [m[0] for m in members]
    if (len(names) != 3 or names[0] != "debian-binary"
            or names[1] not in ("control.tar.gz", "control.tar.xz")
            or names[2] not in ("data.tar.gz", "data.tar.xz")):
        raise ValueError("unexpected ar structure")
    f.seek(members[0][1])
    if members[0][2] != 4 or f.read(4) != b"2.0\n":
        raise ValueError("unsupported deb version")
    return members


class LimitedReader:
    def __init__(self, f, size):
        self.f, self.remaining = f, size

    def read(self, size=-1):
        if size < 0:
            size = self.remaining
        data = self.f.read(min(size, self.remaining))
        self.remaining -= len(data)
        return data


class XzReader:
    def __init__(self, source):
        self.source = source
        self.decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=256 * 1024 * 1024)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, size):
        parts = []
        remaining = size
        while remaining and not self.decoder.eof:
            data = self.source.read(65536) if self.decoder.needs_input else b""
            if not data and self.decoder.needs_input:
                raise ValueError("truncated xz stream")
            chunk = self.decoder.decompress(data, max_length=remaining)
            parts.append(chunk)
            remaining -= len(chunk)
        if self.decoder.eof and (self.decoder.unused_data or self.source.remaining):
            raise ValueError("unexpected xz trailing data")
        return b"".join(parts)


def safe_path(name):
    if name == "." or name == "./":
        return "."
    name = name.removeprefix("./").rstrip("/")
    if not name or name.startswith("/") or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("unsafe archive path")
    return name


def safe_symlink(path, target):
    if not target or target.startswith("/"):
        raise ValueError("unsafe symlink")
    parts = [] if path == "." else path.split("/")[:-1]
    for part in target.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise ValueError("symlink escapes archive")
            parts.pop()
        else:
            parts.append(part)
    return target


def inventory_tar(f, member):
    name, start, size = member
    f.seek(start)
    source = LimitedReader(f, size)
    stream = (gzip.GzipFile(fileobj=source, mode="rb") if name.endswith(".gz")
              else XzReader(source))
    seen, count, total, zero = set(), 0, 0, 0
    with stream:
        def read_exact(length):
            nonlocal total
            total += length
            if total > MAX_TAR:
                raise ValueError("decompressed archive exceeds limit")
            data = stream.read(length)
            if len(data) != length:
                raise ValueError("truncated tar")
            return data

        while True:
            block = read_exact(512)
            if block == bytes(512):
                zero += 1
                if zero == 2:
                    break
                continue
            if zero:
                raise ValueError("invalid tar terminator")
            try:
                entry = tarfile.TarInfo.frombuf(block, "utf-8", "strict")
            except (tarfile.HeaderError, UnicodeError) as exc:
                raise ValueError("invalid tar header") from exc
            path = safe_path(entry.name)
            if path in seen or len(path.encode("utf-8")) > 4096:
                raise ValueError("duplicate or oversized path")
            seen.add(path)
            count += 1
            if count > MAX_MEMBERS or entry.size < 0:
                raise ValueError("too many members or invalid size")
            types = {tarfile.REGTYPE: "file", tarfile.AREGTYPE: "file", tarfile.DIRTYPE: "directory",
                     tarfile.SYMTYPE: "symlink", tarfile.LNKTYPE: "hardlink"}
            if entry.type not in types or (entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) and entry.size):
                raise ValueError("unexpected tar member type")
            link = None
            if entry.type == tarfile.SYMTYPE:
                link = safe_symlink(path, entry.linkname)
            elif entry.type == tarfile.LNKTYPE:
                link = safe_path(entry.linkname)
            print(json.dumps({"archive": name, "path": path, "type": types[entry.type],
                              "size": entry.size, "link": link}, ensure_ascii=True, sort_keys=True))
            remaining = (entry.size + 511) // 512 * 512
            while remaining:
                chunk = min(remaining, 1024 * 1024)
                read_exact(chunk)
                remaining -= chunk
        while True:
            data = stream.read(min(1024 * 1024, MAX_TAR - total + 1))
            total += len(data)
            if total > MAX_TAR or any(data):
                raise ValueError("invalid or oversized tar trailing data")
            if not data:
                break
    if source.remaining:
        raise ValueError("unconsumed compressed member")


def run(root):
    pins = metadata.verify_metadata(root)
    path = root / "candidate.deb"
    download(path)
    authenticate(path, pins)
    with path.open("rb") as f:
        members = ar_members(f)
        for member in members[1:]:
            inventory_tar(f, member)


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("inventory must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="gvisor-inventory-") as directory:
        run(Path(directory))


if __name__ == "__main__":
    main()
