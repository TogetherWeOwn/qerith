"""Supervised teardown regressions; process-only, no network, provider or deps.

The Rust fixture can only SIGKILL the runner pid, which bypasses every Python
finally. These tests prove containment therefore lives outside the runner: a
synthetic parent (same ensure_session + spawn_supervisor + run_bounded wiring as
runner.py) starts a worker group with a live descendant, and killing the parent
must leave no surviving member of the parent's session before cleanup runs.
"""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import supervisor


FAKE_PARENT = f"""
import os, sys
from pathlib import Path
sys.path.insert(0, {str(ROOT)!r})
import supervisor
from runner import run_bounded

session_id = supervisor.ensure_session()
watchdog, heartbeat = supervisor.spawn_supervisor(
    session_id, os.environ["SUPERVISOR_LOG"], max_seconds=60)

if os.environ.get("GRACEFUL"):
    import signal
    def cancel(_signal, _frame):
        raise KeyboardInterrupt("cancelled")
    signal.signal(signal.SIGTERM, cancel)

worker = (
    "import os, subprocess, sys, time\\n"
    "descendant = subprocess.Popen([sys.executable, '-I', '-c', "
    "'import time; time.sleep(60)'])\\n"
    "open(os.environ['DESCENDANT_PID'], 'w').write(str(descendant.pid))\\n"
    "open(os.environ['WORKER_PID'], 'w').write(str(os.getpid()))\\n"
    "time.sleep(60)\\n"
)
open(os.environ["HEARTBEAT_FD"], "w").write(str(heartbeat))
try:
    run_bounded([sys.executable, "-I", "-c", worker], dict(os.environ),
                Path(os.environ["WORKER_LOG"]), 60)
except KeyboardInterrupt:
    pass
# The heartbeat write fd stays open until process exit; closing it earlier
# would reap this parent's own group while it is still running.
"""


# Execute the real main() watcher, replacing only the network/client workload.
# The test's separate adopter process owns PR_SET_CHILD_SUBREAPER, so no other
# unittest or shared-host process has its adoption policy changed.
WATCHED_RUNNER = f"""
import os, sys
from pathlib import Path
sys.path.insert(0, {str(ROOT)!r})
import runner, supervisor

def workload(_args):
    session_id = supervisor.ensure_session()
    watchdog, heartbeat = supervisor.spawn_supervisor(
        session_id, os.environ["SUPERVISOR_LOG"], max_seconds=60)
    worker = (
        "import os, subprocess, sys, time\\n"
        "descendant = subprocess.Popen([sys.executable, '-I', '-c', "
        "'import time; time.sleep(60)'])\\n"
        "open(os.environ['DESCENDANT_PID'], 'w').write(str(descendant.pid))\\n"
        "open(os.environ['WORKER_PID'], 'w').write(str(os.getpid()))\\n"
        "time.sleep(60)\\n"
    )
    return runner.run_bounded([sys.executable, '-I', '-c', worker], dict(os.environ),
                              Path(os.environ["WORKER_LOG"]), 60)

runner.execute = workload
sys.argv = ['runner', '--upstream', 'http://127.0.0.1:1', '--control-token', 'synthetic']
sys.exit(runner.main())
"""

SUBREAPER = f"""
import ctypes, os, signal, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, {str(ROOT)!r})
import supervisor
from test_supervisor import gone

libc = ctypes.CDLL(None, use_errno=True)
assert libc.prctl(36, 1, 0, 0, 0) == 0, 'PR_SET_CHILD_SUBREAPER failed'
runner = None
parent = subprocess.Popen([sys.executable, '-I', '-c',
    "import os, subprocess, sys, time; "
    "runner = subprocess.Popen([sys.executable, '-I', '-c', sys.argv[1]]); "
    "open(os.environ['RUNNER_PID'], 'w').write(str(runner.pid)); time.sleep(60)",
    {WATCHED_RUNNER!r}])
try:
    deadline = time.monotonic() + 10
    while True:
        try:
            runner = int(Path(os.environ['RUNNER_PID']).read_text())
            worker = int(Path(os.environ['WORKER_PID']).read_text())
            descendant = int(Path(os.environ['DESCENDANT_PID']).read_text())
            break
        except (FileNotFoundError, ValueError):
            assert parent.poll() is None, 'fixture parent exited during startup'
            assert time.monotonic() < deadline, 'runner workload never became ready'
            time.sleep(0.05)
    assert int(supervisor._stat_fields(runner)[1]) == parent.pid
    parent.kill()
    parent.wait(timeout=5)
    # A non-init adopter really owns the runner, not a mocked getppid value.
    assert os.getpid() != 1
    assert int(supervisor._stat_fields(runner)[1]) == os.getpid()
    deadline = time.monotonic() + 12
    while True:
        waited, status = os.waitpid(runner, os.WNOHANG)
        if waited:
            assert os.waitstatus_to_exitcode(status) == 1, 'main did not unwind on parent loss'
            break
        assert time.monotonic() < deadline, 'main watcher missed non-init adoption'
        time.sleep(0.05)
    deadline = time.monotonic() + 10
    while supervisor.session_groups(runner) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not supervisor.session_groups(runner), 'runner session survived'
    assert gone(worker) and gone(descendant), 'workload survived parent change'
finally:
    parent.kill() if parent.poll() is None else None
    parent.wait(timeout=5)
    if runner is not None:
        for group in supervisor.session_groups(runner):
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
    # Reap adopted workload and watchdog children without leaking zombies.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not waited:
            time.sleep(0.05)
"""


