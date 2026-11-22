#!/usr/bin/env python3
"""Evaluate Qerith PR attestations using trusted policy and read-only Git data."""

import importlib.util
from collections import defaultdict
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


# Under python -I, admit this trusted checkout's sibling module explicitly.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from declarations import compare, supported


REPO = "TogetherWeOwn/qerith"
ORIGIN = f"https://github.com/{REPO}.git"
SHA = re.compile(r"[a-f0-9]{40}")
MAX_BLOB = 2 * 1024 * 1024


class CheckError(Exception):
    """A fixed diagnostic safe to print in Actions."""


def load_policy(path):
    spec = importlib.util.spec_from_file_location("organization_attestation", path)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    return policy


class History:
    def __init__(self, path):
        self.path = path

    def git(self, *args):
        try:
            return subprocess.run(
                ["/usr/bin/git", "--literal-pathspecs", "-c", "protocol.allow=never",
                 "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", *args],
                cwd=self.path, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=120, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "GIT_CONFIG_NOSYSTEM": "1",
                                  "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"},
            ).stdout
        except (OSError, subprocess.SubprocessError) as exc:
            raise CheckError("git_data_unavailable") from exc

    def fetch(self, base, head, number):
        self.git("init", "--bare", "--template=", "--initial-branch=candidate")
        # GitHub exposes fork commits through this ref on the base repository.
        # Pin the expected object below even if the PR moves during the fetch.
        self.git("fetch", "--no-tags", "--no-recurse-submodules", "--", ORIGIN,
                 f"refs/pull/{number}/head:refs/heads/candidate", f"{base}:refs/heads/baseline")
        if (self.git("rev-parse", "--verify", "refs/heads/candidate^{commit}").strip().decode() != head
                or self.git("rev-parse", "--verify", "refs/heads/baseline^{commit}").strip().decode() != base):
            raise CheckError("git_candidate_identity_mismatch")

    def changes(self, base, head):
        bases = self.git("merge-base", "--all", base, head).decode().splitlines()
        if len(bases) != 1 or not SHA.fullmatch(bases[0]):
            raise CheckError("git_merge_base_unresolved")
        merge_base = bases[0]
        raw = self.git("diff", "--name-status", "--no-ext-diff", "--no-textconv", "--find-renames", "-z",
                       merge_base, head, "--")
        if not raw:
            raise CheckError("git_diff_empty")
        fields = iter(raw.decode().removesuffix("\0").split("\0"))
        files = []
        for status in fields:
            path = next(fields)
            if status.startswith("R"):
                files.append({"filename": next(fields), "status": "renamed", "previous_filename": path})
            else:
                files.append({"filename": path, "status": {
                    "A": "added", "D": "removed", "M": "modified", "T": "changed",
                }[status]})
        if len(files) > 3000:
            raise CheckError("git_diff_too_large")
        return merge_base, files

    def blob(self, commit, path, baseline=False):
        record = self.git("ls-tree", "-z", commit, "--", path)
        if not record:
            return None
        metadata, _, found = record.partition(b"\t")
        mode, kind, oid = metadata.split()
        if found != path.encode() + b"\0":
            raise CheckError("test_source_path_mismatch")
        if mode not in {b"100644", b"100755"} or kind != b"blob":
            if baseline:
                return None
            raise CheckError("test_source_not_regular_blob")
        oid = oid.decode()
        if int(self.git("cat-file", "-s", oid)) > MAX_BLOB:
            raise CheckError("test_source_too_large")
        return self.git("cat-file", "blob", oid)


def citations(policy, body):
    # Shape and section ordering have already passed the pinned org validator.
    # Its public parse result omits the selector, so recover it with its grammar.
    lines = iter(policy.visible_lines(body))
    for line in lines:
        if line == "## Attestation":
            break
    for line in lines:
        if line == "### Tests":
            break
    for line in lines:
        if re.match(r"^#{1,3} ", line):
            break
        match = policy.TEST.fullmatch(line)
        if match:
            path, separator, name = match[2].strip().partition("::")
            if separator:
                yield match[1], path, name.strip()


def test_issues(policy, history, base, head, body, files):
    changes = {row["filename"]: row.get("previous_filename", row["filename"]) for row in files}
    references = defaultdict(list)
    for claim, path, name in citations(policy, body):
        references[path].append((claim, name))
    for path, names in references.items():
        candidate = history.blob(head, path)
        if candidate is None:
            raise CheckError("test_source_missing_at_head")
        old_path = changes[path]
        baseline = history.blob(base, old_path, baseline=True) if supported(old_path) else None
        try:
            current, prior = compare(path, candidate, old_path, baseline, {name for _, name in names})
        except (SyntaxError, ValueError):
            for claim, _ in names:
                yield claim, "test_source_unsupported_or_invalid"
            continue
        for claim, name in names:
            matches = current.get(name, [])
            if not matches:
                yield claim, "test_name_missing_at_head"
            elif len(matches) != 1:
                yield claim, "test_name_ambiguous_at_head"
            elif matches[0] in prior.get(name, []):
                yield claim, "test_declaration_unchanged"


def verdict(policy, api, event, history, fetch=True):
    try:
        detail = event["pull_request"]
        number = policy.number(detail["number"])
        event_head = policy.sha(detail["head"]["sha"])
        if (event["repository"]["full_name"] != REPO or api.repo != REPO
                or event["action"] not in {"opened", "reopened", "synchronize", "edited", "ready_for_review"}):
            raise CheckError("event_unsupported")
    except (KeyError, TypeError) as exc:
        raise CheckError("event_invalid") from exc
    pr = policy.pull(api, number)
    base, head, body = pr["base"]["sha"], pr["head"]["sha"], pr.get("body")
    if head != event_head or pr.get("state") != "open" or pr["base"].get("ref") != "main":
        raise CheckError("event_snapshot_stale")
    if fetch:
        history.fetch(base, head, number)
    merge_base, files = history.changes(base, head)
    report = policy.validate(body, files)
    if report["verdict"] == "valid":
        for claim, issue in test_issues(policy, history, merge_base, head, body, files):
            report["issues"].append(f"{claim}: {issue}")
    fresh = policy.pull(api, number)
    if (fresh["head"]["sha"] != head or fresh["base"]["sha"] != base or fresh.get("body") != body
            or fresh["base"].get("ref") != "main" or fresh.get("state") != "open"):
        raise CheckError("pr_snapshot_changed")
    return {"pr": number, "head_sha": head, "base_sha": base, "merge_base_sha": merge_base,
            "issues": sorted(set(report["issues"]))}


def main():
    try:
        if os.environ["GITHUB_EVENT_NAME"] != "pull_request_target" or os.environ["GITHUB_REPOSITORY"] != REPO:
            raise CheckError("event_unsupported")
        policy = load_policy(os.environ["PR_ATTESTATION_ORG_POLICY"])
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        try:
            api = policy.GitHub(os.environ.get("GH_TOKEN"), REPO)
            with tempfile.TemporaryDirectory(dir=os.environ["RUNNER_TEMP"]) as folder:
                result = verdict(policy, api, event, History(folder))
        except policy.ObservationError as exc:
            raise CheckError(str(exc)) from exc
        print(json.dumps(result, sort_keys=True))
        if result["issues"]:
            print("::error::PR attestation is invalid. See the issues above and update the PR body.")
            return 1
    except CheckError as exc:
        print(f"::error::PR attestation evaluation failed ({exc}).")
        return 1
    except Exception:
        print("::error::PR attestation evaluation failed (runtime_error).")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
