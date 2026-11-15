#!/usr/bin/env python3
"""Assemble a trusted fixture beside, never inside, pinned source blobs."""
import pathlib
import sys

import extract_source

FIXTURE_FILES = ("Fixture.svelte", "main.js", "index.html")


def prepare(repo, sha, destination):
    destination = pathlib.Path(destination)
    if not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("destination must be an existing empty directory")
    fixture = pathlib.Path(__file__).resolve().parent / "target-fixture"
    files = {name: (fixture / name).read_bytes() for name in FIXTURE_FILES}
    source = destination / "source"
    source.mkdir()
    extract_source.extract(repo, sha, source)
    for name, contents in files.items():
        (destination / name).write_bytes(contents)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: prepare_target.py REPOSITORY COMMIT EMPTY_DESTINATION")
    prepare(*sys.argv[1:])