def gone(pid):
    stat = Path("/proc", str(pid), "stat")
    if not stat.exists():
        return True
    return stat.read_text().rsplit(")", 1)[1].split()[0] == "Z"


class SupervisedTeardownTests(unittest.TestCase):
    def test_main_watcher_unwinds_after_non_init_subreaper_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ)
            for name in ("RUNNER_PID", "WORKER_PID", "DESCENDANT_PID",
                         "SUPERVISOR_LOG", "WORKER_LOG"):
                env[name] = str(Path(directory) / name.lower())
            result = subprocess.run([sys.executable, "-I", "-c", SUBREAPER],
                                    env=env, capture_output=True, timeout=50)
            self.assertEqual(result.returncode, 0, result.stderr.decode())

    def spawn_fixture_parent(self, directory, graceful=False):
        private = Path(directory) / "private"
        private.mkdir()
        env = dict(os.environ)
        env.update({
            "SUPERVISOR_LOG": str(Path(directory) / "supervisor.log"),
            "WORKER_LOG": str(Path(directory) / "worker.log"),
            "WORKER_PID": str(private / "worker.pid"),
            "DESCENDANT_PID": str(private / "descendant.pid"),
            "HEARTBEAT_FD": str(private / "heartbeat.fd"),
        })
        if graceful:
            env["GRACEFUL"] = "1"
        parent = subprocess.Popen(
            [sys.executable, "-I", "-c", FAKE_PARENT],
            env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        worker_pid = descendant_pid = None
        while time.monotonic() < deadline:
            try:
                worker_pid = int((private / "worker.pid").read_text())
                descendant_pid = int((private / "descendant.pid").read_text())
                break
            except (FileNotFoundError, ValueError):
                self.assertIsNone(parent.poll(), "fixture parent died before workers started")
                time.sleep(0.05)
        self.assertIsNotNone(worker_pid, "fixture worker never reported its pid")
        self.assertIsNotNone(descendant_pid, "fixture descendant never reported its pid")
        return parent, worker_pid, descendant_pid

    def assert_session_drained(self, parent):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not supervisor.session_groups(parent.pid):
                break
            time.sleep(0.05)
        self.assertEqual(supervisor.session_groups(parent.pid), set(),
                         "surviving groups in the dead parent's session")

    def test_hard_killed_parent_leaves_no_worker_or_descendant_survivor(self):
        # Mirrors kill_on_drop: the only signal the Rust fixture can deliver is
        # SIGKILL to the runner pid alone, while a worker group is mid-flight.
        with tempfile.TemporaryDirectory() as directory:
            parent, worker_pid, descendant_pid = self.spawn_fixture_parent(directory)
            parent.kill()
            parent.wait(timeout=10)
            self.assert_session_drained(parent)
            self.assertTrue(gone(worker_pid), f"worker {worker_pid} survived")
            self.assertTrue(gone(descendant_pid), f"descendant {descendant_pid} survived")

    def test_cancelled_parent_leaves_no_worker_or_descendant_survivor(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, worker_pid, descendant_pid = self.spawn_fixture_parent(
                directory, graceful=True)
            parent.terminate()
            self.assertEqual(parent.wait(timeout=15), 0)
            self.assert_session_drained(parent)
            self.assertTrue(gone(worker_pid), f"worker {worker_pid} survived")
            self.assertTrue(gone(descendant_pid), f"descendant {descendant_pid} survived")

    def test_heartbeat_fd_is_not_inherited_by_workers(self):
        # EOF on the supervisor's heartbeat must mean "the parent died". If a
        # worker inherited the write end, a dead parent would never drain.
        with tempfile.TemporaryDirectory() as directory:
            parent, worker_pid, descendant_pid = self.spawn_fixture_parent(directory)
            private = Path(directory) / "private"
            heartbeat_fd = int((private / "heartbeat.fd").read_text())
            target = os.readlink(f"/proc/{parent.pid}/fd/{heartbeat_fd}")
            self.assertTrue(target.startswith("pipe:"), target)
            for pid in (worker_pid, descendant_pid):
                links = {os.readlink(f"/proc/{pid}/fd/{entry}")
                         for entry in os.listdir(f"/proc/{pid}/fd")}
                self.assertNotIn(target, links,
                                 f"{pid} holds the supervisor heartbeat writer")
            parent.kill()
            parent.wait(timeout=10)
            self.assert_session_drained(parent)

    def test_supervisor_exits_promptly_after_parent_death(self):
        with tempfile.TemporaryDirectory() as directory:
            parent, _, _ = self.spawn_fixture_parent(directory)
            parent.kill()
            parent.wait(timeout=10)
            self.assert_session_drained(parent)
            log = Path(directory) / "supervisor.log"
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and "drained" not in (
                    log.read_text() if log.exists() else ""):
                time.sleep(0.1)
            self.assertIn("drained", log.read_text())


if __name__ == "__main__":
    unittest.main()
