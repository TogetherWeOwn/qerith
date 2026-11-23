"""Verify first-release evidence from GitHub before granting provider access."""

from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
import re
import subprocess
import sys
from zipfile import BadZipFile, ZipFile

REPO = "TogetherWeOwn/qerith"
SMOKE = "drive-first-release-smoke"
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"[0-9a-f]{64}")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
RUN_NUMBER = re.compile(r"[1-9][0-9]{0,19}")
CAP = 16 * 1024 * 1024 + 257
CASES = {
    "invite", "uninvitedDenial", "share", "revoke", "multipartResume",
    "byteIdenticalDownload", "overCapRefusal", "permanentDeletionUnavailable",
    "cleanup",
}
RECEIPT_LIMIT = 64 * 1024


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def github_get(path, *, raw=False):
    try:
        result = subprocess.run(
            ["gh", "api", "--method", "GET", f"repos/{REPO}/{path}"],
            check=True, capture_output=True, timeout=15,
        )
        return result.stdout if raw else json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise SystemExit("Required GitHub evidence could not be read.") from None


def json_object(data):
    def unique(pairs):
        obj = dict(pairs)
        if len(obj) != len(pairs):
            raise ValueError("Duplicate JSON key")
        return obj
    return json.loads(data, object_pairs_hook=unique)


def utc_time(value):
    parsed = datetime.fromisoformat(value)
    require(parsed.utcoffset() == timezone.utc.utcoffset(None), "Expected a UTC timestamp.")
    return parsed


def protected_main(sha, get=github_get):
    require(SHA.fullmatch(sha), "Dispatch SHA must be lowercase 40-hex.")
    main = get("branches/main")
    require(main["protected"] is True, "main must be protected.")
    require(main["commit"]["sha"] == sha, "Dispatch SHA must equal the current protected main tip.")

    env = get("environments/production")
    policy = env["deployment_branch_policy"]
    require(
        env["name"] == "production"
        and policy["custom_branch_policies"] is True
        and policy["protected_branches"] is False,
        "Production environment must use a custom branch policy.",
    )
    branches = get("environments/production/deployment-branch-policies?per_page=2")
    require(
        branches["total_count"] == 1
        and [(p["type"], p["name"]) for p in branches["branch_policies"]]
        == [("branch", "main")],
        "Production environment must allow only the main branch and no tags.",
    )


def trusted_run(run, workflow, sha, event):
    path = f".github/workflows/{workflow}.yml"
    return (
        run["path"] in (path, f"{path}@main", f"{path}@refs/heads/main")
        and run["event"] == event
        and run["head_branch"] == "main"
        and run["head_sha"] == sha
        and run["status"] == "completed"
        and run["conclusion"] == "success"
        and run["head_repository"]["full_name"] == REPO
    )


def require_main_checks(sha, get):
    for workflow in ("ci", "gitleaks"):
        runs = get(
            f"actions/workflows/{workflow}.yml/runs?branch=main&event=push"
            f"&head_sha={sha}&per_page=2"
        )
        require(
            runs["total_count"] == 1
            and len(runs["workflow_runs"]) == 1
            and trusted_run(runs["workflow_runs"][0], workflow, sha, "push"),
            f"Required {workflow} workflow has no successful push run on the dispatch SHA.",
        )


def read_receipt(archive, artifact):
    require(
        len(archive) == artifact["size_in_bytes"]
        and artifact["digest"] == f"sha256:{sha256(archive).hexdigest()}",
        "Staging receipt archive does not match GitHub's recorded size and digest.",
    )
    try:
        with ZipFile(BytesIO(archive)) as zipped:
            files = zipped.infolist()
            require(
                len(files) == 1 and files[0].filename == "receipt.json"
                and 0 < files[0].file_size <= RECEIPT_LIMIT,
                "Expected a single bounded staging receipt.json.",
            )
            return json_object(zipped.read(files[0]))
    except (BadZipFile, NotImplementedError, RuntimeError, ValueError):
        raise SystemExit("Staging receipt archive is invalid.") from None


