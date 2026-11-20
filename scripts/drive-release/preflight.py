"""Read-only admission for the inert Drive production workflow."""

import json
import os
import re
import subprocess

REPO = "TogetherWeOwn/qerith"
QUALIFICATION = "drive-staging-qualification.yml"
SHA = re.compile(r"[0-9a-f]{40}")


def github_get(path, *, paginate=False):
    args = ["gh", "api", "--method", "GET", f"repos/{REPO}/{path}"]
    if paginate:
        args += ["--paginate", "--slurp"]
    try:
        result = subprocess.run(
            args,
            check=True,
            capture_output=True,
            timeout=15,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise SystemExit("Required GitHub evidence could not be read.") from None


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def preflight(accepted, production_accepted, get=github_get):
    require(SHA.fullmatch(accepted), "accepted_sha must be lowercase 40-hex.")
    require(
        accepted == production_accepted,
        "accepted_sha does not match PRODUCTION_ACCEPTED_SHA.",
    )

    main = get("branches/main")
    require(main["protected"] is True, "main must be protected.")
    tip = main["commit"]["sha"]
    require(SHA.fullmatch(tip), "Invalid protected main tip.")
    comparison = get(f"compare/{accepted}...{tip}?per_page=1")
    require(
        comparison["status"] in ("ahead", "identical")
        and comparison["behind_by"] == 0
        and comparison["merge_base_commit"]["sha"] == accepted,
        "accepted_sha is not on protected main.",
    )

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

    path = f".github/workflows/{QUALIFICATION}"
    pages = get(
        f"actions/workflows/{QUALIFICATION}/runs?branch=main&event=workflow_dispatch"
        f"&status=success&head_sha={accepted}&per_page=100",
        paginate=True,
    )
    for run in (run for page in pages for run in page["workflow_runs"]):
        if not (
            run["path"] in (path, f"{path}@main", f"{path}@refs/heads/main")
            and run["event"] == "workflow_dispatch"
            and run["head_branch"] == "main"
            and run["head_sha"] == accepted
            and run["conclusion"] == "success"
            and run["head_repository"]["full_name"] == REPO
            and all(type(run[k]) is int and run[k] > 0 for k in ("id", "run_attempt"))
        ):
            continue
        receipt = f"drive-staging-qualification-{accepted}-attempt-{run['run_attempt']}"
        artifacts = get(f"actions/runs/{run['id']}/artifacts?name={receipt}&per_page=2")
        if any(
            a["name"] == receipt and a["expired"] is False
            for a in artifacts["artifacts"]
        ):
            return run["id"]
    raise SystemExit("No unexpired staging qualification receipt for accepted_sha.")


if __name__ == "__main__":
    try:
        run_id = preflight(
            os.environ.get("ACCEPTED_SHA", ""),
            os.environ.get("PRODUCTION_ACCEPTED_SHA", ""),
        )
    except (KeyError, TypeError, ValueError):
        raise SystemExit(
            "Required GitHub evidence was incomplete or malformed."
        ) from None
    print(
        f"Preflight passed: staging qualification run {run_id}. Deployment remains disabled."
    )
