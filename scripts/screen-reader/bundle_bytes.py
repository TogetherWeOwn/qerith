"""Acquire or verify pinned offline bundle bytes; never extract or execute them."""
import argparse
import base64
import hashlib
import pathlib
import urllib.parse
import urllib.request

from bundle_inputs import locked_artifacts

NODE_ARCHIVE = "node-v24.21.0-linux-x64.tar.xz"
NODE_URL = "https://nodejs.org/dist/v24.21.0/" + NODE_ARCHIVE
# Published at https://nodejs.org/dist/v24.21.0/SHASUMS256.txt, inspected 2026-11-15.
NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
MAX_BYTES = 128 * 1024 * 1024


class SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme != "https" or new.netloc != old.netloc:
            raise ValueError("cross-origin artifact redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def artifact_name(integrity):
    return base64.urlsafe_b64encode(base64.b64decode(integrity[7:])).decode().rstrip("=") + ".tgz"


def verify_file(path, algorithm, expected):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"not a regular artifact: {path}")
    digest = hashlib.new(algorithm)
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError(f"artifact too large: {path}")
            digest.update(chunk)
    if not size or digest.digest() != expected:
        raise ValueError(f"artifact integrity mismatch: {path}")


def download(url, path, algorithm, expected):
    opener = urllib.request.build_opener(SameOriginRedirects())
    created = False
    try:
        with opener.open(url, timeout=30) as response, path.open("xb") as target:
            created = True
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("artifact exceeds size limit")
                target.write(chunk)
        verify_file(path, algorithm, expected)
    except Exception:
        if created:
            path.unlink(missing_ok=True)
        raise


def acquire(lock, bundle):
    artifacts = locked_artifacts(lock)
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
    verify_bundle(lock, bundle)


def verify_bundle(lock, bundle):
    artifacts = locked_artifacts(lock)
    bundle = pathlib.Path(bundle)
    expected = {artifact_name(integrity): base64.b64decode(integrity[7:])
                for integrity in artifacts.values()}
    if bundle.is_symlink() or not bundle.is_dir():
        raise ValueError("bundle must be a directory")
    if {entry.name for entry in bundle.iterdir()} != set(expected) | {NODE_ARCHIVE}:
        raise ValueError("bundle contains missing or unexpected artifacts")
    verify_file(bundle / NODE_ARCHIVE, "sha256", bytes.fromhex(NODE_SHA256))
    for name, digest in expected.items():
        verify_file(bundle / name, "sha512", digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("acquire", "verify"))
    parser.add_argument("lock", type=pathlib.Path)
    parser.add_argument("bundle", type=pathlib.Path)
    args = parser.parse_args()
    (acquire if args.action == "acquire" else verify_bundle)(args.lock, args.bundle)


if __name__ == "__main__":
    main()
