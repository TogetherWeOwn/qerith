"""Actions-only regressions; no production endpoint or provider is contacted."""

import copy
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contract import PROFILES, ROWS, missing_result, passed
from relay import Relay, loopback_upstream
from runner import artifact_hashes, profile_environment, run_bounded


class ManifestTests(unittest.TestCase):
    def results(self):
        profiles = [missing_result(p, "not started") for p in PROFILES]
        for profile in profiles:
            profile["exit_code"] = 0
            for row in profile["rows"]:
                row["outcome"] = "pass"
        return profiles

    def test_every_declared_must_pass_row_is_fail_closed(self):
        baseline = self.results()
        self.assertTrue(passed(baseline))
        for index in (1, 3):
            for row in range(len(ROWS)):
                for outcome in ("fail", "unqualified"):
                    changed = copy.deepcopy(baseline)
                    changed[index]["rows"][row]["outcome"] = outcome
                    self.assertFalse(passed(changed), (index, row, outcome))

    def test_missing_duplicate_reordered_or_relabelled_rows_fail(self):
        for index in range(len(PROFILES)):
            changed = self.results()
            changed[index]["rows"].pop()
            self.assertFalse(passed(changed))
            changed = self.results()
            changed[index]["rows"][0]["id"] = "not-a-declared-row"
            self.assertFalse(passed(changed))
            changed = self.results()
            changed[index]["rows"][0]["must_pass"] = not changed[index]["rows"][0]["must_pass"]
            self.assertFalse(passed(changed))
        self.assertFalse(passed(self.results()[:-1]))
        changed = self.results()
        changed[1]["exit_code"] = 1
        self.assertFalse(passed(changed))

    def test_default_failure_never_becomes_default_support(self):
        results = self.results()
        for index in (0, 2):
            results[index] = missing_result(PROFILES[index], "default framing unsupported")
        self.assertTrue(passed(results))
        self.assertFalse(results[0]["qualified"])
        self.assertTrue(all(row["outcome"] == "unqualified" for row in results[0]["rows"]))

    def test_artifacts_have_content_hashes_not_self_referential_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "trace.bin").write_bytes(b"abc")
            (root / "manifest.json").write_text("{}")
            (root / "private").mkdir()
            (root / "private" / "key.pem").write_text("not an artifact")
            self.assertEqual(artifact_hashes(root), {
                "trace.bin": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            })


class WorkflowTests(unittest.TestCase):
    def test_runner_context_is_not_used_in_job_environment(self):
        workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml"
        job = workflow.read_text().split("  archive-clients:\n", 1)[1]
        header = job.split("    steps:\n", 1)[0]
        self.assertNotIn("${{ runner.", header)
        self.assertIn('export QERITH_CLIENT_PRIVATE_DIR="$RUNNER_TEMP/', job)


