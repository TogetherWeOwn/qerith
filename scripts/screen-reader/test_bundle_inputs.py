import base64
import json
import pathlib
import tempfile
import unittest

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
                        {"resolved": "https://registry.npmjs.org/a.tgz#x"},
                        {"resolved": "http://registry.npmjs.org/a.tgz"},
                        {"resolved": "https://registry.npmjs.org/a\n.tgz"},
                        {"resolved": "https://registry.npmjs.org/x/../a.tgz"},
                        {"resolved": "https://registry.npmjs.org/%2e%2e/a.tgz"},
                        {"resolved": "https://registry.npmjs.org//a.tgz"},
                        {"integrity": "sha512-!!!!"}, {"integrity": "sha512-YQ=="},
                        {"integrity": "sha256-" + base64.b64encode(bytes(32)).decode()},
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

    def test_rejects_unsupported_structure_and_empty_set(self):
        for lock in ([], {"lockfileVersion": 2, "packages": {}},
                     {"lockfileVersion": 3, "packages": {}},
                     {"lockfileVersion": 3, "packages": {"local": self.entry}},
                     {"lockfileVersion": 3, "packages": {"node_modules/a": None}}):
            with self.subTest(lock=lock):
                self.lock.write_text(json.dumps(lock))
                with self.assertRaises(ValueError):
                    bundle_inputs.locked_artifacts(self.lock)

    def test_rejects_duplicate_json_keys(self):
        for document in ('{"lockfileVersion": 3, "lockfileVersion": 2, "packages": {}}',
                         '{"lockfileVersion": 3, "packages": {"node_modules/a": '
                         '{"resolved": "a", "resolved": "b"}}}'):
            with self.subTest(document=document):
                self.lock.write_text(document)
                with self.assertRaisesRegex(ValueError, "duplicate lockfile key"):
                    bundle_inputs.locked_artifacts(self.lock)

    def test_repository_lock_has_artifacts(self):
        repo = pathlib.Path(__file__).resolve().parents[2]
        self.assertTrue(bundle_inputs.locked_artifacts(repo / "apps/drive/package-lock.json"))


if __name__ == "__main__":
    unittest.main()
