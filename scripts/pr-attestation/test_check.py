import copy
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from check import CheckError, History, REPO, load_policy, main, verdict
from declarations import scan


FILE = "test_sample.py"


def attestation(target, tier="T1"):
    return "\n".join([
        "## Attestation", f"risk_tier: {tier}", "### Claims", "- C1: The sample checks its count.",
        "### Tests", (f"- C1 | test={target} | failed_before=not-run | proof=Synthetic fixture passed."
                      if target else "- none | reason=Documentation only."),
        "### High-risk checklist", *[f"- [ ] D{i}: Synthetic fixture only." for i in range(1, 9)],
    ])


class PullAPI:
    repo = REPO

    def __init__(self, base, head, body, count):
        self.pr = {"number": 7, "state": "open", "body": body, "changed_files": count,
                   "head": {"sha": head}, "base": {"sha": base, "ref": "main", "repo": {"full_name": REPO}}}

    def get(self, endpoint):
        if endpoint != "pulls/7":
            raise AssertionError(endpoint)
        return copy.deepcopy(self.pr)


class ExactHeadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = load_policy(os.environ["PR_ATTESTATION_ORG_POLICY"])
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        cls.tree = Path(tmp.name)
        cls.git("init", "--quiet", "--template=")
        cls.write(FILE, "def test_stale():\n    assert 1\n\ndef test_unchanged():\n    assert 1\n")
        cls.write("test_baseline.py", "def test_baseline():\n    assert 1\n")
        cls.write("server.test.mjs", "import test from 'node:test';\ntest('serves assets', (t) => { t.assert.ok(true) });\n")
        cls.base = cls.commit("baseline")
        cls.write(FILE, "raise RuntimeError('candidate must never execute')\n"
                  "def test_good():\n    assert 2\n\ndef test_unchanged():\n    assert 1\n")
        cls.write("test_other.py", "def test_other():\n    assert 3\n")
        cls.head = cls.commit("candidate")
        cls.git("mv", "test_baseline.py", "test_renamed.py")
        cls.git("mv", "server.test.mjs", "server.test.ts")
        cls.rename = cls.commit("rename")
        cls.git("checkout", "--quiet", "--detach", cls.base)
        cls.write("README.md", "Sample documentation.\n")
        cls.docs = cls.commit("docs")
        cls.history = History(cls.tree)

    @classmethod
    def git(cls, *args):
        return subprocess.check_output([
            "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", str(cls.tree), *args,
        ], text=True).strip()

    @classmethod
    def write(cls, name, content):
        (cls.tree / name).write_text(content)

    @classmethod
    def commit(cls, message):
        cls.git("add", "--all")
        cls.git("commit", "--quiet", "-m", message)
        return cls.git("rev-parse", "HEAD")

    def event(self, head):
        return {"action": "edited", "repository": {"full_name": REPO}, "pull_request": {
            "number": 7, "head": {"sha": head}, "body": attestation(f"{FILE}::test_stale"),
        }}

    def evaluate(self, body, head=None, count=2):
        head = head or self.head
        return verdict(self.policy, PullAPI(self.base, head, body, count), self.event(head), self.history, fetch=False)

    def test_edited_body_uses_the_current_attestation_and_exact_head(self):
        result = self.evaluate(attestation(f"{FILE}::test_good"))
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["head_sha"], self.head)
        self.assertNotEqual(self.git("rev-parse", "HEAD"), self.head)

    def test_missing_stale_wrong_file_and_unchanged_citations_fail(self):
        for target, issue in (
            (f"{FILE}::test_missing", "C1: test_name_missing_at_head"),
            (f"{FILE}::test_stale", "C1: test_name_missing_at_head"),
            (f"{FILE}::test_other", "C1: test_name_missing_at_head"),
            (f"{FILE}::test_unchanged", "C1: test_declaration_unchanged"),
            ("test_baseline.py::test_baseline", "test_file_not_in_head_diff"),
        ):
            with self.subTest(target=target):
                self.assertEqual(self.evaluate(attestation(target))["issues"], [issue])

    def test_rename_preserves_baseline_and_proof_exemptions(self):
        self.assertEqual(self.evaluate(attestation("test_renamed.py::test_baseline"), self.rename, 4)["issues"],
                         ["C1: test_declaration_unchanged"])
        self.assertEqual(self.evaluate(attestation(FILE))["issues"], [])
        self.assertEqual(self.evaluate(attestation(None, "T2"), self.docs, 1)["issues"], [])

    def test_javascript_to_typescript_rename_does_not_create_new_evidence(self):
        result = self.evaluate(attestation("server.test.ts::serves assets"), self.rename, 4)
        self.assertEqual(result["issues"], ["C1: test_declaration_unchanged"])

    def test_stale_event_and_changed_pr_snapshot_are_errors(self):
        api = PullAPI(self.base, self.head, attestation(f"{FILE}::test_good"), 2)
        with self.assertRaisesRegex(CheckError, "event_snapshot_stale"):
            verdict(self.policy, api, self.event(self.base), self.history, fetch=False)

        first = api.get

        def edit_after_read(endpoint):
            row = first(endpoint)
            api.pr["body"] = attestation(f"{FILE}::test_missing")
            return row

        api.get = edit_after_read
        with self.assertRaisesRegex(CheckError, "pr_snapshot_changed"):
            verdict(self.policy, api, self.event(self.head), self.history, fetch=False)

    def test_fetches_fork_head_from_base_pr_ref_and_rejects_a_moved_ref(self):
        class LocalHistory(History):
            def git(self, *args):
                return super().git("-c", "protocol.file.allow=always", *args)

        with tempfile.TemporaryDirectory() as folder:
            origin = Path(folder) / "base.git"
            candidate = Path(folder) / "candidate.git"
            candidate.mkdir()
            self.git("init", "--bare", "--quiet", "--template=", str(origin))
            self.git("push", "--quiet", str(origin), f"{self.base}:refs/heads/main", f"{self.head}:refs/pull/7/head")
            with patch("check.ORIGIN", origin.as_uri()):
                api = PullAPI(self.base, self.head, attestation(f"{FILE}::test_good"), 2)
                history = LocalHistory(candidate)
                result = verdict(self.policy, api, self.event(self.head), history)
                self.assertEqual(result["issues"], [])
                self.assertEqual(result["head_sha"], self.head)
                self.assertFalse((candidate / FILE).exists())
                self.git("push", "--quiet", str(origin), f"{self.rename}:refs/pull/7/head")
                with self.assertRaisesRegex(CheckError, "git_candidate_identity_mismatch"):
                    verdict(self.policy, api, self.event(self.head), history)

    def test_command_fails_on_invalid_evidence_and_unavailable_git(self):
        event_path = self.tree / "event.json"
        event_path.write_text(json.dumps(self.event(self.head)))
        env = {"GITHUB_EVENT_NAME": "pull_request_target", "GITHUB_REPOSITORY": REPO,
               "GITHUB_EVENT_PATH": str(event_path), "RUNNER_TEMP": str(self.tree)}
        with (patch.dict(os.environ, env), patch.object(self.policy, "GitHub") as github,
              patch("check.load_policy", return_value=self.policy), patch("check.History", return_value=self.history),
              patch.object(self.history, "fetch") as fetch, contextlib.redirect_stdout(io.StringIO()) as log):
            github.return_value = PullAPI(self.base, self.head, attestation(f"{FILE}::test_good"), 2)
            self.assertEqual(main(), 0)
            github.return_value = PullAPI(self.base, self.head, attestation(f"{FILE}::test_missing"), 2)
            self.assertEqual(main(), 1)
            fetch.side_effect = CheckError("git_data_unavailable")
            self.assertEqual(main(), 1)
        self.assertIn("test_name_missing_at_head", log.getvalue())
        self.assertIn("git_data_unavailable", log.getvalue())


