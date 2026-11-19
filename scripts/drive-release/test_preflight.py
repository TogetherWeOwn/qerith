import unittest
from unittest.mock import Mock

from preflight import preflight

ACCEPTED = "a" * 40
TIP = "b" * 40
PIN = "Team:42"
BRANCH = "branches/main"
COMPARE = f"compare/{ACCEPTED}...{TIP}?per_page=1"
ENV = "environments/production"
POLICIES = f"{ENV}/deployment-branch-policies?per_page=2"
RUNS = (
    "actions/workflows/drive-staging-qualification.yml/runs?branch=main"
    f"&event=workflow_dispatch&status=success&head_sha={ACCEPTED}&per_page=10"
)
RECEIPT = f"drive-staging-qualification-{ACCEPTED}"
ARTIFACTS = f"actions/runs/123/artifacts?name={RECEIPT}&per_page=2"


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.reviewer_rule = {
            "type": "required_reviewers",
            "prevent_self_review": True,
            "reviewers": [{"type": "Team", "reviewer": {"id": 42}}],
        }
        self.run_record = {
            "id": 123,
            "path": ".github/workflows/drive-staging-qualification.yml",
            "event": "workflow_dispatch",
            "head_branch": "main",
            "head_sha": ACCEPTED,
            "conclusion": "success",
            "head_repository": {"full_name": "TogetherWeOwn/qerith"},
        }
        self.responses = {
            BRANCH: {"protected": True, "commit": {"sha": TIP}},
            COMPARE: {
                "status": "ahead",
                "behind_by": 0,
                "merge_base_commit": {"sha": ACCEPTED},
            },
            ENV: {
                "name": "production",
                "can_admins_bypass": False,
                "deployment_branch_policy": {
                    "custom_branch_policies": True,
                    "protected_branches": False,
                },
                "protection_rules": [self.reviewer_rule],
            },
            POLICIES: {
                "total_count": 1,
                "branch_policies": [{"type": "branch", "name": "main"}],
            },
            RUNS: {"workflow_runs": [self.run_record]},
            ARTIFACTS: {"artifacts": [{"name": RECEIPT, "expired": False}]},
        }
        self.get = Mock(side_effect=self.responses.__getitem__)

    def test_accepts_ancestor_with_exact_receipt_and_protected_environment(self):
        self.assertEqual(preflight(ACCEPTED, PIN, self.get), 123)

    def test_rejects_bad_sha_or_pin_before_api_access(self):
        for sha, pin in [
            (ACCEPTED.upper(), PIN),
            (f"{ACCEPTED}\n", PIN),
            ("abc", PIN),
            (ACCEPTED, ""),
        ]:
            with self.subTest(sha=sha, pin=pin), self.assertRaises(SystemExit):
                preflight(sha, pin, self.get)
        self.get.assert_not_called()

    def test_rejects_unprotected_main_and_non_ancestor(self):
        self.responses[BRANCH]["protected"] = False
        with self.assertRaisesRegex(SystemExit, "main must be protected"):
            preflight(ACCEPTED, PIN, self.get)
        self.responses[BRANCH]["protected"] = True
        self.responses[COMPARE]["merge_base_commit"]["sha"] = TIP
        with self.assertRaisesRegex(SystemExit, "not on protected main"):
            preflight(ACCEPTED, PIN, self.get)

    def test_rejects_missing_environment(self):
        self.get.side_effect = [
            self.responses[BRANCH],
            self.responses[COMPARE],
            SystemExit("GitHub 404"),
        ]
        with self.assertRaisesRegex(SystemExit, "GitHub 404"):
            preflight(ACCEPTED, PIN, self.get)

    def test_rejects_missing_wrong_or_bypassable_review(self):
        for rule_overrides in [
            {"reviewers": []},
            {"reviewers": [{"type": "User", "reviewer": {"id": 42}}]},
            {"reviewers": self.reviewer_rule["reviewers"] * 2},
            {"prevent_self_review": False},
        ]:
            self.responses[ENV]["protection_rules"] = [
                self.reviewer_rule | rule_overrides
            ]
            with self.subTest(overrides=rule_overrides), self.assertRaises(SystemExit):
                preflight(ACCEPTED, PIN, self.get)
        self.responses[ENV]["protection_rules"] = [self.reviewer_rule]
        self.responses[ENV]["can_admins_bypass"] = True
        with self.assertRaisesRegex(SystemExit, "missing required protections"):
            preflight(ACCEPTED, PIN, self.get)

    def test_rejects_tag_named_main(self):
        self.responses[POLICIES]["branch_policies"][0]["type"] = "tag"
        with self.assertRaisesRegex(SystemExit, "only the main branch"):
            preflight(ACCEPTED, PIN, self.get)

    def test_rejects_wrong_run_even_when_exactly_named_artifact_exists(self):
        for key, value in [
            ("head_sha", TIP),
            ("head_branch", "feature"),
            ("event", "pull_request"),
            ("path", ".github/workflows/ci.yml"),
            ("head_repository", {"full_name": "example/qerith"}),
            ("conclusion", "failure"),
        ]:
            self.responses[RUNS]["workflow_runs"] = [self.run_record | {key: value}]
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(SystemExit, "No unexpired"),
            ):
                preflight(ACCEPTED, PIN, self.get)
        self.assertNotIn(ARTIFACTS, [call.args[0] for call in self.get.call_args_list])

    def test_rejects_missing_expired_and_wrong_sha_receipts(self):
        for artifacts in [
            [],
            [{"name": RECEIPT, "expired": True}],
            [{"name": f"drive-staging-qualification-{TIP}", "expired": False}],
        ]:
            self.responses[ARTIFACTS]["artifacts"] = artifacts
            with (
                self.subTest(artifacts=artifacts),
                self.assertRaisesRegex(SystemExit, "No unexpired"),
            ):
                preflight(ACCEPTED, PIN, self.get)
