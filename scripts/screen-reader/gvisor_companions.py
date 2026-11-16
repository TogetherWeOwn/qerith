"""Collect bounded, inert evidence about members of the authenticated package.

This probe does not establish runtime suitability or companion completeness.
"""

import json
import struct
import tarfile

ROOT = "usr/bin/gvisor-bin"
RUNSC = "usr/bin/runsc"
MEMBERS = {"checkpointgofer", "gvisor-sentry-prewarmer", "gvisor_sentry",
           "runsc-fd-parking", "runsc-metric-server"}


class CompanionEvidence:
    def __init__(self):
        self.seen = set()

    def wants(self, path):
        return path == RUNSC or path == ROOT or path.startswith(ROOT + "/")

    def accept(self, path, entry, prefix):
        self.seen.add(path)
        if path == ROOT:
            if entry.type != tarfile.DIRTYPE:
                raise ValueError("companion directory is not a directory")
            print(json.dumps({"path": path, "mode": oct(entry.mode)}))
            return
        if path != RUNSC and path.removeprefix(ROOT + "/") not in MEMBERS:
            raise ValueError("unexpected companion")
        if entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or not entry.mode & 0o111:
            raise ValueError("companion is not an executable regular file")
        result = {"path": path, "mode": oct(entry.mode), "size": entry.size}
        if prefix.startswith(b"\x7fELF"):
            if len(prefix) < 64 or prefix[4:7] != b"\x02\x01\x01":
                raise ValueError("unsupported ELF encoding")
            kind, machine = struct.unpack_from("<HH", prefix, 16)
            if machine != 62 or kind not in (2, 3):
                raise ValueError("unsupported ELF architecture or type")
            result.update(format="ELF64 little-endian", machine="x86-64", elf_type=kind)
        elif prefix.startswith(b"#!"):
            if entry.size > 4096 or len(prefix) != entry.size or b"\0" in prefix:
                raise ValueError("unsupported script")
            try:
                result.update(format="script", text=prefix.decode("utf-8", "strict"))
            except UnicodeDecodeError as exc:
                raise ValueError("unsupported script encoding") from exc
        else:
            raise ValueError("unsupported companion format")
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))

    def finish(self):
        if self.seen != {RUNSC, ROOT} | {ROOT + "/" + member for member in MEMBERS}:
            raise ValueError("missing companion")
