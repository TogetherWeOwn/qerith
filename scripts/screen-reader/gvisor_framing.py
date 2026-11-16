""Qualify authenticated package framing without extracting package contents."""

import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile

import gvisor_inventory as inventory
import gvisor_metadata as metadata
from gvisor_extract import MAX_COMPRESSED, MAX_TAR, _SingleGzip

MAX_MEMBERS = 10000


def inspect(data):
    """Inventory one strict gzip tar, including its complete bounded termination."""
    if len(data) > MAX_COMPRESSED:
        raise ValueError("compressed archive exceeds limit")
    stream = _SingleGzip(data)
    total, seen, records = 0, set(), []

    def read_exact(size):
        nonlocal total
        total += size
        if total > MAX_TAR:
            raise ValueError("decompression limit exceeded")
        chunk = stream.read(size)
        if len(chunk) != size:
            raise ValueError("truncated tar")
        return chunk

    while True:
        header = read_exact(512)
        if header == bytes(512):
            if read_exact(512) != bytes(512):
                raise ValueError("invalid tar terminator")
            break
        try:
            entry = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        except (tarfile.HeaderError, UnicodeError) as exc:
            raise ValueError("invalid tar header") from exc
        path = inventory.safe_path(entry.name)
        if path in seen or len(path.encode("utf-8")) > 4096 or len(seen) >= MAX_MEMBERS:
            raise ValueError("duplicate or oversized archive inventory")
        seen.add(path)
        types = {tarfile.REGTYPE: "file", tarfile.AREGTYPE: "file", tarfile.DIRTYPE: "directory",
                 tarfile.SYMTYPE: "symlink", tarfile.LNKTYPE: "hardlink"}
        if entry.type not in types or entry.size < 0 or (entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) and entry.size):
            raise ValueError("unsupported tar type or size")
        link = None
        if entry.type == tarfile.SYMTYPE:
            link = inventory.safe_symlink(entry.linkname)
        elif entry.type == tarfile.LNKTYPE:
            link = inventory.safe_path(entry.linkname)
        records.append({"path": path, "raw_path": entry.name, "type": types[entry.type],
                        "size": entry.size, "link": link})
        remaining = entry.size
        while remaining:
            amount = min(remaining, 1024 * 1024)
            read_exact(amount)
            remaining -= amount
        padding = (-entry.size) % 512
        if padding and any(read_exact(padding)):
            raise ValueError("invalid tar entry padding")
    while True:
        chunk = stream.read(min(1024 * 1024, MAX_TAR - total + 1))
        total += len(chunk)
        if total > MAX_TAR or any(chunk):
            raise ValueError("invalid or oversized tar trailing data")
        if not chunk:
            break
    return records, total


def run(root):
    pins = metadata.verify_metadata(root)
    path = root / "candidate.deb"
    inventory.download(path)
    inventory.authenticate(path, pins)
    # Authenticate the exact immutable bytes that all subsequent parsers consume.
    with path.open("rb") as package:
        data = package.read(inventory.SIZE + 1)
    if (len(data) != inventory.SIZE or hashlib.sha256(data).hexdigest() != metadata.SHA256
            or hashlib.sha512(data).hexdigest() != metadata.SHA512):
        raise ValueError("package bytes changed after authentication")
    f = io.BytesIO(data)
    members = inventory.ar_members(f)
    name, start, size = members[2]
    if name != "data.tar.gz" or size > MAX_COMPRESSED:
        raise ValueError("unsupported data member")
    records, expanded = inspect(data[start:start + size])
    for record in records:
        print(json.dumps(record, ensure_ascii=True, sort_keys=True))
    print(json.dumps({"compressed_size": size, "expanded_size": expanded,
                      "entries": len(records), "framing": "single-member-zero-flags-no-trailing"}, sort_keys=True))


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("qualification must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="gvisor-framing-") as directory:
        run(Path(directory))


if __name__ == "__main__":
    main()
