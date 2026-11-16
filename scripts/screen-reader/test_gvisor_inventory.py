import gzip
import io
import lzma
import tarfile
import unittest
from pathlib import Path
from unittest.mock import patch

import gvisor_inventory as inventory


def archive(name="./file", kind=tarfile.REGTYPE, link=""):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.linkname = link
        tar.addfile(entry)
    return gzip.compress(output.getvalue())


class InventoryTests(unittest.TestCase):
    def test_metadata_failure_prevents_download(self):
        with patch.object(inventory.metadata, "verify_metadata", side_effect=ValueError), \
                patch.object(inventory, "download") as download:
            with self.assertRaises(ValueError):
                inventory.run(Path("unused"))
            download.assert_not_called()

    def test_authentication_failure_prevents_archive_open(self):
        with patch.object(inventory.metadata, "verify_metadata", return_value={}), \
                patch.object(inventory, "download"), \
                patch.object(inventory, "authenticate", side_effect=ValueError), \
                patch.object(Path, "open") as opened:
            with self.assertRaises(ValueError):
                inventory.run(Path("unused"))
            opened.assert_not_called()

    def test_bad_digest_and_size_rejected(self):
        with patch.object(Path, "open", return_value=io.BytesIO(b"bad")), \
                patch.object(inventory, "SIZE", 3):
            pins = {"signer": inventory.metadata.FINGERPRINT, "index_sha256": inventory.metadata.INDEX_SHA256,
                    "package": inventory.metadata.PACKAGE, "size": 3,
                    "sha256": inventory.metadata.SHA256, "sha512": inventory.metadata.SHA512}
            with self.assertRaises(ValueError):
                inventory.authenticate(Path("unused"), pins)

    def test_untrusted_paths_and_types(self):
        for name, kind, link in (("../escape", tarfile.REGTYPE, ""),
                                 ("/absolute", tarfile.REGTYPE, ""),
                                 ("safe", tarfile.SYMTYPE, "../escape"),
                                 ("safe", tarfile.CHRTYPE, "")):
            data = archive(name, kind, link)
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                inventory.inventory_tar(io.BytesIO(data), ("data.tar.gz", 0, len(data)))

    def test_inventory_and_decompression_limit(self):
        data = archive()
        with patch("builtins.print") as log:
            inventory.inventory_tar(io.BytesIO(data), ("data.tar.gz", 0, len(data)))
            self.assertEqual(log.call_count, 1)
        with patch.object(inventory, "MAX_TAR", 1024), self.assertRaises(ValueError):
            inventory.inventory_tar(io.BytesIO(data), ("data.tar.gz", 0, len(data)))

    def test_xz_rejects_trailing_data(self):
        data = lzma.compress(gzip.decompress(archive()))
        with patch("builtins.print"):
            inventory.inventory_tar(io.BytesIO(data), ("data.tar.xz", 0, len(data)))
            with self.assertRaises(ValueError):
                inventory.inventory_tar(io.BytesIO(data + b"garbage"), ("data.tar.xz", 0, len(data) + 7))

    def test_safe_relative_symlink(self):
        data = archive("usr/bin/tool", tarfile.SYMTYPE, "../lib/tool")
        with patch("builtins.print"):
            inventory.inventory_tar(io.BytesIO(data), ("data.tar.gz", 0, len(data)))

    def test_invalid_ar_rejected(self):
        data = b"!<arch>\n" + b"x" * 60
        with patch.object(inventory, "SIZE", len(data)), self.assertRaises(ValueError):
            inventory.ar_members(io.BytesIO(data))


if __name__ == "__main__":
    unittest.main()
