"""Synthetic, inert extraction primitive; not an admission path for packages.

The caller must independently authorize the exact digest and size before any
real artifact is admitted. This module does not provide such authorization.
"""

import gzip
import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile

from gvisor_companions import MEMBERS, ROOT, RUNSC

FILES = frozenset({RUNSC} | {ROOT + "/" + name for name in MEMBERS})
DIRECTORIES = frozenset({".", "usr", "usr/bin", ROOT})
MAX_COMPRESSED = 256 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_CONTENT = 512 * 1024 * 1024
MAX_TAR = 1024 * 1024 * 1024


def extract_synthetic(data, expected_size, expected_sha256):
    """Return a private TemporaryDirectory only after full validation.

    This accepts an immutable gzip-compressed tar byte string, not a Debian
    package. The caller owns and must clean up the returned directory. Files
    are flattened to their fixed basenames and are never made executable.
    """
    if (type(data) is not bytes or len(data) > MAX_COMPRESSED
            or len(data) != expected_size
            or hashlib.sha256(data).hexdigest() != expected_sha256):
        raise ValueError("authentication failed")

    root = tempfile.TemporaryDirectory(prefix="gvisor-inert-")
    try:
        _extract(data, Path(root.name))
        return root
    except BaseException:
        root.cleanup()
        raise


def _extract(data, root):
    seen, files, total, consumed = set(), set(), 0, 0
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as stream:
        def read_exact(size):
            nonlocal consumed
            consumed += size
            if consumed > MAX_TAR:
                raise ValueError("decompression limit exceeded")
            result = stream.read(size)
            if len(result) != size:
                raise ValueError("truncated archive")
            return result

        while True:
            header = read_exact(512)
            if header == bytes(512):
                if read_exact(512) != bytes(512):
                    raise ValueError("invalid terminator")
                break
            try:
                entry = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
            except (tarfile.HeaderError, UnicodeError) as exc:
                raise ValueError("invalid header") from exc
            name = entry.name.removeprefix("./").rstrip("/") or "."
            canonical = {name, "./" + name}
            if name == ".":
                canonical = {".", "./"}
            elif name in DIRECTORIES:
                canonical |= {name + "/", "./" + name + "/"}
            if (name in seen or name not in FILES | DIRECTORIES
                    or entry.name not in canonical
                    or any(part in ("", ".", "..") for part in name.split("/") if name != ".")):
                raise ValueError("unexpected or duplicate path")
            seen.add(name)
            if name in DIRECTORIES:
                if entry.type != tarfile.DIRTYPE or entry.size != 0:
                    raise ValueError("unexpected directory type")
                continue
            if entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or not 0 <= entry.size <= MAX_FILE:
                raise ValueError("unexpected file type or size")
            total += entry.size
            if total > MAX_CONTENT:
                raise ValueError("content limit exceeded")
            files.add(name)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            fd = os.open(root / name.rsplit("/", 1)[-1], flags, 0o600)
            with os.fdopen(fd, "wb") as output:
                left = entry.size
                while left:
                    chunk = read_exact(min(left, 1024 * 1024))
                    output.write(chunk)
                    left -= len(chunk)
            padding = (-entry.size) % 512
            if padding and any(read_exact(padding)):
                raise ValueError("invalid tar padding")
        if files != FILES:
            raise ValueError("missing files")
        while True:
            remaining = MAX_TAR - consumed
            chunk = stream.read(min(1024 * 1024, remaining + 1))
            consumed += len(chunk)
            if consumed > MAX_TAR or any(chunk):
                raise ValueError("invalid trailing data")
            if not chunk:
                break
