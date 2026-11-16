import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import qualify_busybox as q


class QualificationTests(unittest.TestCase):
    def test_authenticated_chain_orders_verification_before_parsing(self):
        calls = []

        def fetch(url, path, maximum):
            calls.append("fetch")
            return b"index" if "Packages.xz" in url else b"package"

        def verify(data, size, sha):
            calls.append("verify " + data.decode())

        with tempfile.TemporaryDirectory() as root, \
             patch.object(q, "verified_release", return_value=(b"release", "release-digest")), \
             patch.object(q, "index_entry", return_value=(5, "index-digest")), \
             patch.object(q, "fetch", side_effect=fetch), \
             patch.object(q, "verify_bytes", side_effect=verify), \
             patch.object(q, "decompress_index", side_effect=lambda data, limit: calls.append("decompress") or b"parsed"), \
             patch.object(q, "package_entry", return_value=(q.PACKAGE, 7, "package-digest")), \
             patch.object(q, "data_archive", side_effect=lambda data: calls.append("archive") or b"tar"), \
             patch.object(q, "binary_from_tar", return_value=b"binary"), \
             patch.object(q, "verify_static_amd64", side_effect=lambda data: calls.append("elf")):
            result = q.qualify(Path(root))
        self.assertEqual(calls, ["fetch", "verify index", "decompress", "fetch", "verify package", "archive", "elf"])
        self.assertEqual(result["binary_sha256"], q.digest(b"binary"))

    def test_failed_signature_prevents_index_read(self):
        with patch.object(q, "verified_release", side_effect=ValueError("bad signature")), \
             patch.object(q, "index_entry") as index:
            with self.assertRaises(ValueError):
                q.qualify(Path("unused"))
            index.assert_not_called()

    def test_bad_package_stops_archive_parsing(self):
        with patch.object(q, "verified_release", return_value=(b"release", "digest")), \
             patch.object(q, "index_entry", return_value=(5, "digest")), \
             patch.object(q, "fetch", side_effect=[b"index", b"package"]), \
             patch.object(q, "verify_bytes", side_effect=[None, ValueError("mismatch")]), \
             patch.object(q, "decompress_index", return_value=b"index"), \
             patch.object(q, "package_entry", return_value=(q.PACKAGE, 7, "digest")), \
             patch.object(q, "data_archive") as archive:
            with self.assertRaises(ValueError):
                q.qualify(Path("unused"))
            archive.assert_not_called()

    def test_main_rejects_changed_lock_and_non_actions(self):
        with patch.dict("os.environ", {"GITHUB_ACTIONS": "false"}):
            with self.assertRaises(RuntimeError):
                q.main()
        with patch.dict("os.environ", {"GITHUB_ACTIONS": "true"}), \
             patch.object(q, "qualify", return_value={"unexpected": True}):
            with self.assertRaises(ValueError):
                q.main()
        lock = json.loads(q.LOCK.read_text())
        self.assertEqual(lock["primary_fingerprint"], q.PRIMARY)
        self.assertEqual(lock["signer_fingerprint"], q.SIGNER)


if __name__ == "__main__":
    unittest.main()