class IsolationTests(unittest.TestCase):
    def test_environment_strips_ambient_credentials_proxies_and_plugins(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {
                "AWS_SESSION_TOKEN": "do-not-forward", "AWS_PROFILE": "production",
                "AWS_ENDPOINT_URL": "https://unrelated.invalid", "AWS_DATA_PATH": "/untrusted",
                "HTTPS_PROXY": "https://proxy.invalid", "PYTHONPATH": "/untrusted",
            }):
                env = profile_environment("cli-default", Path(directory), Path("/cert"),
                                          Path("/aws"), "fixture", "synthetic-random")
            self.assertNotIn("AWS_SESSION_TOKEN", env)
            self.assertNotIn("AWS_PROFILE", env)
            self.assertNotIn("AWS_ENDPOINT_URL", env)
            self.assertNotIn("AWS_DATA_PATH", env)
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("PYTHONPATH", env)
            self.assertEqual(env["AWS_ACCESS_KEY_ID"], "fixture")
            config = Path(env["AWS_CONFIG_FILE"]).read_text()
            self.assertNotIn("checksum", config)
            self.assertNotIn("retry", config)
            self.assertNotIn("signing", config)

    def test_restrictive_profile_preserves_required_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            env = profile_environment("cli-restrictive", Path(directory), Path("/cert"),
                                      Path("/aws"), "fixture", "synthetic-random")
            text = Path(env["AWS_CONFIG_FILE"]).read_text()
            self.assertIn("request_checksum_calculation = when_required", text)
            self.assertIn("payload_signing_enabled = true", text)
            self.assertNotIn("never", text)

    def test_timeout_terminates_process_group(self):
        # A child creates another process in its group. Both must be reaped on timeout.
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            pidfile = path / "descendant.pid"
            source = ("import subprocess,sys,time,pathlib; "
                      "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                      "pathlib.Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)")
            with self.assertRaises(subprocess.TimeoutExpired):
                run_bounded([sys.executable, "-I", "-c", source, str(pidfile)],
                            dict(os.environ), path / "process.log", 2)
            pid = int(pidfile.read_text())
            state = Path(f"/proc/{pid}/stat")
            # An orphan zombie may await the runner's init; it is no longer executing.
            self.assertTrue(not state.exists() or state.read_text().split()[2] == "Z")

    def test_upstream_rejects_public_hosts_and_ambiguous_urls(self):
        self.assertEqual(loopback_upstream("http://127.0.0.1:1234"), ("127.0.0.1", 1234))
        for url in ("http://example.com:80", "http://192.0.2.1:80", "https://127.0.0.1:1",
                    "http://127.0.0.1", "http://user@127.0.0.1:1", "http://127.0.0.1:1/path",
                    "http://127.0.0.1:1?x", "http://127.0.0.1:1#x"):
            with self.assertRaises((ValueError, TypeError), msg=url):
                loopback_upstream(url)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.environ.get("GITHUB_ACTIONS"), "true", "tests run only in Actions")
        self.cert, self.key = os.environ["QERITH_CLIENT_CERT"], os.environ["QERITH_CLIENT_KEY"]

    def exchange(self, request):
        upstream = socket.socket()
        upstream.bind(("127.0.0.1", 0))
        upstream.listen(1)
        upstream.settimeout(5)
        received, errors = [], []
        response = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"

        def serve():
            try:
                connection, _ = upstream.accept()
                with connection:
                    connection.settimeout(5)
                    data = b""
                    while len(data) < len(request):
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    received.append(data)
                    connection.sendall(response)
            except Exception as error:
                errors.append(error)
            finally:
                upstream.close()

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory() as directory:
            with Relay(f"http://127.0.0.1:{upstream.getsockname()[1]}", self.cert, self.key, directory) as relay:
                context = ssl.create_default_context(cafile=self.cert)
                with socket.create_connection(("127.0.0.1", int(relay.endpoint.rsplit(":", 1)[1])), timeout=5) as raw:
                    with context.wrap_socket(raw, server_hostname="localhost") as tls:
                        tls.sendall(request)
                        actual = b""
                        while len(actual) < len(response):
                            actual += tls.recv(4096)
                        self.assertEqual(actual, response)
            thread.join(timeout=6)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(relay.errors, [])
            self.assertEqual(received, [request])
            self.assertEqual((Path(directory) / "connection-0001.request.bin").read_bytes(), request)
            self.assertEqual((Path(directory) / "connection-0001.response.bin").read_bytes(), response)

    def test_raw_signing_target_header_order_and_opaque_body_preserved(self):
        self.exchange(b"PUT /bucket/a//b/../%2F+%20%C3%A9?z=2&z=1&x=%252F HTTP/1.1\r\n"
                      b"hOsT: localhost:4321\r\nX-Amz-Meta-Order: first\r\n"
                      b"X-Amz-Meta-Order: second\r\nExpect: 100-continue\r\n"
                      b"Content-Length: 4\r\n\r\n\x00\xff\r\n")

    def test_chunked_trailers_pass_through_not_normalized_into_supported_upload(self):
        self.exchange(b"PUT /bucket/%252F HTTP/1.1\r\nHost: localhost:4321\r\n"
                      b"Transfer-Encoding: chunked\r\nContent-Encoding: aws-chunked\r\n\r\n"
                      b"3;chunk-signature=synthetic\r\nabc\r\n0\r\nx-amz-checksum-crc32: AAAA\r\n\r\n")

    def test_byte_budget_is_enforced_without_forwarding_excess(self):
        with mock.patch("relay.MAX_STREAM_BYTES", 4):
            # A synthetic peer sends bytes beyond the cap; no public connection exists.
            with tempfile.TemporaryDirectory() as directory:
                upstream = socket.socket()
                upstream.bind(("127.0.0.1", 0))
                upstream.listen(1)
                upstream.settimeout(5)
                with Relay(f"http://127.0.0.1:{upstream.getsockname()[1]}", self.cert, self.key, directory) as relay:
                    context = ssl.create_default_context(cafile=self.cert)
                    with socket.create_connection(("127.0.0.1", int(relay.endpoint.rsplit(":", 1)[1])), timeout=5) as raw:
                        with context.wrap_socket(raw, server_hostname="localhost") as tls:
                            server, _ = upstream.accept()
                            with server:
                                server.settimeout(5)
                                tls.sendall(b"oversize")
                                self.assertEqual(server.recv(100), b"")
                upstream.close()
                self.assertTrue(any("byte budget" in error for error in relay.errors))


if __name__ == "__main__":
    unittest.main()
