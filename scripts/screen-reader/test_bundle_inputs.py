import base64
import hashlib
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import bundle_inputs


class LockedArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lock = pathlib.Path(self.temp.name) / "package-lock.json"
        self.entry = {
            "resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
            "integrity": "sha512-" + base64.b64encode(bytes(64)).decode(),
        }

    def write(self, packages):
        self.lock.write_text(json.dumps({"lockfileVersion": 3, "packages": packages}))

    def test_accepts_and_deduplicates_locked_registry_artifacts(self):
        self.write({"": {}, "node_modules/a": self.entry, "node_modules/b": self.entry})
        self.assertEqual(bundle_inputs.locked_artifacts(self.lock),
                         {self.entry["resolved"]: self.entry["integrity"]})

    def test_rejects_missing_or_untrusted_provenance(self):
        for changes in ({"resolved": "https://registry.npmjs.org.evil/a.tgz"},
                        {"resolved": "https://registry.npmjs.org/a.tgz?x=1"},
                        {"integrity": "sha512-!!!!"}, {"integrity": "sha512-YQ=="},
                        {"integrity": None}, {"resolved": None}):
            with self.subTest(changes=changes):
                self.write({"": {}, "node_modules/a": {**self.entry, **changes}})
                with self.assertRaises(ValueError):
                    bundle_inputs.locked_artifacts(self.lock)

    def test_rejects_conflicting_duplicate(self):
        other = {**self.entry, "integrity": "sha512-" + base64.b64encode(bytes([1]) * 64).decode()}
        self.write({"": {}, "node_modules/a": self.entry, "node_modules/b": other})
        with self.assertRaises(ValueError):
            bundle_inputs.locked_artifacts(self.lock)

    def test_file_verification_rejects_tampering_and_missing_inputs(self):
        artifact = pathlib.Path(self.temp.name) / "artifact"
        artifact.write_bytes(b"expected")
        expected = hashlib.sha512(b"expected").digest()
        bundle_inputs.verify_file(artifact, "sha512", expected)
        artifact.write_bytes(b"tampered")
        with self.assertRaises(ValueError):
            bundle_inputs.verify_file(artifact, "sha512", expected)
        artifact.unlink()
        with self.assertRaises(FileNotFoundError):
            bundle_inputs.verify_file(artifact, "sha512", expected)

    def test_acquire_then_verify_offline_and_reject_tampering(self):
        node, package = b"node archive", b"package tarball"
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(package).digest()).decode()
        self.write({"": {}, "node_modules/a": {**self.entry, "integrity": integrity}})
        bundle = pathlib.Path(self.temp.name) / "bundle"

        def fake_download(url, path, algorithm, expected):
            pathlib.Path(path).write_bytes(node if algorithm == "sha256" else package)
            bundle_inputs.verify_file(path, algorithm, expected)

        with mock.patch.object(bundle_inputs, "NODE_SHA256", hashlib.sha256(node).hexdigest()), \
             mock.patch.object(bundle_inputs, "download", side_effect=fake_download):
            bundle_inputs.acquire(self.lock, bundle)
            bundle_inputs.verify_bundle(self.lock, bundle)
            (bundle / bundle_inputs.artifact_name(integrity)).write_bytes(b"changed")
            with self.assertRaises(ValueError):
                bundle_inputs.verify_bundle(self.lock, bundle)

    def test_bundle_rejects_missing_node_archive(self):
        self.write({"": {}, "node_modules/a": self.entry})
        with self.assertRaises(FileNotFoundError):
            bundle_inputs.verify_bundle(self.lock, self.temp.name)

    def test_repository_lock_has_artifacts(self):
        repo = pathlib.Path(__file__).resolve().parents[2]
        self.assertTrue(bundle_inputs.locked_artifacts(repo / "apps/drive/package-lock.json"))


if __name__ == "__main__":
    unittest.main()
