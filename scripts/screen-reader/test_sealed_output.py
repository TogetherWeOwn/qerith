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

    def test_stops_enumerating_after_second_entry(self):
        class Entries:
            def __enter__(self):
                def iterate():
                    yield type("Entry", (), {"name": "result.bin"})()
                    yield type("Entry", (), {"name": "extra"})()
                    raise AssertionError("enumerated beyond second entry")
                return iterate()

            def __exit__(self, *args):
                pass

        with mock.patch.object(sealed_output.os, "scandir", return_value=Entries()), \
                mock.patch.object(sealed_output.os, "listdir", side_effect=AssertionError("unbounded listing")):
            with self.assertRaises(ValueError):
                self.copy()
        self.assertEqual(list(self.quarantine.iterdir()), [])

    def test_scans_from_start_after_caller_enumeration(self):
        (self.output / "result.bin").write_bytes(b"ok")
        with os.scandir(self.output_fd) as entries:
            list(entries)
        self.assertEqual(self.copy()["bytes"], 2)

    def test_rejects_symlink(self):
        (self.output / "result.bin").symlink_to("/etc/passwd")
        self.assert_rejected()

    def test_rejects_fifo_without_blocking(self):
        os.mkfifo(self.output / "result.bin")
        with mock.patch.object(sealed_output.os, "open", wraps=os.open) as open_file:
            self.assert_rejected()
            self.assertNotIn("result.bin", [call.args[0] for call in open_file.call_args_list])

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

    def test_source_close_error_removes_copy(self):
        (self.output / "result.bin").write_bytes(b"test")
        real_close = os.close
        real_open = os.open
        source_fds = set()

        def track_open(path, flags, *args, **kwargs):
            fd = real_open(path, flags, *args, **kwargs)
            if path == "result.bin" and not flags & os.O_CREAT:
                source_fds.add(fd)
            return fd

        def fail_close(fd):
            real_close(fd)
            if fd in source_fds:
                raise OSError("close failed")

        with mock.patch.object(sealed_output.os, "open", side_effect=track_open), \
                mock.patch.object(sealed_output.os, "close", side_effect=fail_close):
            self.assert_rejected()

    def test_copy_error_removes_partial_file(self):
        (self.output / "result.bin").write_bytes(b"test")
        with mock.patch.object(sealed_output.os, "read", side_effect=OSError("read failed")):
            self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
