"""Synthetic, inert extraction primitive; not an admission path for packages.

The caller must independently authorize the exact digest and size before any
real artifact is admitted. This module does not provide such authorization.
"""

from contextlib import nullcontext
import hashlib
import os
from pathlib import Path
import tarfile
import tempfile
import zlib

from gvisor_companions import MEMBERS, ROOT, RUNSC

FILES = frozenset({RUNSC} | {ROOT + "/" + name for name in MEMBERS})
DIRECTORIES = frozenset({".", "usr", "usr/bin", ROOT})
MAX_COMPRESSED = 256 * 1024 * 1024
MAX_FILE = 256 * 1024 * 1024
MAX_CONTENT = 512 * 1024 * 1024
MAX_TAR = 1024 * 1024 * 1024


# Diagnostic inventory is a compatibility target, not artifact authorization.
COMPAT_FILES = {
    "usr/bin/containerd-shim-runsc-v1": 43626680,
    RUNSC: 109966750,
    ROOT + "/checkpointgofer": 69128994,
    ROOT + "/gvisor-sentry-prewarmer": 1416,
    ROOT + "/gvisor_sentry": 52149808,
    ROOT + "/runsc-fd-parking": 1320,
    ROOT + "/runsc-metric-server": 53222722,
    "etc/containerd/runsc.toml": 302,
}
COMPAT_DIRECTORIES = frozenset({"usr", "usr/bin", ROOT, "etc", "etc/containerd"})
COMPAT_NAME = b"debian-data.tar"


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


def extract_compatible_synthetic(data, expected_size, expected_sha256):
    """Qualify only synthetic bytes against the observed framing and inventory.

    This is not package authentication or authorization. Non-output entries
    are validated and discarded; no source modes or paths are materialized.
    """
    if (type(data) is not bytes or len(data) > MAX_COMPRESSED
            or len(data) != expected_size
            or hashlib.sha256(data).hexdigest() != expected_sha256):
        raise ValueError("authentication failed")
    root = tempfile.TemporaryDirectory(prefix="gvisor-inert-")
    try:
        _extract(data, Path(root.name), compatible=True)
        return root
    except BaseException:
        root.cleanup()
        raise


class _SingleGzip:
    """One gzip member with strict optional filename and no trailing bytes."""

    def __init__(self, data, compatible=False):
        if len(data) < 10 or data[:3] != b"\x1f\x8b\x08":
            raise ValueError("unsupported gzip header")
        if compatible:
            if data[3] != 8 or not data.startswith(COMPAT_NAME + b"\0", 10):
                raise ValueError("unsupported gzip filename")
        elif data[3] != 0:
            raise ValueError("unsupported gzip header")
        self.data = data
        self.offset = 0
        self.pending = b""
        self.decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)

    def read(self, size):
        result = bytearray()
        while len(result) < size and not self.decoder.eof:
            if not self.pending:
                self.pending = self.data[self.offset:self.offset + 65536]
                self.offset += len(self.pending)
                if not self.pending:
                    raise ValueError("truncated gzip stream")
            try:
                result.extend(self.decoder.decompress(self.pending, size - len(result)))
            except zlib.error as exc:
                raise ValueError("invalid gzip stream") from exc
            self.pending = self.decoder.unconsumed_tail
            if self.decoder.eof and (self.decoder.unused_data or self.pending or self.offset != len(self.data)):
                raise ValueError("trailing or concatenated gzip data")
        return bytes(result)


def _extract(data, root, compatible=False):
    seen, files, total, consumed = set(), set(), 0, 0
    allowed_files = frozenset(COMPAT_FILES) if compatible else FILES
    allowed_directories = COMPAT_DIRECTORIES if compatible else DIRECTORIES
    with nullcontext(_SingleGzip(data, compatible=compatible)) as stream:
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
            elif name in allowed_directories:
                canonical |= {name + "/", "./" + name + "/"}
            if (name in seen or name not in allowed_files | allowed_directories
                    or entry.name not in canonical
                    or any(part in ("", ".", "..") for part in name.split("/") if name != ".")):
                raise ValueError("unexpected or duplicate path")
            seen.add(name)
            if name in allowed_directories:
                if entry.type != tarfile.DIRTYPE or entry.size != 0:
                    raise ValueError("unexpected directory type")
                continue
            if compatible and entry.size != COMPAT_FILES[name]:
                raise ValueError("unexpected file size")
            if entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or not 0 <= entry.size <= MAX_FILE:
                raise ValueError("unexpected file type or size")
            total += entry.size
            if total > MAX_CONTENT:
                raise ValueError("content limit exceeded")
            files.add(name)
            if name in FILES:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                fd = os.open(root / name.rsplit("/", 1)[-1], flags, 0o600)
                output_context = os.fdopen(fd, "wb")
            else:
                output_context = nullcontext(None)
            with output_context as output:
                left = entry.size
                while left:
                    chunk = read_exact(min(left, 1024 * 1024))
                    if output is not None:
                        output.write(chunk)
                    left -= len(chunk)
            padding = (-entry.size) % 512
            if padding and any(read_exact(padding)):
                raise ValueError("invalid tar padding")
        if files != allowed_files or (compatible and seen != allowed_files | allowed_directories):
            raise ValueError("missing entries")
        while True:
            remaining = MAX_TAR - consumed
            chunk = stream.read(min(1024 * 1024, remaining + 1))
            consumed += len(chunk)
            if consumed > MAX_TAR or any(chunk):
                raise ValueError("invalid trailing data")
            if not chunk:
                break
        if compatible and consumed % 512:
            raise ValueError("partial tar trailing block")
