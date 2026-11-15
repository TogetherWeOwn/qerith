import hashlib
import lzma
import unittest

from debian_metadata import InvalidMetadata, decompress_index, index_entry, package_entry, verify_bytes


class MetadataTests(unittest.TestCase):

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
        other = record.replace("busybox-static", "other")
        self.assertEqual(package_entry((other + "\n" + record).replace("\n", "\r\n").encode(), *args),
                         ("pool/main/b/busybox/example.deb", 5, "b" * 64))
        bad_records = (record + "\n" + record, record + "Size: 6\n", record + "size: 6\n",
                       record.replace("Size: 5\n", "Size: 5\n 6\n"), record.replace("amd64", "arm64"),
                       record.replace("/example", "/../example"), record.replace("/example", "/%2e%2e/example"))
        for bad in bad_records:
            with self.subTest(bad=bad), self.assertRaises(InvalidMetadata):
                package_entry(bad.encode(), *args)


if __name__ == "__main__":
    unittest.main()
