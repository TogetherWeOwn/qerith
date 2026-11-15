"""Identify pinned registry inputs for a future offline fixture tool bundle.

This validates lockfile metadata only; it does not verify bundle contents,
acquire artifacts, execute code, or establish isolation.
"""
import base64
import binascii
import json
import pathlib
import urllib.parse


def locked_artifacts(lock_path):
    """Return each registry tarball and its SHA-512 SRI, rejecting ambiguity."""
    lock = json.loads(pathlib.Path(lock_path).read_text(encoding="utf-8"))
    if not isinstance(lock, dict) or lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
        raise ValueError("expected npm lockfile v3 with packages")
    artifacts = {}
    for name, package in lock["packages"].items():
        if not name:
            continue
        if not name.startswith("node_modules/") or not isinstance(package, dict):
            raise ValueError(f"unsupported locked package: {name}")
        url, integrity = package.get("resolved"), package.get("integrity")
        if not isinstance(url, str) or not isinstance(integrity, str):
            raise ValueError(f"missing artifact provenance: {name}")
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.netloc != "registry.npmjs.org"
                or not parsed.path.endswith(".tgz") or parsed.query or parsed.fragment):
            raise ValueError(f"unsupported artifact URL: {name}")
        if not integrity.startswith("sha512-"):
            raise ValueError(f"unsupported artifact integrity: {name}")
        try:
            digest = base64.b64decode(integrity[7:], validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"invalid artifact integrity: {name}") from exc
        if len(digest) != 64 or base64.b64encode(digest).decode() != integrity[7:]:
            raise ValueError(f"invalid artifact integrity: {name}")
        if url in artifacts and artifacts[url] != integrity:
            raise ValueError(f"conflicting integrity for artifact: {name}")
        artifacts[url] = integrity
    if not artifacts:
        raise ValueError("empty artifact set")
    return dict(sorted(artifacts.items()))
