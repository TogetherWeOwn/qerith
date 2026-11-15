import io
import lzma
import struct
import tarfile
import unittest

from debian_archive import binary_from_tar, data_archive, verify_static_amd64


def ar(members):
    result = b"!<arch>\n"
    for name, data in members:
        header = f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n"
        result += header.encode() + data + (b"\n" if len(data) % 2 else b"")
    return result


def tar(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, kind, content in entries:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.size = len(content) if kind == tarfile.REGTYPE else 0
            entry.linkname = "bin/busybox" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
            archive.addfile(entry, io.BytesIO(content) if entry.size else None)
    return output.getvalue()


def elf():
    data = bytearray(120)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHI", data, 16, 2, 62, 1)
    struct.pack_into("<QQ", data, 24, 0x400000, 64)
    struct.pack_into("<HHH", data, 52, 64, 56, 1)
    struct.pack_into("<IIQQ", data, 64, 1, 5, 0, 0x400000)
    struct.pack_into("<QQ", data, 96, len(data), len(data))
    return bytes(data)


class ArchiveTests(unittest.TestCase):
    def test_package_and_binary(self):
        content = tar([("./bin", tarfile.DIRTYPE, b""),
                       ("./bin/busybox", tarfile.REGTYPE, elf()),
                       ("./usr/share/doc/busybox-static/copyright", tarfile.REGTYPE, b"doc")])
        package = ar([("debian-binary", b"2.0\n"), ("control.tar.xz", b"ignored"),
                      ("data.tar.xz", lzma.compress(content))])
        binary = binary_from_tar(data_archive(package))
        self.assertEqual(binary, elf())
        verify_static_amd64(binary)

    def test_invalid_deb_members_and_streams(self):
        good = [("debian-binary", b"2.0\n"), ("control.tar.xz", b"ignored"),
                ("data.tar.xz", lzma.compress(b"data"))]
        for package in (b"!<arch>\ntruncated", ar(good + [good[0]]), ar(good[:-1]),
                        ar(good + [("extra", b"x")]), ar(good).replace(b"2.0\n", b"3.0\n"),
                        ar(good[:-1] + [("data.tar.xz", good[-1][1] + b"junk")]),
                        ar(good)[:-1]):
            with self.subTest(package=package[:30]), self.assertRaises(ValueError):
                data_archive(package)

    def test_tar_rejects_links_duplicates_and_unsafe_names(self):
        binary = ("./bin/busybox", tarfile.REGTYPE, b"abc")
        for entries in ([binary, binary], [("./bin/busybox", tarfile.SYMTYPE, b"")],
                        [binary, ("./usr/share/man/man1/link", tarfile.LNKTYPE, b"")],
                        [binary, ("./usr/share/doc/busybox-static/../escape", tarfile.REGTYPE, b"x")],
                        [binary, ("/bin/other", tarfile.REGTYPE, b"x")],
                        [binary, ("./other", tarfile.REGTYPE, b"x")], []):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                binary_from_tar(tar(entries))

    def test_elf_rejects_dynamic_and_invalid_headers(self):
        verify_static_amd64(elf())
        for offset, fmt, value in ((18, "<H", 183), (16, "<H", 3), (20, "<I", 0),
                                   (52, "<H", 0), (54, "<H", 0), (56, "<H", 0),
                                   (32, "<Q", 999), (64, "<I", 2), (64, "<I", 3),
                                   (64, "<I", 0), (68, "<I", 4), (24, "<Q", 0),
                                   (72, "<Q", 999), (96, "<Q", 0), (96, "<Q", 121)):
            altered = bytearray(elf())
            struct.pack_into(fmt, altered, offset, value)
            with self.subTest(offset=offset, value=value), self.assertRaises(ValueError):
                verify_static_amd64(altered)
        with self.assertRaises(ValueError):
            verify_static_amd64(b"short")


if __name__ == "__main__":
    unittest.main()
