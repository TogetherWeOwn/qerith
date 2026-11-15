import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import bundle_bytes


class BundleBytesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.lock = self.root / "lock.json"
        self.node, self.package = b"node archive", b"package tarball"
        self.integrity = "sha512-" + base64.b64encode(hashlib.sha512(self.package).digest()).decode()
        self.lock.write_text(json.dumps({"lockfileVersion": 3, "packages": {"node_modules/a": {
            "resolved": "https://registry.npmjs.org/a/-/a-1.tgz", "integrity": self.integrity}}}))
        self.bundle = self.root / "bundle"
        self.node_pin = mock.patch.object(bundle_bytes, "NODE_SHA256", hashlib.sha256(self.node).hexdigest())
        self.node_pin.start()
        self.addCleanup(self.node_pin.stop)

    def acquire(self):
        def fake_download(url, path, algorithm, expected):
            path.write_bytes(self.node if algorithm == "sha256" else self.package)
            bundle_bytes.verify_file(path, algorithm, expected)
        with mock.patch.object(bundle_bytes, "download", side_effect=fake_download):
            bundle_bytes.acquire(self.lock, self.bundle)

    def test_acquire_verify_and_reject_changed_missing_and_extra(self):
        self.acquire()
        bundle_bytes.verify_bundle(self.lock, self.bundle)
        artifact = self.bundle / bundle_bytes.artifact_name(self.integrity)
        artifact.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            bundle_bytes.verify_bundle(self.lock, self.bundle)
        artifact.unlink()
        with self.assertRaises(ValueError):
            bundle_bytes.verify_bundle(self.lock, self.bundle)
        artifact.write_bytes(self.package)
        (self.bundle / "unexpected.tgz").write_bytes(b"unverified")
        with self.assertRaises(ValueError):
            bundle_bytes.verify_bundle(self.lock, self.bundle)

    def test_rejects_symlink_and_size_limit(self):
        self.acquire()
        artifact = self.bundle / bundle_bytes.artifact_name(self.integrity)
        artifact.unlink()
        artifact.symlink_to(self.bundle / bundle_bytes.NODE_ARCHIVE)
        with self.assertRaises(ValueError):
            bundle_bytes.verify_bundle(self.lock, self.bundle)
        with mock.patch.object(bundle_bytes, "MAX_BYTES", 1):
            with self.assertRaises(ValueError):
                bundle_bytes.verify_file(self.bundle / bundle_bytes.NODE_ARCHIVE, "sha256", bytes(32))

    def test_download_rejects_corrupt_bytes_and_removes_partial_file(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.side_effect = [b"bad", b""]
        opener = mock.Mock()
        opener.open.return_value = response
        path = self.root / "download"
        with mock.patch.object(bundle_bytes.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError):
                bundle_bytes.download(bundle_bytes.NODE_URL, path, "sha256", bytes(32))
        self.assertFalse(path.exists())

    def test_isolated_cli_loads_validator(self):
        script = pathlib.Path(bundle_bytes.__file__).resolve()
        result = subprocess.run([sys.executable, "-I", str(script), "--help"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_redirect_rejects_cross_origin(self):
        handler = bundle_bytes.SameOriginRedirects()
        req = bundle_bytes.urllib.request.Request(bundle_bytes.NODE_URL)
        with self.assertRaises(ValueError):
            handler.redirect_request(req, None, 302, "", {}, "https://example.com/file")


if __name__ == "__main__":
    unittest.main()
