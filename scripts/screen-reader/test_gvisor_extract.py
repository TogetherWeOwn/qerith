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


def compatible_archive(extra=(), omitted=(), trailing=b"", name=b"debian-data.tar"):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for path in sorted(extract.COMPAT_DIRECTORIES - set(omitted)):
            entry = tarfile.TarInfo(path)
            entry.type = tarfile.DIRTYPE
            tar.addfile(entry)
        for path in sorted(set(extract.COMPAT_FILES) - set(omitted)):
            entry = tarfile.TarInfo(path)
            entry.size = 4
            tar.addfile(entry, io.BytesIO(b"data"))
        for path, kind in extra:
            entry = tarfile.TarInfo(path)
            entry.type = kind
            entry.linkname = "elsewhere"
            tar.addfile(entry)
    data = gzip.compress(out.getvalue() + trailing)
    return data[:3] + b"\x08" + data[4:10] + name + b"\0" + data[10:]


def run_compatible(data):
    sizes = dict.fromkeys(extract.COMPAT_FILES, 4)
    with patch.object(extract, "COMPAT_FILES", sizes):
        return extract.extract_compatible_synthetic(data, len(data), hashlib.sha256(data).hexdigest())


class CompatibilityTests(unittest.TestCase):
    def test_observed_inventory_policy_and_limits(self):
        expected_files = {
            "usr/bin/containerd-shim-runsc-v1": 43626680,
            "usr/bin/runsc": 109966750,
            "usr/bin/gvisor-bin/checkpointgofer": 69128994,
            "usr/bin/gvisor-bin/gvisor-sentry-prewarmer": 1416,
            "usr/bin/gvisor-bin/gvisor_sentry": 52149808,
            "usr/bin/gvisor-bin/runsc-fd-parking": 1320,
            "usr/bin/gvisor-bin/runsc-metric-server": 53222722,
            "etc/containerd/runsc.toml": 302,
        }
        self.assertEqual(extract.COMPAT_FILES, expected_files)
        self.assertEqual(extract.COMPAT_DIRECTORIES,
                         {"usr", "usr/bin", "usr/bin/gvisor-bin", "etc", "etc/containerd"})
        self.assertLessEqual(max(expected_files.values()), extract.MAX_FILE)
        self.assertLessEqual(sum(expected_files.values()), extract.MAX_CONTENT)
        self.assertLessEqual(328110080, extract.MAX_TAR)

    def test_complete_synthetic_inventory_is_inert(self):
        with run_compatible(compatible_archive()) as directory:
            paths = list(Path(directory).iterdir())
            self.assertEqual({p.name for p in paths}, {p.rsplit("/", 1)[-1] for p in extract.FILES})
            self.assertTrue(all(p.read_bytes() == b"data" and p.stat().st_mode & 0o777 == 0o600 for p in paths))

    def test_unlisted_duplicate_missing_and_wrong_types(self):
        for extra, omitted in (([("../escape", tarfile.REGTYPE)], ()),
                               ([("/absolute", tarfile.REGTYPE)], ()),
                               ([("etc/other", tarfile.REGTYPE)], ()),
                               ([(extract.RUNSC, tarfile.REGTYPE)], ()),
                               ([(extract.RUNSC, tarfile.SYMTYPE)], (extract.RUNSC,)),
                               ([(extract.RUNSC, tarfile.LNKTYPE)], (extract.RUNSC,)),
                               ([(extract.RUNSC, tarfile.DIRTYPE)], (extract.RUNSC,)),
                               ([], ("etc",)), ([], (extract.RUNSC,))):
            with self.subTest(extra=extra, omitted=omitted), self.assertRaises(ValueError):
                run_compatible(compatible_archive(extra, omitted))

    def test_padding_sizes_and_cleanup(self):
        data = compatible_archive()
        raw = bytearray(gzip.decompress(data))
        padding = raw.index(b"data") + 4
        raw[padding] = 1
        compressed = gzip.compress(raw)
        malformed_padding = compressed[:3] + b"\x08" + compressed[4:10] + extract.COMPAT_NAME + b"\0" + compressed[10:]
        original = extract.tempfile.TemporaryDirectory
        for label, invalid in (("padding", malformed_padding),
                               ("partial tar block", compatible_archive(trailing=b"\0")),
                               ("late entry", compatible_archive(extra=[("unexpected", tarfile.REGTYPE)]))):
            paths = []

            def tracked(*args, **kwargs):
                result = original(*args, **kwargs)
                paths.append(Path(result.name))
                return result

            with self.subTest(case=label), patch.object(extract.tempfile, "TemporaryDirectory", side_effect=tracked):
                with self.assertRaises(ValueError):
                    run_compatible(invalid)
                self.assertEqual(len(paths), 1)
                self.assertFalse(paths[0].exists())
        sizes = dict.fromkeys(extract.COMPAT_FILES, 4)
        sizes[extract.RUNSC] = 5
        with patch.object(extract, "COMPAT_FILES", sizes), self.assertRaises(ValueError):
            extract.extract_compatible_synthetic(data, len(data), hashlib.sha256(data).hexdigest())

    def test_framing_and_resource_limits(self):
        data = compatible_archive()
        invalid = [compatible_archive(name=b"wrong"), compatible_archive(name=b"x" * 4097),
                   data[:10] + extract.COMPAT_NAME, data[:9],
                   *(data[:3] + bytes([flag]) + data[4:] for flag in (0, 9, 10, 12, 24, 40, 0xe8)),
                   data + b"x", data + gzip.compress(b""), data + data,
                   data[:-1], compatible_archive(trailing=b"\0")]
        for value in invalid:
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                run_compatible(value)
        for limit, value in (("MAX_COMPRESSED", len(data) - 1), ("MAX_FILE", 3),
                             ("MAX_CONTENT", 5), ("MAX_TAR", 1024)):
            with self.subTest(limit=limit), patch.object(extract, limit, value), self.assertRaises(ValueError):
                run_compatible(data)
        with self.assertRaises(ValueError):
            run(data)
        with self.assertRaises(ValueError):
            extract.extract_compatible_synthetic(data, len(data), hashlib.sha256(data).hexdigest())


if __name__ == "__main__":
    unittest.main()
