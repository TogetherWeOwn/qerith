import hashlib
import os
import pathlib
import tempfile
import unittest
from unittest import mock

import sealed_output


class SealedOutputTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.output = root / "output"
        self.quarantine = root / "quarantine"
        self.output.mkdir()
        self.quarantine.mkdir()
        self.output_fd = os.open(self.output, os.O_RDONLY | os.O_DIRECTORY)
        self.quarantine_fd = os.open(self.quarantine, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, self.output_fd)
        self.addCleanup(os.close, self.quarantine_fd)
        self.device = os.fstat(self.output_fd).st_dev

    def copy(self, device=None):
        return sealed_output.copy_result(self.output_fd, self.device if device is None else device, self.quarantine_fd)

    def assert_rejected(self):
        with self.assertRaises((OSError, ValueError)):
            self.copy()
        self.assertEqual(list(self.quarantine.iterdir()), [])

    def test_copies_and_hashes(self):
        data = b"fixture bytes\x00"
        (self.output / "result.bin").write_bytes(data)
        self.assertEqual(self.copy(), {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        self.assertEqual((self.quarantine / "result.bin").read_bytes(), data)

    def test_rejects_missing_and_extra_entries(self):
        self.assert_rejected()
        (self.output / "result.bin").write_bytes(b"ok")
        (self.output / "extra").touch()
        self.assert_rejected()

    def test_rejects_symlink(self):
        (self.output / "result.bin").symlink_to("/etc/passwd")
        self.assert_rejected()

    def test_rejects_fifo_without_blocking(self):
        os.mkfifo(self.output / "result.bin")
        self.assert_rejected()

    def test_rejects_hard_link(self):
        other = pathlib.Path(self.temp.name) / "other"
        other.write_bytes(b"test")
        os.link(other, self.output / "result.bin")
        self.assert_rejected()

    def test_rejects_oversize(self):
        with (self.output / "result.bin").open("wb") as result:
            result.truncate(sealed_output.MAX_RESULT_BYTES + 1)
        self.assert_rejected()

    def test_rejects_wrong_device(self):
        (self.output / "result.bin").touch()
        with self.assertRaises(ValueError):
            self.copy(self.device + 1)
        self.assertEqual(list(self.quarantine.iterdir()), [])

    def test_does_not_replace_existing_quarantine_file(self):
        (self.output / "result.bin").write_bytes(b"new")
        existing = self.quarantine / "result.bin"
        existing.write_bytes(b"old")
        with self.assertRaises(FileExistsError):
            self.copy()
        self.assertEqual(existing.read_bytes(), b"old")

    def test_copy_error_removes_partial_file(self):
        (self.output / "result.bin").write_bytes(b"test")
        with mock.patch.object(sealed_output.os, "read", side_effect=OSError("read failed")):
            self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
