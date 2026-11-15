"""Inspect an authenticated BusyBox Debian package without executing its contents.

The caller must authenticate the complete package before invoking these helpers.
The selected binary is returned in memory; no archive paths are extracted to disk.
"""

import re
import struct
import tarfile

from debian_metadata import decompress_index

MAX_DEB = 4 * 1024 * 1024
MAX_TAR = 16 * 1024 * 1024
MAX_BINARY = 8 * 1024 * 1024


def data_archive(deb):
    """Read the exact expected ar members and decompress the bounded data tar."""
    if len(deb) > MAX_DEB or not deb.startswith(b"!<arch>\n"):
        raise ValueError("invalid or oversized deb archive")
    offset, members = 8, {}
    while offset < len(deb):
        header = deb[offset : offset + 60]
        if len(header) != 60 or header[58:] != b"`\n":
            raise ValueError("invalid ar header")
        try:
            name = header[:16].decode("ascii").strip().removesuffix("/")
            raw_size = header[48:58].decode("ascii").strip()
            if not re.fullmatch(r"[0-9]+", raw_size):
                raise ValueError("invalid ar size")
            size = int(raw_size)
        except UnicodeDecodeError as exc:
            raise ValueError("invalid ar header encoding") from exc
        start, end = offset + 60, offset + 60 + size
        if end > len(deb) or name in members:
            raise ValueError("invalid ar member")
        if size % 2 and (end >= len(deb) or deb[end : end + 1] != b"\n"):
            raise ValueError("invalid ar padding")
        members[name] = deb[start:end]
        offset = end + size % 2
    if set(members) != {"debian-binary", "control.tar.xz", "data.tar.xz"}:
        raise ValueError("unexpected deb members")
    if members["debian-binary"] != b"2.0\n":
        raise ValueError("unsupported deb format")
    return decompress_index(members["data.tar.xz"], MAX_TAR)


DIRECTORIES = frozenset((
    ".", "bin", "usr", "usr/share", "usr/share/doc", "usr/share/doc/busybox-static",
    "usr/share/doc/busybox-static/examples", "usr/share/doc/busybox-static/examples/udhcp",
    "usr/share/man", "usr/share/man/man1", "usr/share/initramfs-tools",
    "usr/share/initramfs-tools/conf-hooks.d", "usr/share/initramfs-tools/hooks",
    "usr/share/lintian", "usr/share/lintian/overrides",
))
PACKAGE_FILES = frozenset((
    "usr/share/initramfs-tools/conf-hooks.d/busybox",
    "usr/share/initramfs-tools/hooks/zz-busybox",
    "usr/share/lintian/overrides/busybox-static",
))


def binary_from_tar(data):
    """Accept only known package entries and return exactly one regular binary."""
    if len(data) > MAX_TAR:
        raise ValueError("oversized data tar")
    binary, seen, offset = None, set(), 0
    while True:
        header = data[offset : offset + 512]
        if len(header) != 512:
            raise ValueError("truncated tar header")
        if header == bytes(512):
            if len(data) - offset < 1024 or any(data[offset:]):
                raise ValueError("invalid tar termination")
            break
        try:
            member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
        except (tarfile.HeaderError, UnicodeError) as exc:
            raise ValueError("invalid tar header") from exc
        start = offset + 512
        end = start + member.size
        offset = start + ((member.size + 511) // 512) * 512
        if member.size < 0 or offset > len(data):
            raise ValueError("truncated tar entry")
        name = member.name.removeprefix("./").rstrip("/") or "."
        parts = name.split("/")
        if (name.startswith("/") or any(p in ("", ".", "..") for p in parts)
                and name != "." or name in seen):
            raise ValueError("unsafe or duplicate tar entry")
        seen.add(name)
        if name in DIRECTORIES and member.isdir() and member.size == 0:
            continue
        if name == "bin/busybox" and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and 0 < member.size <= MAX_BINARY:
            binary = data[start:end]
            continue
        if (member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and member.size <= 2 * 1024 * 1024 and
                (name in PACKAGE_FILES or name.startswith((
                    "usr/share/doc/busybox-static/", "usr/share/man/man1/")))):
            continue
        raise ValueError("unexpected tar entry")
    if binary is None:
        raise ValueError("missing BusyBox binary")
    return binary


def verify_static_amd64(data):
    """Validate a static little-endian amd64 executable without executing it."""
    if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
        raise ValueError("not little-endian ELF64")
    kind, machine, version = struct.unpack_from("<HHI", data, 16)
    entry, phoff = struct.unpack_from("<QQ", data, 24)
    ehsize, phentsize, phnum = struct.unpack_from("<HHH", data, 52)
    if (kind != 2 or machine != 62 or version != 1 or ehsize != 64 or phentsize != 56
            or not 0 < phnum <= 128 or phoff < 64 or phoff + phentsize * phnum > len(data)):
        raise ValueError("unexpected ELF header")
    executable_entry = False
    load_pages = []
    for index in range(phnum):
        pos = phoff + index * phentsize
        segment_type, flags = struct.unpack_from("<II", data, pos)
        if segment_type in (2, 3):
            raise ValueError("ELF has dynamic segment or interpreter")
        if segment_type == 1:
            offset, vaddr = struct.unpack_from("<QQ", data, pos + 8)
            filesz, memsz, align = struct.unpack_from("<QQQ", data, pos + 32)
            if ((vaddr - offset) % 4096 or
                    align > 1 and (align & (align - 1) or (vaddr - offset) % align)):
                raise ValueError("invalid ELF load alignment")
            if filesz > memsz or offset + filesz > len(data) or vaddr + memsz > 2**64:
                raise ValueError("invalid ELF load segment")
            if memsz:
                page_start = vaddr // 4096
                page_end = (vaddr + memsz + 4095) // 4096
                if any(page_start < end and start < page_end for start, end in load_pages):
                    raise ValueError("overlapping ELF load pages")
                load_pages.append((page_start, page_end))
            if flags & 1 and vaddr <= entry < vaddr + filesz:
                executable_entry = True
    if not executable_entry:
        raise ValueError("ELF entry is not in an executable file-backed segment")
