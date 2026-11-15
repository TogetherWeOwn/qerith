"""Strict parsers for already-authenticated Debian archive metadata.

These functions do not authenticate their input. Callers must verify the
InRelease signature before parsing and the index digest before decompressing.
"""

import hashlib
import lzma
import re


class InvalidMetadata(ValueError):
    pass


def verify_bytes(data, expected_size, expected_sha256):
    if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_sha256:
        raise InvalidMetadata("size or SHA-256 mismatch")


def index_entry(release, path):
    """Find exactly one SHA256 entry in authenticated Release content."""
    lines = release.decode("utf-8", "strict").replace("\r\n", "\n").split("\n")
    sections = [i for i, line in enumerate(lines) if line.rstrip(" \t") == "SHA256:"]
    if len(sections) != 1:
        raise InvalidMetadata("expected one SHA256 section")
    matches = []
    for line in lines[sections[0] + 1 :]:
        if not line.startswith((" ", "\t")):
            break
        parts = re.split(r"[ \t]+", line.strip(" \t"))
        if len(parts) != 3 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            raise InvalidMetadata("invalid SHA256 entry")
        if not parts[1].isascii() or not parts[1].isdigit():
            raise InvalidMetadata("invalid index size")
        if parts[2] == path:
            matches.append((int(parts[1]), parts[0]))
    if len(matches) != 1:
        raise InvalidMetadata("expected one index entry")
    return matches[0]


def decompress_index(data, limit):
    """Reject oversized, truncated, concatenated or trailing xz streams."""
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=128 * 1024 * 1024)
    try:
        output = decoder.decompress(data, max_length=limit + 1)
    except lzma.LZMAError as exc:
        raise InvalidMetadata("invalid xz index") from exc
    if len(output) > limit or not decoder.eof or decoder.unused_data:
        raise InvalidMetadata("oversized or incomplete xz index")
    return output


def package_entry(index, package, version, architecture):
    """Return the unique exact package record; reject ambiguous fields."""
    text = index.decode("utf-8", "strict").replace("\r\n", "\n")
    matches = []
    critical = {"package", "version", "architecture", "size", "sha256", "filename"}
    for paragraph in re.split(r"\n[ \t]*\n", text):
        fields = {}
        key = None
        for line in paragraph.split("\n"):
            if not line:
                continue
            if line[0] in " \t":
                if key is None or key in critical:
                    raise InvalidMetadata("invalid field continuation")
                continue
            if ":" not in line:
                raise InvalidMetadata("invalid package field")
            key, value = line.split(":", 1)
            key = key.lower()
            if key in fields:
                raise InvalidMetadata("duplicate package field")
            fields[key] = value.strip(" \t")
        if (fields.get("package"), fields.get("version"), fields.get("architecture")) == (
            package,
            version,
            architecture,
        ):
            matches.append(fields)
    if len(matches) != 1:
        raise InvalidMetadata("expected one package record")
    fields = matches[0]
    size, digest, filename = (fields.get(key, "") for key in ("size", "sha256", "filename"))
    if not size.isascii() or not size.isdigit() or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise InvalidMetadata("invalid package size or digest")
    if not re.fullmatch(r"pool/main/b/busybox/[A-Za-z0-9.+_~-]+\.deb", filename):
        raise InvalidMetadata("unexpected package path")
    return filename, int(size), digest
