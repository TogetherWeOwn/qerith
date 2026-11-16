"""Authenticate and prepare the pinned package as inert data in Actions only.

No extracted file is installed, executed, or admitted as a runtime. This path
requires independent Security clearance before it is run on candidate bytes.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import tempfile

import gvisor_extract as extract
import gvisor_inventory as inventory
import gvisor_metadata as metadata


def prepare_bytes(package, pins):
    """Return a private temporary root after authenticating immutable bytes."""
    expected = {"signer": metadata.FINGERPRINT, "index_sha256": metadata.INDEX_SHA256,
                "package": metadata.PACKAGE, "size": inventory.SIZE,
                "sha256": metadata.SHA256, "sha512": metadata.SHA512}
    if (pins != expected or type(package) is not bytes or len(package) != inventory.SIZE
            or hashlib.sha256(package).hexdigest() != metadata.SHA256
            or hashlib.sha512(package).hexdigest() != metadata.SHA512):
        raise ValueError("package authentication failed")
    source = io.BytesIO(package)
    members = inventory.ar_members(source)
    name, start, size = members[2]
    if name != "data.tar.gz" or size > extract.MAX_COMPRESSED:
        raise ValueError("unexpected data archive")
    source.seek(start)
    data = source.read(size)
    if len(data) != size:
        raise ValueError("truncated data archive")
    # The package hash authenticates this slice; this digest only binds the
    # extractor's interface to the exact immutable bytes just authenticated.
    return extract.extract_compatible_synthetic(data, size, hashlib.sha256(data).hexdigest())


def main():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("preparation must run in GitHub Actions")
    with tempfile.TemporaryDirectory(prefix="gvisor-acquisition-") as directory:
        root = Path(directory)
        pins = metadata.verify_metadata(root)
        path = root / "candidate.deb"
        inventory.download(path)
        with path.open("rb") as f:
            package = f.read(inventory.SIZE + 1)
        with prepare_bytes(package, pins) as prepared:
            # The temporary root is deliberately not exported or uploaded.
            print(json.dumps({"prepared_files": sorted(p.name for p in Path(prepared).iterdir()),
                              "execution_authorized": False}, sort_keys=True))


if __name__ == "__main__":
    main()
