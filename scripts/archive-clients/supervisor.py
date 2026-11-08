#!/usr/bin/env -S python3 -I
"""Out-of-session teardown supervisor for the synthetic client fixture.

The Rust fixture kills the runner PID with SIGKILL on panic, timeout or drop.
SIGKILL bypasses every Python finally block, so graceful handling inside the
killed runner can never be the containment boundary. This module keeps the
boundary outside the runner: one supervisor process in its own session holds a
read end of a heartbeat pipe whose only writer is the runner process. When the
runner dies by any means the pipe reports EOF, and the supervisor escalates
SIGTERM then SIGKILL across every process group still in the runner's session.

The runner is its session leader (sid == runner pid); workers join that session
under their own process groups (process_group=0), never a new session, so a
worker can always be reached by killpg(worker pid) and by a session-wide sweep.
"""

import os
import select
import signal
import subprocess
import sys
import time
from pathlib import Path

GRACE_SECONDS = 3.0
VERIFY_SECONDS = 5.0
# Runner bound (440s) plus profile slack and teardown time.
SUPERVISOR_MAX_SECONDS = 600.0


def _stat_fields(pid):
    # proc(5): comm may contain spaces and parens, so fields after the final ')'
    # are state, ppid, pgrp, session in that order.
    stat = Path("/proc", str(pid), "stat").read_text()
    return stat.rsplit(")", 1)[1].split()


def session_groups(session_id):
    groups = set()
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            fields = _stat_fields(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError,
                IndexError, ValueError):
            continue
        # Zombies hold a group id but are already dead; a group of only zombies
        # drains as soon as init reaps them and is not killable anyway.
        if fields[0] == "Z":
            continue
        try:
            if int(fields[3]) == session_id:
                groups.add(int(fields[2]))
        except (IndexError, ValueError):
            continue
    return groups


def terminate_group(pgid, log, grace_seconds=GRACE_SECONDS):
    """SIGTERM a group, then SIGKILL once it survives the grace window.

    Used for bounded worker teardown while the runner is alive and for
    supervisor escalation after runner death. A zombie leader still holds its
    group; callers reap their own children separately.
    """
    def note(message):
        try:
            log.write((message + "\n").encode())
        except Exception:
            pass

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except (PermissionError, OverflowError) as error:
        note(f"terminate_group: TERM {pgid} failed: {error}")
        return
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
        note(f"terminate_group: {pgid} exceeded {grace_seconds}s grace; KILL")
    except ProcessLookupError:
        return
    time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def reap_session(session_id, log, grace_seconds=GRACE_SECONDS, verify_seconds=VERIFY_SECONDS):
    """TERM then KILL every process group in the runner's session, then verify."""
    def note(message):
        try:
            log.write((message + "\n").encode())
        except Exception:
            pass

    for sig, budget in ((signal.SIGTERM, grace_seconds), (signal.SIGKILL, verify_seconds)):
        deadline = time.monotonic() + budget
        while True:
            groups = session_groups(session_id)
            if not groups:
                note(f"reap_session {session_id}: drained")
                return
            for pgid in groups:
                try:
                    os.killpg(pgid, sig)
                except (ProcessLookupError, PermissionError) as error:
                    note(f"reap_session {session_id}: {sig} -> {pgid}: {error}")
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    note(f"reap_session {session_id}: survivors after KILL window: "
         f"{sorted(session_groups(session_id))}")


def ensure_session():
    """Make the runner a session leader so its descendants form a killable set.

    A worker group that shares the runner's session is enumerated by sid; a
    worker in a separate session would escape supervision entirely.
    """
    if os.getsid(0) == os.getpid():
        return os.getpid()
    os.setsid()
    return os.getsid(0)


def spawn_supervisor(session_id, log_path, max_seconds=SUPERVISOR_MAX_SECONDS):
    """Start the out-of-session watchdog. Returns (process, heartbeat write fd).

    The write fd is close-on-exec and is never passed to workers, so heartbeat
    EOF is exactly "the runner process died", however it died.
    """
    read_fd, write_fd = os.pipe()
    os.set_inheritable(write_fd, False)
    log = open(log_path, "ab", buffering=0)
    process = subprocess.Popen(
        [sys.executable, "-I", str(Path(__file__).resolve()),
         str(read_fd), str(session_id), str(max_seconds)],
        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True, pass_fds=(read_fd,))
    os.close(read_fd)
    log.close()
    return process, write_fd


def supervise(heartbeat_fd, session_id, max_seconds, log):
    """Wait for heartbeat EOF, then escalate across the whole session."""
    deadline = time.monotonic() + max_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ready, _, _ = select.select([heartbeat_fd], [], [], min(5.0, remaining))
        if ready and not os.read(heartbeat_fd, 1):
            break
    os.close(heartbeat_fd)
    reap_session(session_id, log)


def main():
    heartbeat_fd, session_id, max_seconds = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
    supervise(heartbeat_fd, session_id, max_seconds, sys.stdout.buffer)


if __name__ == "__main__":
    main()
