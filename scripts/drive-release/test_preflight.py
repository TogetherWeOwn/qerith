import unittest
from unittest.mock import Mock

from preflight import preflight

ACCEPTED, TIP, PIN = "a" * 40, "b" * 40, "Team:42"
BRANCH = "branches/main"
COMPARE = f"compare/{ACCEPTED}...{TIP}?per_page=1"
ENV = "environments/production"
POLICIES = f"{ENV}/deployment-branch-policies?per_page=2"
RUNS = (
    "actions/workflows/drive-staging-qualification.yml/runs?branch=main"
    f"&event=workflow_dispatch&status=success&head_sha={ACCEPTED}&per_page=100"
)
RECEIPT = f"drive-staging-qualification-{ACCEPTED}-attempt-2"
ARTIFACTS = f"actions/runs/123/artifacts?name={RECEIPT}&per_page=2"


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.rule = {
            "type": "required_reviewers",
            "prevent_self_review": True,
            "reviewers": [{"type": "Team", "reviewer": {"id": 42}}],
        }
        self.run_record = {
            "id": 123,
            "run_attempt": 2,
            "path": ".github/workflows/drive-staging-qualification.yml@main",
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
                "protection_rules": [self.rule],
            },
            POLICIES: {
                "total_count": 1,
                "branch_policies": [{"type": "branch", "name": "main"}],
            },
            RUNS: [{"workflow_runs": [self.run_record]}],
            ARTIFACTS: {"artifacts": [{"name": RECEIPT, "expired": False}]},
        }
        self.get = Mock(side_effect=lambda path, **_: self.responses[path])

    def reject(self, reason):
        with self.assertRaisesRegex(SystemExit, reason):
            preflight(ACCEPTED, PIN, self.get)

    def test_accepts_exact_receipt_from_later_page_and_main_workflow(self):
        other = self.run_record | {"head_sha": TIP}
        self.responses[RUNS].insert(0, {"workflow_runs": [other] * 100})
        self.assertEqual(preflight(ACCEPTED, PIN, self.get), 123)
        self.get.assert_any_call(RUNS, paginate=True)

    def test_rejects_bad_sha_or_pin_before_api_access(self):
        for sha in ["abc", ACCEPTED.upper(), f"{ACCEPTED}\n"]:
            with self.subTest(sha=sha), self.assertRaisesRegex(SystemExit, "40-hex"):
                preflight(sha, PIN, self.get)
        with self.assertRaisesRegex(SystemExit, "reviewer pin"):
            preflight(ACCEPTED, "", self.get)
        self.get.assert_not_called()

    def test_rejects_unprotected_main_and_non_ancestor(self):
        self.responses[BRANCH]["protected"] = False
        self.reject("main must be protected")
        self.responses[BRANCH]["protected"] = True
        self.responses[COMPARE]["merge_base_commit"]["sha"] = TIP
        self.reject("not on protected main")

    def test_rejects_missing_environment(self):
        self.get.side_effect = [
            self.responses[BRANCH],
            self.responses[COMPARE],
            SystemExit("GitHub 404"),
        ]
        self.reject("GitHub 404")

    def test_rejects_missing_wrong_or_bypassable_review(self):
        for overrides in [
            {"reviewers": []},
            {"reviewers": [{"type": "Team", "reviewer": {"id": 43}}]},
            {"reviewers": self.rule["reviewers"] * 2},
            {"prevent_self_review": False},
        ]:
            self.responses[ENV]["protection_rules"] = [self.rule | overrides]
            with self.subTest(overrides=overrides):
                self.reject("Production (environment|reviewer)")
        self.responses[ENV]["protection_rules"] = [self.rule]
        self.responses[ENV]["can_admins_bypass"] = True
        self.reject("missing required protections")
        del self.responses[ENV]["can_admins_bypass"]
        self.reject("missing required protections")

    def test_rejects_tag_named_main(self):
        self.responses[POLICIES]["branch_policies"][0]["type"] = "tag"
        self.reject("only the main branch")

    def test_rejects_wrong_run_even_when_exactly_named_artifact_exists(self):
        for key, value in [
            ("head_sha", TIP),
            ("head_branch", "feature"),
            ("event", "pull_request"),
            ("path", ".github/workflows/drive-staging-qualification.yml@evil"),
            ("head_repository", {"full_name": "example/qerith"}),
            ("conclusion", "failure"),
        ]:
            self.responses[RUNS][0]["workflow_runs"] = [self.run_record | {key: value}]
            with self.subTest(key=key):
                self.reject("No unexpired")
        self.assertNotIn(ARTIFACTS, [call.args[0] for call in self.get.call_args_list])

    def test_rejects_missing_expired_wrong_sha_or_previous_attempt_receipts(self):
        for artifacts in [
            [],
            [{"name": RECEIPT, "expired": True}],
            [{"name": RECEIPT.replace(ACCEPTED, TIP), "expired": False}],
            [{"name": RECEIPT.replace("attempt-2", "attempt-1"), "expired": False}],
        ]:
            self.responses[ARTIFACTS]["artifacts"] = artifacts
            with self.subTest(artifacts=artifacts):
                self.reject("No unexpired")
