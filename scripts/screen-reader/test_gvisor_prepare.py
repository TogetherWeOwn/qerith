"""Synthetic tests for authentication ordering at the preparation boundary."""

from contextlib import ExitStack
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import gvisor_prepare as prepare


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.package = b"synthetic package"
        self.pins = {"signer": prepare.metadata.FINGERPRINT,
                     "index_sha256": prepare.metadata.INDEX_SHA256,
                     "package": prepare.metadata.PACKAGE, "size": len(self.package),
                     "sha256": hashlib.sha256(self.package).hexdigest(),
                     "sha512": hashlib.sha512(self.package).hexdigest()}

    def patched_pins(self, pins):
        stack = ExitStack()
        stack.enter_context(patch.object(prepare.inventory, "SIZE", pins["size"]))
        stack.enter_context(patch.object(prepare.metadata, "SHA256", pins["sha256"]))
        stack.enter_context(patch.object(prepare.metadata, "SHA512", pins["sha512"]))
        return stack

    def test_authentication_failure_precedes_archive_parsing(self):
        bad_sha512 = dict(self.pins, sha512="0" * 128)
        cases = [(self.package, {}, self.pins),
                 (self.package, dict(self.pins, signer="wrong"), self.pins),
                 (bytearray(self.package), self.pins, self.pins),
                 (self.package[:-1], self.pins, self.pins),
                 (self.package + b"x", self.pins, self.pins),
                 (b"X" + self.package[1:], self.pins, self.pins),
                 (self.package, bad_sha512, bad_sha512)]
        for candidate, pins, constants in cases:
            with self.subTest(candidate=candidate, pins=pins):
                with (self.patched_pins(constants),
                      patch.object(prepare.inventory, "ar_members") as parse,
                      patch.object(prepare.extract, "extract_compatible_synthetic") as extract):
                    with self.assertRaises(ValueError):
                        prepare.prepare_bytes(candidate, pins)
                    parse.assert_not_called()
                    extract.assert_not_called()

    def test_authenticated_slice_is_passed_unchanged(self):
        data = b"synthetic archive"
        package = b"prefix" + data
        pins = dict(self.pins, size=len(package), sha256=hashlib.sha256(package).hexdigest(),
                    sha512=hashlib.sha512(package).hexdigest())
        with (self.patched_pins(pins),
              patch.object(prepare.inventory, "ar_members", return_value=[None, None,
                           ("data.tar.gz", 6, len(data))]),
              patch.object(prepare.extract, "extract_compatible_synthetic", return_value="root") as extract):
            self.assertEqual(prepare.prepare_bytes(package, pins), "root")
            extract.assert_called_once_with(data, len(data), hashlib.sha256(data).hexdigest())

    def test_invalid_archive_handoff_never_extracts(self):
        cases = [[None, None, ("wrong", 0, 1)],
                 [None, None, ("data.tar.gz", 0, prepare.extract.MAX_COMPRESSED + 1)],
                 [None, None, ("data.tar.gz", len(self.package), 1)],
                 ValueError("bad ar")]
        for result in cases:
            with self.subTest(result=result), self.patched_pins(self.pins):
                with (patch.object(prepare.inventory, "ar_members") as parse,
                      patch.object(prepare.extract, "extract_compatible_synthetic") as extract):
                    if isinstance(result, Exception):
                        parse.side_effect = result
                    else:
                        parse.return_value = result
                    with self.assertRaises(ValueError):
                        prepare.prepare_bytes(self.package, self.pins)
                    extract.assert_not_called()

    def test_non_actions_entrypoint_rejects_before_network(self):
        with (patch.dict(prepare.os.environ, {"GITHUB_ACTIONS": "false"}),
              patch.object(prepare.metadata, "verify_metadata") as verify):
            with self.assertRaises(RuntimeError):
                prepare.main()
            verify.assert_not_called()

    def test_main_order_and_cleanup(self):
        for outcome in ("metadata", "authentication", "extraction", "success"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as parent:
                acquisition_roots = []
                prepared_roots = []

                def verify(root):
                    acquisition_roots.append(root)
                    if outcome == "metadata":
                        raise ValueError("metadata")
                    return pins

                def download(path):
                    path.write_bytes(self.package)

                def extract(data, size, digest):
                    if outcome == "extraction":
                        raise ValueError("extraction")
                    root = tempfile.TemporaryDirectory(dir=parent)
                    prepared_roots.append(Path(root.name))
                    return root

                members = [None, None, ("data.tar.gz", 0, len(self.package))]
                pins = dict(self.pins, sha512="0" * 128) if outcome == "authentication" else self.pins
                with (patch.dict(prepare.os.environ, {"GITHUB_ACTIONS": "true", "TMPDIR": parent}),
                      self.patched_pins(pins),
                      patch.object(prepare.metadata, "verify_metadata", side_effect=verify),
                      patch.object(prepare.inventory, "download", side_effect=download) as get,
                      patch.object(prepare.inventory, "ar_members", return_value=members),
                      patch.object(prepare.extract, "extract_compatible_synthetic", side_effect=extract) as do_extract):
                    if outcome == "success":
                        prepare.main()
                    else:
                        with self.assertRaises(ValueError):
                            prepare.main()
                    if outcome == "metadata":
                        get.assert_not_called()
                    if outcome in ("metadata", "authentication"):
                        do_extract.assert_not_called()
                self.assertTrue(acquisition_roots)
                self.assertTrue(all(not p.exists() for p in acquisition_roots + prepared_roots))
                if outcome == "success":
                    self.assertTrue(prepared_roots)


if __name__ == "__main__":
    unittest.main()