class DeclarationsTests(unittest.TestCase):
    def test_typescript_const_table_resolves_each_name_and_row_change(self):
        source = b"""
          import test from 'node:test';
          for (const [, kind, /* count */ count] of ([[, /* fixture */ 'registration', 1], ['ignored', 'authentication', 2]] as const)) {
            test(`${kind} verified`, () => assert.equal(count, fixture(kind)));
          }
        """
        baseline = scan("ceremony.test.ts", source)
        revised = scan("ceremony.test.ts", source.replace(b"'registration', 1", b"'registration', 3"))
        self.assertEqual(set(baseline), {"registration verified", "authentication verified", "${kind} verified"})
        self.assertNotEqual(baseline["registration verified"], revised["registration verified"])
        self.assertEqual(baseline["authentication verified"], revised["authentication verified"])

    def test_javascript_statement_boundary_changes_fingerprint(self):
        prefix = b"import test from 'node:test'; test('case', () => { "
        baseline = scan("sample.test.mjs", prefix + b"return\n assert.rejects(operation()) });")
        revised = scan("sample.test.mjs", prefix + b"return assert.rejects(operation()) });")
        commented = scan("sample.test.mjs", prefix + b"return /* comment */ assert.rejects(operation()) });")
        self.assertNotEqual(baseline["case"], revised["case"])
        self.assertEqual(revised["case"], commented["case"])

    def test_javascript_and_typescript_declarations(self):
        source = b"""
          import test, {test as nodeTest} from 'node:test';
          import {it} from 'vitest';
          const standAloneTest = import.meta.main ? nodeTest : () => {};
          // test('comment', () => {});
          const snippet = "test('in a string', () => {});";
          test('literal', async () => {});
          test('parent', async (context) => { await context.test('child', () => {}); });
          t.test('unrelated method', () => {});
          nodeTest('aliased', () => {});
          it.each(['one', 'two'])('case %s', () => {});
          for (const [kind, fixture] of [['zero', 0], ['one', 1]]) {
            standAloneTest(`loop case ${kind}`, () => {});
          }
          for (const kind of ['outer']) {
            ['inner'].forEach((kind) => test(`nested case ${kind}`, () => {}));
          }
        """
        expected = {"literal", "parent", "child", "aliased", "case %s", "loop case ${kind}",
                    "loop case zero", "loop case one", "nested case ${kind}"}
        self.assertEqual(set(scan("sample.test.mjs", source)), expected)
        self.assertEqual(set(scan("sample.test.ts", source + b"const code: number = 1;")), expected)

    def test_rust_and_python_declarations(self):
        rust = b"""
          mod suite {
            #[tokio::test(flavor = "current_thread")]
            async fn named() {}
            // #[test] fn comment() {}
            fn helper() {}
          }
        """
        python = b"class Cases:\n    def test_named(self):\n        assert True\n\n# def test_comment(): pass\n"
        self.assertEqual(set(scan("sample.rs", rust)), {"named", "suite::named"})
        self.assertEqual(set(scan("sample.py", python)), {"test_named", "Cases.test_named", "Cases::test_named"})
