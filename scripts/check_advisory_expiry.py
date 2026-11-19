#!/usr/bin/env python3
"""Fail closed when the approved chrono advisory exception expires."""

import datetime as dt
import sys
import tomllib
from pathlib import Path

ADVISORY = "RUSTSEC-2026-0543"
EXPIRES_AT = "2027-02-17T00:00:00Z"


def check(policy, expires_at, now):
    if not isinstance(expires_at, str):
        raise ValueError("missing expiry")
    try:
        expiry = dt.datetime.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError as exc:
        raise ValueError("invalid UTC expiry") from exc
    if expiry != dt.datetime(2027, 2, 17, tzinfo=dt.timezone.utc):
        raise ValueError("expiry does not match the approved deadline")
    if now.tzinfo is None or now.utcoffset() != dt.timedelta(0):
        raise ValueError("current time must be UTC")
    advisories = policy.get("advisories")
    if not isinstance(advisories, dict):
        raise ValueError("missing advisories policy")
    ignores = advisories.get("ignore", [])
    if not isinstance(ignores, list):
        raise ValueError("invalid advisory ignore list")
    ids = []
    for entry in ignores:
        advisory_id = entry if isinstance(entry, str) else entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(advisory_id, str) or not advisory_id:
            raise ValueError("invalid advisory ignore entry")
        ids.append(advisory_id)
    if ADVISORY in ids and now >= expiry:
        raise ValueError(f"{ADVISORY} exception expired at {expires_at}")


def main():
    try:
        with Path("deny.toml").open("rb") as policy_file:
            policy = tomllib.load(policy_file)
        check(policy, EXPIRES_AT, dt.datetime.now(dt.timezone.utc))
    except (OSError, ValueError, TypeError) as exc:
        print(f"advisory expiry check failed: {exc}", file=sys.stderr)
        return 1
    print("advisory expiry check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
