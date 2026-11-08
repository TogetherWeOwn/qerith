"""Declared client-side rows, not the parent's broader service acceptance matrix."""

PROFILES = ("cli-default", "cli-restrictive", "boto3-default", "boto3-restrictive")
ROWS = (
    "reset-fixture", "create-bucket", "bucket-inventory", "put-object", "retained-head",
    "retained-get-denied", "cold-copy-denied", "conditional-before-restore",
    "list-pagination", "upload-inventory", "multipart", "multipart-errors-replay",
    "abort-multipart", "integrity-errors", "archive-empty-cache",
    "before-restore", "restore-admission", "pending-restore", "pending-restart",
    "whole-generation-restore", "completed-head", "completed-get", "range-get",
    "conditional-completed", "tenant-isolation", "revoked-credentials", "restored-copy",
    "copy-conditions-replace", "upload-part-copy", "renew-restore", "expired-restore",
    "restore-io-failure", "missing-errors", "delete-nonempty-bucket",
    "delete-objects", "delete-bucket",
)
UNQUALIFIED = (
    "live-provider/backbone independence", "trusted-client encryption/readability",
    "supplier/database/crash durability", "Workers resource/cost limits",
    "rclone/high-level/sync/mount", "chunked/trailer/CRC64NVME support",
    "native/REST/MCP parity", "tenant/revocation/moderation",
    "20-subscriber coalescing/cancel", "lost-response reconciliation",
    "production/release acceptance",
)


def missing_result(profile, reason):
    return {"profile": profile, "qualified": False, "rows": [
        {"id": name, "outcome": "unqualified", "reason": reason,
         "must_pass": profile.endswith("restrictive")} for name in ROWS
    ]}


def passed(profiles):
    if [p.get("profile") for p in profiles] != list(PROFILES):
        return False
    for profile in profiles:
        rows = profile.get("rows", [])
        if [row.get("id") for row in rows] != list(ROWS):
            return False
        restrictive = profile["profile"].endswith("restrictive")
        if restrictive and profile.get("exit_code") != 0:
            return False
        for row in rows:
            if row.get("must_pass") != restrictive:
                return False
            if restrictive and row.get("outcome") != "pass":
                return False
    return True
