import gzip
import hashlib
import io
import os
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

import gvisor_extract as extract


def archive(extra=(), omitted=(), trailing=b""):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(extract.FILES - set(omitted)):
            entry = tarfile.TarInfo("./" + name)
            entry.size = 4
            entry.mode = 0o777
            tar.addfile(entry, io.BytesIO(b"data"))
        for name, kind in extra:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.linkname = "elsewhere"
            tar.addfile(entry)
    return gzip.compress(out.getvalue() + trailing)


def run(data):
    return extract.extract_synthetic(data, len(data), hashlib.sha256(data).hexdigest())


class ExtractionTests(unittest.TestCase):
    def test_success_is_private_and_inert(self):
        with run(archive()) as directory:
            root = Path(directory)
            self.assertEqual(os.stat(root).st_mode & 0o777, 0o700)
            self.assertEqual({p.name for p in root.iterdir()}, {p.rsplit("/", 1)[-1] for p in extract.FILES})
            for path in root.iterdir():
                self.assertEqual(path.read_bytes(), b"data")
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_authentication_precedes_parsing_and_creation(self):
        with patch.object(extract.tempfile, "TemporaryDirectory") as create:
            with self.assertRaises(ValueError):
                extract.extract_synthetic(b"not gzip", 8, "0" * 64)
            create.assert_not_called()

    def test_rejects_bad_members_and_missing_files(self):
        for extra, omitted in (([("../escape", tarfile.REGTYPE)], ()),
                               ([("/absolute", tarfile.REGTYPE)], ()),
                               ([("unexpected", tarfile.REGTYPE)], ()),
                               ([(extract.RUNSC, tarfile.REGTYPE)], ()),
                               ([(extract.RUNSC, tarfile.SYMTYPE)], (extract.RUNSC,)),
                               ([(extract.RUNSC, tarfile.LNKTYPE)], (extract.RUNSC,)),
                               ([(extract.RUNSC, tarfile.DIRTYPE)], (extract.RUNSC,)),
                               ([], (extract.RUNSC,))):
            with self.subTest(extra=extra, omitted=omitted), self.assertRaises(ValueError):
                run(archive(extra, omitted))

    def test_failure_after_writes_removes_private_tree(self):
        data = archive(trailing=b"late corruption")
        original = extract.tempfile.TemporaryDirectory
        paths = []

        def tracked(*args, **kwargs):
            result = original(*args, **kwargs)
            paths.append(Path(result.name))
            return result

        with patch.object(extract.tempfile, "TemporaryDirectory", side_effect=tracked):
            with self.assertRaises(ValueError):
                run(data)
        self.assertEqual(len(paths), 1)
        self.assertFalse(paths[0].exists())

    def test_gzip_framing_rejections_clean_up(self):
        data = archive()
        corrupt_crc = data[:-8] + bytes([data[-8] ^ 1]) + data[-7:]
        corrupt_size = data[:-1] + bytes([data[-1] ^ 1])
        cases = {
            "reserved flags": data[:3] + b"\xe0" + data[4:],
            "extra": data[:3] + b"\x04" + data[4:10] + b"\x00\x00" + data[10:],
            "name": data[:3] + b"\x08" + data[4:10] + b"name\0" + data[10:],
            "comment": data[:3] + b"\x10" + data[4:10] + b"comment\0" + data[10:],
            "header crc": data[:3] + b"\x02" + data[4:10] + b"\x00\x00" + data[10:],
            "truncated header": data[:9],
            "truncated trailer": data[:-1],
            "bad crc": corrupt_crc,
            "bad size": corrupt_size,
            "zero padding": data + b"\0",
            "garbage": data + b"garbage",
            "empty member": data + gzip.compress(b""),
            "many empty members": data + gzip.compress(b"") * 1000,
            "leading empty member": gzip.compress(b"") + data,
            "split stream": gzip.compress(gzip.decompress(data)[:512]) + gzip.compress(gzip.decompress(data)[512:]),
            "second archive": data + data,
        }
        original = extract.tempfile.TemporaryDirectory
        for label, invalid in cases.items():
            paths = []

            def tracked(*args, **kwargs):
                result = original(*args, **kwargs)
                paths.append(Path(result.name))
                return result

            with self.subTest(case=label), patch.object(extract.tempfile, "TemporaryDirectory", side_effect=tracked):
                with self.assertRaises(ValueError):
                    run(invalid)
                self.assertEqual(len(paths), 1)
                self.assertFalse(paths[0].exists())

    def test_stream_spans_compressed_chunks(self):
        data = gzip.compress(gzip.decompress(archive()) + bytes(131072), compresslevel=0)
        with run(data) as directory:
            self.assertEqual(len(list(Path(directory).iterdir())), len(extract.FILES))
        with self.assertRaises(ValueError):
            run(data + gzip.compress(b""))
        with patch.object(extract, "MAX_TAR", 65536), self.assertRaises(ValueError):
            run(data)

    def test_limits_and_invalid_stream(self):
        data = archive()
        for name, value in (("MAX_COMPRESSED", len(data) - 1), ("MAX_FILE", 3),
                            ("MAX_CONTENT", 5), ("MAX_TAR", 1024)):
            with self.subTest(limit=name), patch.object(extract, name, value), self.assertRaises(ValueError):
                run(data)
        with self.assertRaises((ValueError, EOFError)):
            run(data[:-4])


if __name__ == "__main__":
    unittest.main()
