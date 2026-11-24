from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import unittest
from unittest.mock import Mock
from zipfile import ZipFile

from preflight import CAP, CASES, LOCAL_STORAGE, LOCAL_VENUE, REPO, SMOKE, dispatch_sha, preflight, protected_main

SHA = "a" * 40
BUILD = "b" * 64
RUN = "123"
ATTEMPT = "2"
ENV = "environments/production"
POLICIES = f"{ENV}/deployment-branch-policies?per_page=2"
RECEIPT = f"{SMOKE}-{SHA}-attempt-{ATTEMPT}"
ARTIFACTS = f"actions/runs/{RUN}/artifacts?name={RECEIPT}&per_page=2"
ZIP = "actions/artifacts/456/zip"
NOW = datetime(2026, 11, 23, tzinfo=timezone.utc)


def run(workflow, event):
    return {
        "id": int(RUN),
        "run_attempt": int(ATTEMPT),
        "workflow_id": 42,
        "path": f".github/workflows/{workflow}.yml@main",
        "event": event,
        "head_branch": "main",
        "head_sha": SHA,
        "status": "completed",
        "conclusion": "success",
        "head_repository": {"full_name": REPO},
    }


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.run = run(SMOKE, "workflow_dispatch")
        self.receipt = {
            "version": 2, "stagingVenue": LOCAL_VENUE, "sourceSha": SHA, "runId": RUN, "runAttempt": int(ATTEMPT),
            "buildDigest": BUILD, "workerVersion": "01234567-1234-4321-1234-0123456789ab",
            "testedSizeCapBytes": CAP, "cases": dict.fromkeys(CASES, "pass"), "localStorage": LOCAL_STORAGE.copy(),
        }
        self.artifact = {"id": 456, "name": RECEIPT, "expired": False, "expires_at": "2026-11-24T00:00:00Z"}
        self.responses = {
            "branches/main": {"protected": True, "commit": {"sha": SHA}},
            ENV: {
                "name": "production",
                "deployment_branch_policy": {"custom_branch_policies": True, "protected_branches": False},
            },
            POLICIES: {"total_count": 1, "branch_policies": [{"type": "branch", "name": "main"}]},
            f"actions/workflows/{SMOKE}.yml": {"id": 42, "path": f".github/workflows/{SMOKE}.yml", "state": "active"},
            f"actions/runs/{RUN}": self.run,
            ARTIFACTS: {"total_count": 1, "artifacts": [self.artifact]},
        }
        for workflow in ("ci", "gitleaks"):
            self.responses[self.checks_path(workflow)] = {"total_count": 1, "workflow_runs": [run(workflow, "push")]}
        self.set_archive()
        self.get = Mock(side_effect=lambda path, **_: self.responses[path])

    def checks_path(self, workflow):
        return f"actions/workflows/{workflow}.yml/runs?branch=main&event=push&head_sha={SHA}&per_page=2"

    def set_archive(self, raw=None, name="receipt.json"):
        stream = BytesIO()
        with ZipFile(stream, "w") as archive:
            archive.writestr(name, json.dumps(self.receipt) if raw is None else raw)
        self.responses[ZIP] = archive = stream.getvalue()
        self.artifact.update(size_in_bytes=len(archive), digest=f"sha256:{sha256(archive).hexdigest()}")

    def check(self):
        return preflight(SHA, SHA, SHA, RUN, ATTEMPT, self.get, NOW)

    def reject(self, message):
        with self.assertRaisesRegex(SystemExit, message):
            self.check()

    def test_passes_only_the_exact_checked_build_digest(self):
        self.assertEqual(self.check(), (BUILD, LOCAL_VENUE))
        self.get.assert_called_with(ZIP, raw=True)

    def test_refuses_cloudflare_receipt_for_production(self):
        del self.receipt["localStorage"]
        self.receipt["stagingVenue"] = "cloudflare"
        self.set_archive()
        self.reject("protected local S3 venue and its cleanup")

    def test_requires_declared_venue_with_matching_storage_evidence(self):
        base = self.receipt.copy()
        for change in (
            {"stagingVenue": None}, {"stagingVenue": "anything"}, {"stagingVenue": "cloudflare"},
            {"localStorage": None}, {"localStorage": LOCAL_STORAGE | {"minioRelease": "latest"}},
            {"localStorage": LOCAL_STORAGE | {"incompleteUploadAbort": "fail"}},
            {"localStorage": LOCAL_STORAGE | {"bucketEmpty": "fail"}},
            {"localStorage": LOCAL_STORAGE | {"objectExpiryRule": "fail"}},
        ):
            self.receipt = base | change
            self.set_archive()
            with self.subTest(change=change):
                self.reject("protected local S3 venue and its cleanup")

    def test_rejects_wrong_dispatch_or_unaccepted_candidate_before_api_access(self):
        for sha, accepted, configured, attempt, error in (
            (SHA, "abc", SHA, ATTEMPT, "40-hex"),
            ("d" * 40, SHA, SHA, ATTEMPT, "dispatch SHA"),
            (SHA, SHA, "UNAPPROVED", ATTEMPT, "PRODUCTION_ACCEPTED_SHA"),
            (SHA, SHA, "", ATTEMPT, "PRODUCTION_ACCEPTED_SHA"),
            (SHA, SHA, SHA, "0", "positive decimal"),
        ):
            with self.subTest(error=error), self.assertRaisesRegex(SystemExit, error):
                preflight(sha, accepted, configured, RUN, attempt, self.get, NOW)
        self.get.assert_not_called()

    def test_rejects_nonmanual_nonmain_or_fork_dispatch(self):
        env = {"GITHUB_REPOSITORY": REPO, "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": SHA}
        self.assertEqual(dispatch_sha(env), SHA)
        for key, value in (("GITHUB_REPOSITORY", "fork/qerith"), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_REF", "refs/tags/main")):
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "dispatch"):
                dispatch_sha(env | {key: value})

    def test_rejects_unprotected_main_or_stale_dispatch(self):
        self.responses["branches/main"]["protected"] = False
        self.reject("main must be protected")
        self.responses["branches/main"] = {"protected": True, "commit": {"sha": "f" * 40}}
        self.reject("current protected main tip")

    def test_switch_off_remains_available_from_a_queued_protected_main_dispatch(self):
        tip = "e" * 40
        comparison = f"compare/{SHA}...{tip}?per_page=1"
        self.responses["branches/main"]["commit"]["sha"] = tip
        self.responses[comparison] = {"status": "ahead", "behind_by": 0, "merge_base_commit": {"sha": SHA}}
        protected_main(SHA, self.get, allow_ancestor=True)
        self.responses[comparison]["status"] = "diverged"
        with self.assertRaisesRegex(SystemExit, "no longer on protected main"):
            protected_main(SHA, self.get, allow_ancestor=True)

    def test_rejects_missing_environment_or_noncustom_policy(self):
        temporary = self.responses.pop(ENV)
        with self.assertRaises(KeyError):
            protected_main(SHA, self.get)
        self.responses[ENV] = temporary
        self.responses[ENV]["deployment_branch_policy"]["custom_branch_policies"] = False
        self.reject("custom branch policy")

    def test_rejects_tag_named_main_or_additional_branch(self):
        for entries in ([{"type": "tag", "name": "main"}],
                        [{"type": "branch", "name": name} for name in ("main", "release")]):
            self.responses[POLICIES] = {"total_count": len(entries), "branch_policies": entries}
            with self.subTest(entries=entries):
                self.reject("only the main branch")

    def test_requires_green_exact_main_checks(self):
        for workflow in ("ci", "gitleaks"):
            record = self.responses[self.checks_path(workflow)]["workflow_runs"][0]
            record["conclusion"] = "failure"
            self.reject(f"Required {workflow}")
            record["conclusion"] = "success"

    def test_rejects_untrusted_or_stale_staging_run_before_artifact_lookup(self):
        for key, value in (
            ("head_sha", BUILD[:40]), ("head_branch", "feature"), ("event", "pull_request"),
            ("path", ".github/workflows/other.yml"), ("head_repository", {"full_name": "example/qerith"}),
            ("conclusion", "failure"), ("status", "in_progress"), ("workflow_id", 8), ("run_attempt", 3),
        ):
            self.responses[f"actions/runs/{RUN}"] = self.run | {key: value}
            with self.subTest(key=key):
                self.reject("current successful attempt")
        self.assertNotIn(ARTIFACTS, [call.args[0] for call in self.get.call_args_list])

    def test_rejects_missing_or_duplicate_receipts(self):
        for count, artifacts in [(0, []), (2, [self.artifact, self.artifact])]:
            self.responses[ARTIFACTS] = {"total_count": count, "artifacts": artifacts}
            self.reject("exactly one attempt-specific")

    def test_rejects_expired_oversize_or_previous_attempt_receipts(self):
        for key, value in (
            ("expired", True), ("expires_at", "2026-11-22T00:00:00Z"),
            ("size_in_bytes", 100_000), ("name", RECEIPT.replace("attempt-2", "attempt-1")),
        ):
            self.responses[ARTIFACTS]["artifacts"] = [self.artifact | {key: value}]
            with self.subTest(key=key):
                self.reject("receipt metadata")

    def test_rejects_wrong_archive_digest_path_or_duplicated_json_key(self):
        self.artifact["digest"] = f"sha256:{'0' * 64}"
        self.reject("size and digest")
        self.set_archive(name="../../receipt.json")
        self.reject("single bounded")
        self.set_archive(raw='{"sourceSha":"a","sourceSha":"b"}')
        self.reject("archive is invalid")

    def test_rejects_wrong_payload_attempt_sha_cap_or_incomplete_cases(self):
        for key, value in (
            ("sourceSha", "c" * 40), ("runId", "124"), ("runAttempt", 1),
            ("testedSizeCapBytes", CAP + 1), ("cases", {"invite": "pass"}), ("buildDigest", "bad"),
            ("workerVersion", "another-worker"), ("version", 1),
        ):
            before = self.receipt[key]
            self.receipt[key] = value
            self.set_archive()
            with self.subTest(key=key):
                self.reject("does not prove the exact build")
            self.receipt[key] = before
