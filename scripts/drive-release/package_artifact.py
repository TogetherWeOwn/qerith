"""Restore only the data files of an exact-run, credential-free Drive build."""

from datetime import datetime, timezone
from io import BytesIO
import os
from pathlib import Path
import re
from shutil import copyfileobj
import stat
from zipfile import BadZipFile, ZipFile

from preflight import RUN_NUMBER, SHA, dispatch_sha, github_get, require, utc_time, verify_archive

WORKER = "first-release-package/_worker.js"
VERSION_ASSET = "cloudflare/_app/version.json"
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
MAX_FILES = 1024
SEGMENT = re.compile(r"[0-9A-Za-z._-]{1,200}")


def allowed_file(name):
    parts = name.split("/")
    return (
        len(name) <= 240
        and all(SEGMENT.fullmatch(part) and part not in (".", "..") for part in parts)
        and (
            name == WORKER
            or (parts[0] == "cloudflare" and len(parts) > 1 and name != "cloudflare/_worker.js")
        )
    )


def restore(archive, destination):
    try:
        with ZipFile(BytesIO(archive)) as zipped:
            files = zipped.infolist()
            names = {entry.orig_filename for entry in files}
            require(
                2 <= len(files) <= MAX_FILES and len(names) == len(files)
                and {WORKER, VERSION_ASSET}.issubset(names)
                and sum(entry.file_size for entry in files) <= MAX_EXTRACTED_BYTES,
                "Build artifact file set is missing, duplicated or oversized.",
            )
            require(
                all(entry.filename == entry.orig_filename and allowed_file(entry.filename)
                    and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                    and entry.file_size <= MAX_FILE_BYTES for entry in files),
                "Build artifact contains an unsafe file.",
            )
            destination.mkdir()
            for entry in files:
                path = destination / entry.filename
                path.parent.mkdir(parents=True, exist_ok=True)
                with zipped.open(entry) as source, path.open("xb") as output:
                    copyfileobj(source, output)
    except (BadZipFile, NotImplementedError, RuntimeError, ValueError, OSError):
        raise SystemExit("Could not safely restore the credential-free build artifact.") from None


def read_package(sha, run_id, attempt, package_id, get=github_get, now=None):
    require(
        SHA.fullmatch(sha)
        and all(RUN_NUMBER.fullmatch(value) for value in (run_id, attempt, package_id)),
        "Build artifact identifiers must match the current Actions run and attempt.",
    )
    name = f"drive-production-package-{sha}-attempt-{attempt}"
    artifacts = get(f"actions/runs/{run_id}/artifacts?name={name}&per_page=2")
    require(
        artifacts["total_count"] == 1 and len(artifacts["artifacts"]) == 1,
        "Expected one build artifact for the current run and attempt.",
    )
    artifact = artifacts["artifacts"][0]
    now = now if now is not None else datetime.now(timezone.utc)
    require(
        artifact["name"] == name and artifact["id"] == int(package_id)
        and artifact["expired"] is False and utc_time(artifact["expires_at"]) > now
        and type(artifact["size_in_bytes"]) is int and 0 < artifact["size_in_bytes"] <= MAX_ARCHIVE_BYTES
        and re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]),
        "Build artifact is missing, expired or outside the expected size.",
    )
    archive = get(f"actions/artifacts/{package_id}/zip", raw=True)
    verify_archive(archive, artifact)
    return archive


if __name__ == "__main__":
    try:
        archive = read_package(
            dispatch_sha(os.environ), os.environ.get("GITHUB_RUN_ID", ""),
            os.environ.get("GITHUB_RUN_ATTEMPT", ""), os.environ.get("PACKAGE_ID", ""),
        )
        restore(archive, Path("apps/drive/.svelte-kit"))
    except (KeyError, TypeError, ValueError, OverflowError):
        raise SystemExit("Required build artifact evidence was incomplete or malformed.") from None