def preflight(sha, accepted, production_accepted, run_id, attempt, get=github_get, now=None):
    require(SHA.fullmatch(accepted), "accepted_sha must be lowercase 40-hex.")
    require(accepted == sha, "accepted_sha must equal the dispatch SHA.")
    require(accepted == production_accepted, "accepted_sha does not match PRODUCTION_ACCEPTED_SHA.")
    require(
        RUN_NUMBER.fullmatch(run_id) and RUN_NUMBER.fullmatch(attempt),
        "Staging run ID and attempt must be positive decimal integers.",
    )
    protected_main(sha, get)
    require_main_checks(sha, get)
    workflow = get(f"actions/workflows/{SMOKE}.yml")
    run = get(f"actions/runs/{run_id}")
    require(
        workflow["path"] == f".github/workflows/{SMOKE}.yml"
        and workflow["state"] == "active"
        and type(workflow["id"]) is int and workflow["id"] > 0
        and run["workflow_id"] == workflow["id"]
        and run["id"] == int(run_id) and run["run_attempt"] == int(attempt)
        and trusted_run(run, SMOKE, sha, "workflow_dispatch"),
        "Staging run is not the current successful attempt of the trusted main smoke workflow.",
    )
    name = f"{SMOKE}-{sha}-attempt-{attempt}"
    artifacts = get(f"actions/runs/{run_id}/artifacts?name={name}&per_page=2")
    require(
        artifacts["total_count"] == 1 and len(artifacts["artifacts"]) == 1,
        "Expected exactly one attempt-specific staging receipt.",
    )
    artifact = artifacts["artifacts"][0]
    now = now if now is not None else datetime.now(timezone.utc)
    require(
        artifact["name"] == name and artifact["expired"] is False
        and utc_time(artifact["expires_at"]) > now
        and type(artifact["id"]) is int and artifact["id"] > 0
        and type(artifact["size_in_bytes"]) is int
        and 0 < artifact["size_in_bytes"] <= RECEIPT_LIMIT
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]),
        "Staging receipt metadata is expired, invalid or outside the supported size.",
    )
    receipt = read_receipt(get(f"actions/artifacts/{artifact['id']}/zip", raw=True), artifact)
    require(
        type(receipt["version"]) is int and receipt["version"] == 1
        and receipt["sourceSha"] == sha and receipt["runId"] == run_id
        and type(receipt["runAttempt"]) is int and receipt["runAttempt"] == int(attempt)
        and DIGEST.fullmatch(receipt["buildDigest"])
        and UUID.fullmatch(receipt["workerVersion"])
        and type(receipt["testedSizeCapBytes"]) is int and receipt["testedSizeCapBytes"] == CAP
        and receipt["cases"] == dict.fromkeys(CASES, "pass"),
        "Staging receipt does not prove the exact build, cap and all required cases.",
    )
    return receipt["buildDigest"]


def dispatch_sha(env):
    require(
        env.get("GITHUB_REPOSITORY") == REPO
        and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and env.get("GITHUB_REF") == "refs/heads/main",
        "Production requires a dispatch from this repository's main branch.",
    )
    return env.get("GITHUB_SHA", "")


if __name__ == "__main__":
    try:
        sha = dispatch_sha(os.environ)
        if sys.argv[1:] == ["switch-off"]:
            protected_main(sha)
        else:
            require(sys.argv[1:] == ["release"], "Invalid production operation.")
            digest = preflight(
                sha, os.environ.get("ACCEPTED_SHA", ""),
                os.environ.get("PRODUCTION_ACCEPTED_SHA", ""),
                os.environ.get("STAGING_RUN_ID", ""), os.environ.get("STAGING_RUN_ATTEMPT", ""),
            )
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                print(f"build_digest={digest}", file=output)
            print(f"Exact-SHA staging receipt verified. Build digest {digest}.")
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise SystemExit("Required GitHub evidence was incomplete or malformed.") from None
