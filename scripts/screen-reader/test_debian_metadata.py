import hashlib
import io
import lzma
import struct
import tarfile
import unittest

from debian_metadata import InvalidMetadata, decompress_index, index_entry, package_entry, verify_bytes
from qualify_busybox import PRIMARY, SIGNER, binary_from_tar, check_signatures, data_archive, verify_static_amd64


class MetadataTests(unittest.TestCase):
    def test_release_requires_pinned_valid_signature_and_only_missing_other_keys(self):
        good = ("[GNUPG:] PLAINTEXT 74 0\n[GNUPG:] NEWSIG\n"
                f"[GNUPG:] KEY_CONSIDERED {PRIMARY} 0\n[GNUPG:] SIG_ID x 2026-07-11 1\n"
                "[GNUPG:] GOODSIG 6ED0E7B82643E131 Debian\n"
                f"[GNUPG:] VALIDSIG {SIGNER} 2026-07-11 1 0 4 0 1 8 01 {PRIMARY}\n")
        missing = ("[GNUPG:] NEWSIG\n[GNUPG:] ERRSIG 1234 1 8 01 1 9 FINGERPRINT\n"
                   "[GNUPG:] NO_PUBKEY 1234\n")
        check_signatures(0, good)
        check_signatures(2, good + missing)
        for code, status in ((2, missing), (0, good + missing), (2, good),
                             (2, good.replace(SIGNER, "0" * 40) + missing),
                             (2, good + missing.replace(" 9 FINGERPRINT", " 4 FINGERPRINT")),
                             (2, good + "[GNUPG:] NEWSIG\n[GNUPG:] BADSIG 1234 bad\n"),
                             (2, good + missing + "[GNUPG:] FAILURE verify 1\n")):
            with self.subTest(code=code, status=status), self.assertRaises(ValueError):
                check_signatures(code, status)

    def test_authentication_checks_size_and_digest(self):
        payload = b"index"
        digest = hashlib.sha256(payload).hexdigest()
        verify_bytes(payload, len(payload), digest)
        for size, sha in ((len(payload) + 1, digest), (len(payload), "0" * 64)):
            with self.subTest(size=size, sha=sha), self.assertRaises(InvalidMetadata):
                verify_bytes(payload, size, sha)

    def test_release_entry_must_be_unique(self):
        line = " " + "a" * 64 + " 123 main/binary-amd64/Packages.xz\n"
        self.assertEqual(index_entry(("SHA256:\n" + line).encode(), "main/binary-amd64/Packages.xz"), (123, "a" * 64))
        for data in ("SHA256:\n", "SHA256:\n" + line + line, "SHA256:\n" + line + "SHA256:\n"):
            with self.subTest(data=data), self.assertRaises(InvalidMetadata):
                index_entry(data.encode(), "main/binary-amd64/Packages.xz")

    def test_index_decompression_is_bounded_and_complete(self):
        compressed = lzma.compress(b"hello")
        self.assertEqual(decompress_index(compressed, 5), b"hello")
        for data, limit in ((compressed, 4), (compressed[:-1], 5), (compressed + b"junk", 5), (compressed + compressed, 10)):
            with self.subTest(limit=limit), self.assertRaises(InvalidMetadata):
                decompress_index(data, limit)

    def test_exact_unique_package_record(self):
        record = ("Package: busybox-static\nVersion: 1:1.35.0-4+deb12u1+b1\nArchitecture: amd64\n"
                  "Filename: pool/main/b/busybox/example.deb\nSize: 5\nSHA256: " + "b" * 64 + "\n")
        args = ("busybox-static", "1:1.35.0-4+deb12u1+b1", "amd64")
        self.assertEqual(package_entry(record.encode(), *args), ("pool/main/b/busybox/example.deb", 5, "b" * 64))
        for bad in (record + "\n" + record, record + "Size: 6\n", record.replace("amd64", "arm64"), record.replace("/example", "/../example")):
            with self.subTest(bad=bad), self.assertRaises(InvalidMetadata):
                package_entry(bad.encode(), *args)

    def test_archive_rejects_links_and_unexpected_entries(self):
        def make_tar(name, kind=tarfile.REGTYPE):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.size = 3 if kind == tarfile.REGTYPE else 0
                archive.addfile(entry, io.BytesIO(b"abc") if entry.size else None)
            return stream.getvalue()

        self.assertEqual(binary_from_tar(make_tar("./bin/busybox")), b"abc")
        for data in (make_tar("./bin/busybox", tarfile.SYMTYPE), make_tar("../bin/busybox"), make_tar("./other")):
            with self.assertRaises(ValueError):
                binary_from_tar(data)
        with self.assertRaises(ValueError):
            data_archive(b"!<arch>\ntruncated")

    def test_elf_rejects_dynamic_interpreter_and_wrong_architecture(self):
        data = bytearray(120)
        data[:7] = b"\x7fELF\x02\x01\x01"
        struct.pack_into("<HH", data, 16, 2, 62)
        struct.pack_into("<Q", data, 32, 64)
        struct.pack_into("<HH", data, 54, 56, 1)
        struct.pack_into("<I", data, 64, 1)
        verify_static_amd64(data)
        for offset, fmt, value in ((18, "<H", 183), (64, "<I", 2), (64, "<I", 3), (32, "<Q", 999)):
            altered = bytearray(data)
            struct.pack_into(fmt, altered, offset, value)
            with self.assertRaises(ValueError):
                verify_static_amd64(altered)


if __name__ == "__main__":
    unittest.main()
