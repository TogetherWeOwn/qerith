import json
import pathlib
import subprocess
import tempfile
import unittest

import extract_source
import prepare_target


class ExtractionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.out = root / "out"
        self.out.mkdir()
        self.git("init", "-q")
        for name in extract_source.SOURCE_FILES:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
        self.sha = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def test_extracts_committed_blobs_and_provenance_not_worktree(self):
        name = extract_source.SOURCE_FILES[0]
        (self.repo / name).write_text("uncommitted change")
        extract_source.extract(self.repo, self.sha, self.out)
        self.assertEqual((self.out / name).read_text(), name)
        manifest = json.loads((self.out / "source-manifest.json").read_text())
        self.assertEqual(manifest["source_commit"], self.sha)
        self.assertEqual(len(manifest["files"]), len(extract_source.SOURCE_FILES))
        self.assertEqual(manifest["files"][0]["path"], name)

    def test_ignores_git_replacement_commits(self):
        name = extract_source.SOURCE_FILES[0]
        (self.repo / name).write_text("replacement content")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "replacement")
        replacement = self.git("rev-parse", "HEAD").strip()
        self.git("replace", self.sha, replacement)
        extract_source.extract(self.repo, self.sha, self.out)
        self.assertEqual((self.out / name).read_text(), name)
        self.assertEqual(json.loads((self.out / "source-manifest.json").read_text())["source_commit"], self.sha)

    def test_target_fixture_stays_separate_from_extracted_source(self):
        fixture = pathlib.Path(__file__).parent / "target-fixture"
        before = {name: (fixture / name).read_bytes() for name in ("Fixture.svelte", "main.js", "index.html")}
        extract_source.extract(self.repo, self.sha, self.out)
        self.assertEqual(before, {name: (fixture / name).read_bytes() for name in before})
        self.assertTrue(all(not (self.out / name).exists() for name in before))
        self.assertIn(b"./source/apps/drive/src/lib/SignInPage.svelte", before["Fixture.svelte"])

    def test_prepares_fixture_with_separate_pinned_source(self):
        (self.repo / extract_source.SOURCE_FILES[0]).write_text("uncommitted change")
        prepare_target.prepare(self.repo, self.sha, self.out)
        fixture = pathlib.Path(__file__).parent / "target-fixture"
        for name in prepare_target.FIXTURE_FILES:
            self.assertEqual((self.out / name).read_bytes(), (fixture / name).read_bytes())
        self.assertEqual((self.out / "source" / extract_source.SOURCE_FILES[0]).read_text(), extract_source.SOURCE_FILES[0])
        self.assertEqual(json.loads((self.out / "source" / "source-manifest.json").read_text())["source_commit"], self.sha)
        with self.assertRaises(ValueError):
            prepare_target.prepare(self.repo, self.sha, self.out)

    def test_rejects_partial_sha_and_nonempty_destination(self):
        with self.assertRaises(ValueError):
            extract_source.extract(self.repo, self.sha[:12], self.out)
        (self.out / "other").touch()
        with self.assertRaises(ValueError):
            extract_source.extract(self.repo, self.sha, self.out)

    def test_rejects_symlink_without_partial_output(self):
        target = self.repo / extract_source.SOURCE_FILES[-1]
        target.unlink()
        target.symlink_to("/etc/passwd")
        self.git("add", ".")
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "symlink")
        with self.assertRaises(ValueError):
            extract_source.extract(self.repo, self.git("rev-parse", "HEAD").strip(), self.out)
        self.assertEqual(list(self.out.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
