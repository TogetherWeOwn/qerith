"""Copy one untrusted result from a caller-sealed output mount into quarantine.

This is not a sandbox or a sealing check. Before calling, the supervisor must
have created an initially empty, inode-bounded private output tmpfs, stopped all
writers and helpers, observed their cgroup empty, remounted the same mount
read-only, and verified its identity and effective read-only and nodev state. No process
may reattach or modify it during this call. The caller supplies an open directory
FD and the device ID recorded for that verified mount; neither may come from the
guest. A trusted, private quarantine directory on bounded local storage must be
open as a directory FD; no untrusted process may access it during the copy.
The supervisor must enforce a deadline around this operation and discard the
result if this call or subsequent cleanup fails.
"""
import hashlib
import os
import stat

MAX_RESULT_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 64 * 1024


def copy_result(output_fd, expected_device, quarantine_fd):
    """Create quarantine/result.bin exclusively; return its byte count and SHA-256.

    On error the newly created file is removed. Existing quarantine files are
    never replaced. The caller must not expose the copy until all custody and
    cleanup requirements have succeeded.
    """
    directory = os.fstat(output_fd)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_dev != expected_device:
        raise ValueError("unexpected output directory or device")
    with os.scandir(output_fd) as entries:
        first = next(entries, None)
        if first is None or first.name != "result.bin" or next(entries, None) is not None:
            raise ValueError("output must contain only result.bin")

    entry = os.stat("result.bin", dir_fd=output_fd, follow_symlinks=False)
    if not stat.S_ISREG(entry.st_mode):
        raise ValueError("result is not a regular file")
    source = os.open("result.bin", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=output_fd)
    try:
        info = os.fstat(source)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
                info.st_dev != expected_device or info.st_size > MAX_RESULT_BYTES):
            raise ValueError("invalid result file")
        destination = os.open("result.bin", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                              0o600, dir_fd=quarantine_fd)
        try:
            with os.fdopen(destination, "wb") as target:
                digest = hashlib.sha256()
                copied = 0
                while True:
                    data = os.read(source, min(CHUNK_BYTES, MAX_RESULT_BYTES + 1 - copied))
                    if not data:
                        break
                    copied += len(data)
                    if copied > MAX_RESULT_BYTES:
                        raise ValueError("result exceeds size limit")
                    target.write(data)
                    digest.update(data)
                if copied != info.st_size:
                    raise ValueError("result size changed during copy")
            source_to_close, source = source, None
            os.close(source_to_close)
            return {"bytes": copied, "sha256": digest.hexdigest()}
        except BaseException:
            os.unlink("result.bin", dir_fd=quarantine_fd)
            raise
    finally:
        if source is not None:
            os.close(source)
