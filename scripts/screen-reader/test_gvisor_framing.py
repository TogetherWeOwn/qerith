import gzip
import io
import tarfile
import unittest
from pathlib import Path
from unittest.mock import patch

import gvisor_framing as framing


def archive(name="./usr/bin/runsc", payload=b"payload"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        entry = tarfile.TarInfo(name)
        entry.size = len(payload)
        tar.addfile(entry, io.BytesIO(payload))
    return output.getvalue()


class FramingTests(unittest.TestCase):
    def test_complete_inventory(self):
        records, size = framing.inspect(gzip.compress(archive(), mtime=0))
        self.assertEqual(records, [{"path": "usr/bin/runsc", "raw_path": "./usr/bin/runsc",
                                    "type": "file", "size": 7, "link": None}])
        self.assertEqual(size, len(archive()))

    def test_rejects_gzip_flags_members_trailing_and_truncation(self):
        valid = gzip.compress(archive(), mtime=0)
        flagged = bytearray(valid)
        flagged[3] = 1
        for data in (bytes(flagged), valid + valid, valid + b"x", valid[:-1]):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                framing.inspect(data)

    def test_rejects_tar_padding_termination_and_unsafe_path(self):
        valid = archive()
        bad_padding = bytearray(valid)
        bad_padding[519] = 1
        for data in (bytes(bad_padding), valid[:1024], valid + b"x", archive("../escape")):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                framing.inspect(gzip.compress(data, mtime=0))

    def test_caps_and_duplicate_paths(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w") as tar:
            for _ in range(2):
                tar.addfile(tarfile.TarInfo("same"))
        with self.assertRaises(ValueError):
            framing.inspect(gzip.compress(output.getvalue(), mtime=0))
        with patch.object(framing, "MAX_TAR", 512), self.assertRaises(ValueError):
            framing.inspect(gzip.compress(archive(), mtime=0))
        with patch.object(framing, "MAX_COMPRESSED", 1), self.assertRaises(ValueError):
            framing.inspect(gzip.compress(archive(), mtime=0))

    def test_metadata_or_package_failure_prevents_parsing(self):
        with patch.object(framing.metadata, "verify_metadata", side_effect=ValueError("metadata")), \
             patch.object(framing.inventory, "download") as download:
            with self.assertRaises(ValueError):
                framing.run(Path("."))
            download.assert_not_called()
        with patch.object(framing.metadata, "verify_metadata", return_value={}), \
             patch.object(framing.inventory, "download"), \
             patch.object(framing.inventory, "authenticate", side_effect=ValueError("package")), \
             patch.object(framing.inventory, "ar_members") as parse:
            with self.assertRaises(ValueError):
                framing.run(Path("."))
            parse.assert_not_called()


if __name__ == "__main__":
    unittest.main()
