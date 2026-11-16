import unittest
from pathlib import Path
from unittest.mock import patch

import gvisor_metadata as metadata


class MetadataTests(unittest.TestCase):
    def test_wrong_key_and_multiple_keys_rejected(self):
        for text in ("pub:::::::::\nfpr:::::::::BAD:",
                     "pub:::::::::\npub:::::::::\nfpr:::::::::" + metadata.FINGERPRINT + ":"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                metadata.check_key(text)

    def test_untrusted_or_ambiguous_signature_rejected(self):
        valid = ("[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG " + metadata.FINGERPRINT
                 + " 2026-10-05 1 0 4 0 1 10 01 " + metadata.FINGERPRINT)
        metadata.check_signature(0, valid)
        for code, status in ((1, valid), (0, valid.replace(metadata.FINGERPRINT, "BAD")),
                             (0, valid + "\n[GNUPG:] BADSIG bad"), (0, valid + "\n" + valid)):
            with self.subTest(status=status), self.assertRaises(ValueError):
                metadata.check_signature(code, status)

    def test_unverified_release_never_fetches_index(self):
        with patch.object(metadata, "verified_release", side_effect=ValueError("bad signature")), \
                patch.object(metadata, "fetch") as fetch:
            with self.assertRaises(ValueError):
                metadata.verify_metadata(Path("unused"))
            fetch.assert_not_called()

    def test_wrong_signed_index_pin_never_fetches_index(self):
        with patch.object(metadata, "verified_release", return_value=b"authenticated"), \
                patch.object(metadata, "index_entry", return_value=(598, "bad")), \
                patch.object(metadata, "fetch") as fetch:
            with self.assertRaises(ValueError):
                metadata.verify_metadata(Path("unused"))
            fetch.assert_not_called()

    def test_bad_index_never_parses_package(self):
        with patch.object(metadata, "verified_release", return_value=b"authenticated"), \
                patch.object(metadata, "index_entry", return_value=(598, metadata.INDEX_SHA256)), \
                patch.object(metadata, "fetch", return_value=b"tampered"), \
                patch.object(metadata, "check_package") as check:
            with self.assertRaises(ValueError):
                metadata.verify_metadata(Path("unused"))
            check.assert_not_called()

    def test_package_pins_and_duplicate_fields(self):
        index = (f"Package: runsc\nVersion: 20261005.0\nArchitecture: amd64\n"
                 f"Filename: {metadata.PACKAGE}\nSize: 171393970\n"
                 f"SHA256: {metadata.SHA256}\nSHA512: {metadata.SHA512}\n").encode()
        metadata.check_package(index)
        for bad in (index.replace(b"20261005.0", b"20261006.0"),
                    index + b"Size: 171393970\n", index.replace(b"SHA512:", b"SHA512: 0\nSHA512:")):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                metadata.check_package(bad)


if __name__ == "__main__":
    unittest.main()
