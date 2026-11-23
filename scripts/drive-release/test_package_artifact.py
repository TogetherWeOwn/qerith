from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock
from zipfile import ZipFile, ZipInfo

from package_artifact import VERSION_ASSET, WORKER, read_package, restore

SHA = "a" * 40
NOW = datetime(2026, 11, 23, tzinfo=timezone.utc)
FILES = {WORKER: b"export default {}", VERSION_ASSET: b"{}", "cloudflare/.assetsignore": b"_worker.js"}


def archive(files):
    memory = BytesIO()
    with ZipFile(memory, "w") as zipped:
        for name, data in files.items():
            zipped.writestr(name, data)
    return memory.getvalue()


class PackageArtifactTests(TestCase):
    def test_restores_only_the_regular_checked_worker_and_asset_tree(self):
        with TemporaryDirectory() as tmp:
            dest = Path(tmp) / "build"
            restore(archive(FILES), dest)
            restored = {str(path.relative_to(dest)): path.read_bytes() for path in dest.rglob("*") if path.is_file()}
            self.assertEqual(restored, FILES)

    def test_refuses_path_escape_links_extra_worker_modules_and_existing_destination(self):
        for name in ("cloudflare/../../../pyvenv.cfg", "/cloudflare/host", "cloudflare/trick\\file",
                     "cloudflare/_worker.js", "first-release-package/other.js"):
            with self.subTest(name=name), TemporaryDirectory() as tmp:
                dest = Path(tmp) / "build"
                with self.assertRaisesRegex(SystemExit, "unsafe file"):
                    restore(archive(FILES | {name: b"forged"}), dest)
                self.assertFalse(dest.exists())

        link = ZipInfo("cloudflare/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(SystemExit, "unsafe file"):
                restore(archive(FILES | {link: b"../../scripts"}), Path(tmp) / "build")
            with self.assertRaisesRegex(SystemExit, "Could not safely restore"):
                restore(archive(FILES), Path(tmp))

    def test_fetches_only_the_build_output_artifact_of_the_current_attempt(self):
        data = archive(FILES)
        name = f"drive-production-package-{SHA}-attempt-2"
        evidence = {"id": 456, "name": name, "expired": False, "expires_at": "2026-11-24T00:00:00Z",
                    "size_in_bytes": len(data), "digest": f"sha256:{sha256(data).hexdigest()}"}
        get = Mock(side_effect=[{"total_count": 1, "artifacts": [evidence]}, data])
        self.assertEqual(read_package(SHA, "123", "2", "456", get, NOW), data)
        get.assert_any_call(f"actions/runs/123/artifacts?name={name}&per_page=2")
        get.assert_called_with("actions/artifacts/456/zip", raw=True)

        for field, value in (("id", 9), ("name", name.replace("attempt-2", "attempt-1")), ("expired", True)):
            get = Mock(return_value={"total_count": 1, "artifacts": [evidence | {field: value}]})
            with self.subTest(field=field), self.assertRaisesRegex(SystemExit, "missing, expired"):
                read_package(SHA, "123", "2", "456", get, NOW)
            self.assertEqual(get.call_count, 1)
