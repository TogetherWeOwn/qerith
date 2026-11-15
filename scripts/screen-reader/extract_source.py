#!/usr/bin/env python3
"""Copy a bounded set of pinned Git blobs without executing source checkout code."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

SOURCE_FILES = (
    "apps/drive/src/lib/SignInPage.svelte",
    "apps/drive/src/lib/SignInCard.svelte",
    "apps/drive/src/lib/sign-in-state.ts",
    "apps/drive/src/lib/fonts/QerithSans-latin.woff2",
    "apps/drive/src/lib/fonts/FragmentMono-Regular-latin.woff2",
)
MAX_FILE_BYTES = 2 * 1024 * 1024


def git(repo, *args):
    env = {**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"}
    return subprocess.check_output(["git", "-C", str(repo), *args], timeout=30, env=env)


def extract(repo, sha, destination):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("source must be a full lowercase commit SHA")
    if git(repo, "cat-file", "-t", sha).strip() != b"commit":
        raise ValueError("source SHA is not a commit")
    destination = pathlib.Path(destination)
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("destination must be an existing empty directory")

    blobs = []
    for name in SOURCE_FILES:
        entry = git(repo, "ls-tree", "-z", sha, "--", name).split(b"\0")
        if len(entry) != 2 or not entry[0]:
            raise ValueError("missing source file: " + name)
        metadata, actual_name = entry[0].split(b"\t", 1)
        mode, kind, oid = metadata.split(b" ")
        if mode != b"100644" or kind != b"blob" or actual_name.decode() != name:
            raise ValueError("source file must be a regular non-executable blob: " + name)
        size = int(git(repo, "cat-file", "-s", oid.decode()))
        if size > MAX_FILE_BYTES:
            raise ValueError("source file exceeds size limit: " + name)
        data = git(repo, "cat-file", "blob", oid.decode())
        if len(data) != size:
            raise ValueError("blob size mismatch: " + name)
        blobs.append((name, data, oid.decode()))

    files = []
    for name, data, oid in blobs:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files.append({"path": name, "git_blob": oid, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    (destination / "source-manifest.json").write_text(
        json.dumps({"source_commit": sha, "files": files}, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: extract_source.py REPOSITORY COMMIT DESTINATION")
    extract(*sys.argv[1:])
