"""Read passive telemetry from the fixed synthetic fixture, never from a target page."""
import base64
import json
import pathlib
import re
import sys

MAX_FILE = 20 * 1024 * 1024


def read_rows(path):
    path = pathlib.Path(path)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError("missing or oversized browser log")
    rows = []
    for encoded in re.findall(rb"SR_DOM_V1=(\S*)", path.read_bytes()):
        rows.append(json.loads(base64.b64decode(encoded, validate=True)))
    if not rows or rows[0].get("kind") != "ready":
        raise ValueError("missing DOM ready marker")
    if [row.get("seq") for row in rows] != list(range(1, len(rows) + 1)):
        raise ValueError("incomplete or unordered DOM trace")
    return rows


def ready(rows, button=False):
    row = rows[-1]
    return row.get("documentFocused") is True and (not button or row.get("active") == "announce")


def validate(rows):
    def find(start, predicate):
        return next((i for i in range(start, len(rows)) if predicate(rows[i])), -1)

    key = find(1, lambda r: r.get("kind") == "keydown" and r.get("key") == "Enter"
               and r.get("target") == "announce" and r.get("active") == "announce"
               and r.get("documentFocused") is True and r.get("trusted") is True)
    click = find(key + 1, lambda r: r.get("kind") == "click" and r.get("target") == "announce"
                 and r.get("trusted") is True and r.get("detail") == 0) if key >= 0 else -1
    mutation = find(click + 1, lambda r: r.get("kind") == "status-mutation"
                    and r.get("status") == "Synthetic announcement received") if click >= 0 else -1
    if mutation < 0:
        raise ValueError("missing ordered trusted Return, click, or status mutation")


if __name__ == "__main__":
    try:
        data = read_rows(sys.argv[1])
        if not ready(data, button=len(sys.argv) > 2 and sys.argv[2] == "button"):
            raise ValueError("document or button not focused")
    except (ValueError, OSError, json.JSONDecodeError, IndexError):
        raise SystemExit(1)
