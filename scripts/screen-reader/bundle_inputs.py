#!/usr/bin/env python3
"""Validate the pinned inputs before preparing an offline fixture tool bundle."""
import argparse
import base64
import binascii
import hashlib
import json
import pathlib
import urllib.parse
import urllib.request

MAX_ARTIFACT_BYTES = 128 * 1024 * 1024


class RegistryRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme != "https" or new.netloc != old.netloc:
            raise ValueError("cross-origin artifact redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def artifact_name(integrity):
    return base64.urlsafe_b64encode(base64.b64decode(integrity[7:])).decode().rstrip("=") + ".tgz"


def verify_file(path, algorithm, expected):
    digest = hashlib.new(algorithm)
    size = 0
    with pathlib.Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise ValueError(f"artifact too large: {path}")
            digest.update(chunk)
    if digest.digest() != expected:
        raise ValueError(f"artifact integrity mismatch: {path}")


def download(url, destination, algorithm, expected):
    """Download into a new file and retain it only after digest verification."""
    opener = urllib.request.build_opener(RegistryRedirects())
    created = False
    try:
        with opener.open(url, timeout=30) as response, pathlib.Path(destination).open("xb") as target:
            created = True
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_ARTIFACT_BYTES:
                    raise ValueError("artifact exceeds size limit")
                target.write(chunk)
        verify_file(destination, algorithm, expected)
    except Exception:
        if created:
            pathlib.Path(destination).unlink(missing_ok=True)
        raise


def acquire(lock_path, bundle):
    """Create an artifact directory from the lock, never executing its contents."""
    artifacts = locked_artifacts(lock_path)
    bundle = pathlib.Path(bundle)
    bundle.mkdir()
    download(NODE_URL, bundle / NODE_ARCHIVE, "sha256", bytes.fromhex(NODE_SHA256))
    for url, integrity in artifacts.items():
        path = bundle / artifact_name(integrity)
        expected = base64.b64decode(integrity[7:])
        if path.exists():
            verify_file(path, "sha512", expected)
        else:
            download(url, path, "sha512", expected)


def verify_bundle(lock_path, bundle):
    """Verify all required bytes against trusted inputs, without using the network."""
    artifacts = locked_artifacts(lock_path)
    bundle = pathlib.Path(bundle)
    verify_file(bundle / NODE_ARCHIVE, "sha256", bytes.fromhex(NODE_SHA256))
    for integrity in set(artifacts.values()):
        verify_file(bundle / artifact_name(integrity), "sha512", base64.b64decode(integrity[7:]))

NODE_VERSION = "24.21.0"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-linux-x64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"


def locked_artifacts(lock_path):
    """Return each registry tarball and its SHA-512 SRI, rejecting ambiguity."""
    lock = json.loads(pathlib.Path(lock_path).read_text(encoding="utf-8"))
    if lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("acquire", "verify"))
    parser.add_argument("lock", type=pathlib.Path)
    parser.add_argument("bundle", type=pathlib.Path)
    args = parser.parse_args()
    if args.action == "acquire":
        acquire(args.lock, args.bundle)
    else:
        verify_bundle(args.lock, args.bundle)


if __name__ == "__main__":
    main()
