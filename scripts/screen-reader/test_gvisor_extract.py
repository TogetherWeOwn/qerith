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
