import struct
import tarfile
import unittest
from unittest.mock import patch

import gvisor_companions as companions


def elf(machine=62, kind=2):
    data = bytearray(64)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HH", data, 16, kind, machine)
    return bytes(data)


def entry(path, data, mode=0o755, kind=tarfile.REGTYPE):
    item = tarfile.TarInfo(path)
    item.size, item.mode, item.type = len(data), mode, kind
    return item


class CompanionTests(unittest.TestCase):
    def test_records_elf_and_small_script(self):
        evidence = companions.CompanionEvidence()
        with patch("builtins.print") as output:
            for path, data in ((companions.RUNSC, elf()),
                               (companions.ROOT + "/runsc-fd-parking", b"#!/bin/sh\nexit 0\n")):
                evidence.accept(path, entry(path, data), data)
        self.assertEqual(output.call_count, 2)
        self.assertIn('"machine": "x86-64"', output.call_args_list[0].args[0])
        self.assertIn('"format": "script"', output.call_args_list[1].args[0])

    def test_rejects_unsupported_types(self):
        path = companions.RUNSC
        for data, mode, kind in ((elf(machine=183), 0o755, tarfile.REGTYPE),
                                 (elf(kind=1), 0o755, tarfile.REGTYPE),
                                 (b"unknown", 0o755, tarfile.REGTYPE),
                                 (elf(), 0o644, tarfile.REGTYPE),
                                 (elf(), 0o755, tarfile.SYMTYPE),
                                 (b"#!/bin/sh\n\xff", 0o755, tarfile.REGTYPE),
                                 (b"#!/bin/sh\n\0", 0o755, tarfile.REGTYPE)):
            with self.subTest(data=data, mode=mode, kind=kind), self.assertRaises(ValueError):
                companions.CompanionEvidence().accept(path, entry(path, data, mode, kind), data)

    def test_rejects_missing_and_unexpected_members(self):
        evidence = companions.CompanionEvidence()
        with self.assertRaises(ValueError):
            evidence.finish()
        path = companions.ROOT + "/surprise"
        with self.assertRaises(ValueError):
            evidence.accept(path, entry(path, elf()), elf())

    def test_rejects_incomplete_or_oversized_script(self):
        path = companions.RUNSC
        data = b"#!/bin/sh\n" + b"x" * 4096
        with self.assertRaises(ValueError):
            companions.CompanionEvidence().accept(path, entry(path, data), data[:4096])


if __name__ == "__main__":
    unittest.main()
