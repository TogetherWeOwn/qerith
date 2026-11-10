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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from contract import PROFILES, ROWS, missing_result, passed
from relay import Relay, loopback_upstream
from runner import artifact_hashes, finalize_manifest, profile_environment, run_bounded
from worker import Client, Matrix, OPAQUE, control, digest


class GetStatusTests(unittest.TestCase):
    def test_get_rows_require_matching_http_status_before_qualification(self):
        for ranged, expected in ((False, 200), (True, 206)):
            for status in (None, 200, 206, 500):
                with self.subTest(ranged=ranged, status=status), \
                        tempfile.TemporaryDirectory() as directory, \
                        mock.patch("worker.Client") as factory:
                    client = factory.return_value
                    client.sequence, client.settings, client.restrictive = 0, {}, True
                    response = {"Body": OPAQUE[1:32] if ranged else OPAQUE,
                                "ETag": '"baseline"', "ChecksumSHA256": digest(OPAQUE),
                                "ContentRange": f"bytes 1-31/{len(OPAQUE)}"}
                    if status is not None:
                        response["ResponseMetadata"] = {"HTTPStatusCode": status}
                    client.call.return_value = response
                    matrix = Matrix(SimpleNamespace(profile="cli-restrictive"), Path(directory))
                    matrix.baseline = {"ETag": '"baseline"'}
                    action = lambda: matrix.get(ranged=ranged)
                    if status == expected:
                        matrix.row(ROWS[0], action)
                    else:
                        with self.assertRaises(AssertionError):
                            matrix.row(ROWS[0], action)
                    saved = json.loads((Path(directory) / "result.json").read_text())
                    self.assertEqual(saved["rows"][0]["outcome"],
                                     "pass" if status == expected else "fail")
                    self.assertFalse(saved["qualified"])
                    self.assertTrue(all(row["outcome"] == "unqualified"
                                        for row in saved["rows"][1:]))


class CliArgumentTests(unittest.TestCase):
    def test_negative_cli_row_requires_the_declared_http_status(self):
        for wire_status in (None, 404, 403):
            with self.subTest(status=wire_status), tempfile.TemporaryDirectory() as directory:
                client = Client.__new__(Client)
                client.args = SimpleNamespace(endpoint="https://127.0.0.1:443")
                client.evidence, client.sequence, client.restrictive = Path(directory), 0, True
                client.identity, client.client, client.trace, client.settings = "fixture", None, [], {}
                stderr = b"An error occurred (AccessDenied) when calling GetObject"
                if wire_status is not None:
                    stderr += f'\n"GET / HTTP/1.1" {wire_status} '.encode()
                with mock.patch.dict(os.environ, {"QERITH_AWS_CLI": "/synthetic/aws"}), \
                        mock.patch("worker.subprocess.run", return_value=
                                   subprocess.CompletedProcess([], 1, b"", stderr)), \
                        mock.patch("worker.Client", return_value=client):
                    matrix = Matrix(SimpleNamespace(profile="cli-restrictive"), Path(directory))
                    action = lambda: client.expect_error("get_object", ["AccessDenied"], 403)
                    if wire_status == 403:
                        matrix.row(ROWS[0], action)
                        self.assertEqual(matrix.rows[0]["outcome"], "pass")
                    else:
                        with self.assertRaises(AssertionError):
                            matrix.row(ROWS[0], action)
                        saved = json.loads((Path(directory) / "result.json").read_text())
                        self.assertEqual(saved["rows"][0]["outcome"], "fail")
                        self.assertFalse(saved["qualified"])

    def test_copy_source_is_left_unescaped_for_vendor_encoding(self):
        for operation in ("copy_object", "upload_part_copy"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                client = Client.__new__(Client)
                client.args = SimpleNamespace(endpoint="https://127.0.0.1:443")
                client.evidence, client.sequence, client.restrictive = Path(directory), 1, True
                client.identity = "fixture"
                source = {"Bucket": "archive", "Key": "opaque/%2F +/café/../key"}

                def invoke(command, **kwargs):
                    params = json.loads(command[command.index("--cli-input-json") + 1])
                    self.assertEqual(params["CopySource"], "archive/opaque/%2F +/café/../key")
                    self.assertIn("--no-paginate", command)
                    return subprocess.CompletedProcess(command, 0, b"{}", b'"PUT / HTTP/1.1" 200 ')

                with mock.patch.dict(os.environ, {"QERITH_AWS_CLI": "/synthetic/aws"}), \
                        mock.patch("worker.subprocess.run", side_effect=invoke):
                    client.cli(operation, {"Bucket": "archive", "Key": "destination",
                                           "CopySource": source})
                self.assertEqual(source["Key"], "opaque/%2F +/café/../key")

    def test_streaming_get_uses_only_explicit_options_and_positional_outfile(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Client.__new__(Client)
            client.args = SimpleNamespace(endpoint="https://127.0.0.1:443")
            client.evidence, client.sequence, client.restrictive = Path(directory), 1, True
            client.identity = "fixture"

            def invoke(command, **kwargs):
                self.assertEqual(command[command.index("--bucket") + 1], "archive")
                self.assertEqual(command[command.index("--key") + 1], "opaque/%2F +/café/../key")
                self.assertNotIn("--cli-input-json", command)
                for option, value in (("--checksum-mode", "ENABLED"), ("--range", "bytes=1-3"),
                                      ("--if-match", '"exact"'), ("--if-none-match", '"other"')):
                    self.assertEqual(command[command.index(option) + 1], value)
                Path(command[-1]).write_bytes(b"verified octets")
                return subprocess.CompletedProcess(command, 0, b"{}", b'"GET / HTTP/1.1" 200 ')

            with mock.patch.dict(os.environ, {"QERITH_AWS_CLI": "/synthetic/aws"}), \
                    mock.patch("worker.subprocess.run", side_effect=invoke):
                result = client.cli(
                    "get_object", {"Bucket": "archive", "Key": "opaque/%2F +/café/../key",
                                   "ChecksumMode": "ENABLED", "Range": "bytes=1-3",
                                   "IfMatch": '"exact"', "IfNoneMatch": '"other"'})
            self.assertEqual(result["Body"], b"verified octets")
            self.assertEqual(result["ResponseMetadata"]["HTTPStatusCode"], 200)


class DeleteChecksumTests(unittest.TestCase):
    def test_restrictive_delete_selects_sha256_without_changing_defaults(self):
        for profile in PROFILES:
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as directory, \
                    mock.patch("worker.Client") as factory:
                client = factory.return_value
                client.restrictive = profile.endswith("restrictive")

                def invoke(operation, **parameters):
                    if operation == "delete_objects":
                        if client.restrictive:
                            self.assertEqual(parameters["ChecksumAlgorithm"], "SHA256")
                        else:
                            self.assertNotIn("ChecksumAlgorithm", parameters)
                        return {"Deleted": parameters["Delete"]["Objects"]}
                    return {}

                client.call.side_effect = invoke
                matrix = Matrix(SimpleNamespace(profile=profile), Path(directory))
                matrix.delete()
                client.expect_error.assert_called_once_with(
                    "get_object", ["NoSuchKey"], 404, **matrix.object)


class FixtureControlTests(unittest.TestCase):
    def test_every_profile_resets_before_its_first_s3_request(self):
        for profile in PROFILES:
            events = []
            with tempfile.TemporaryDirectory() as directory, mock.patch("worker.Client") as factory:
                client = factory.return_value
                client.sequence, client.settings = 0, {}
                client.restrictive = profile.endswith("restrictive")

                def stop_at_first_call(*_args, **_kwargs):
                    events.append("s3")
                    raise RuntimeError("stop after first S3 call")

                client.call.side_effect = stop_at_first_call
                args = SimpleNamespace(profile=profile)
                matrix = Matrix(args, Path(directory))
                with mock.patch("worker.control", side_effect=lambda _args, command:
                                events.append(command) or {"ok": True}) as fixture:
                    with self.assertRaisesRegex(RuntimeError, "stop after first S3 call"):
                        matrix.run()
                self.assertEqual(events, ["reset", "s3"])
                fixture.assert_called_once_with(args, "reset")
                self.assertEqual(matrix.rows[0]["id"], "reset-fixture")
                self.assertEqual(matrix.rows[0]["outcome"], "pass")

    def test_failed_reset_prevents_all_s3_requests(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch("worker.Client") as factory:
            client = factory.return_value
            client.sequence, client.settings, client.restrictive = 0, {}, True
            matrix = Matrix(SimpleNamespace(profile="cli-restrictive"), Path(directory))
            with mock.patch("worker.control", side_effect=AssertionError("reset failed")):
                with self.assertRaisesRegex(AssertionError, "reset failed"):
                    matrix.run()
            client.call.assert_not_called()
            result = json.loads((Path(directory) / "result.json").read_text())
            self.assertEqual(result["rows"][0]["outcome"], "fail")
            self.assertTrue(all(r["outcome"] == "unqualified" for r in result["rows"][1:]))

    def test_controls_require_bounded_json_success_and_bearer_auth(self):
        args = SimpleNamespace(upstream="http://127.0.0.1:1234", control_token="synthetic")
        for body, status in ((b'{"ok":true}', 200), (b'{"ok":false}', 200),
                             (b'{}', 200), (b'[]', 200), (b'{"ok":true}', 500),
                             (b' ' * 65537, 200)):
            with mock.patch("worker.http.client.HTTPConnection") as factory:
                connection = factory.return_value
                response = connection.getresponse.return_value
                response.status, response.read.return_value = status, body
                if body == b'{"ok":true}' and status == 200:
                    self.assertEqual(control(args, "reset"), {"ok": True})
                else:
                    with self.assertRaises(AssertionError):
                        control(args, "reset")
                factory.assert_called_once_with("127.0.0.1", 1234, timeout=5)
                connection.request.assert_called_once_with("POST", "/__fixture/reset", body=b"",
                    headers={"Authorization": "Bearer synthetic"})
                response.read.assert_called_once_with(65537)
                connection.close.assert_called_once_with()


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

    def test_finalization_hashes_fixture_exit_trace_without_promoting_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trace = root / "service-trace.json"
            trace.write_text('{"stage":"before runner exit"}')
            data = {"head": "tested-head", "overall": "fail", "profiles": self.results(),
                    "artifacts": artifact_hashes(root)}
            before = data["artifacts"]["service-trace.json"]
            trace.write_text('{"stage":"after fixture exit"}')
            (root / "manifest.json").write_text(json.dumps(data))
            self.assertFalse(finalize_manifest(root, "tested-head"))
            saved = json.loads((root / "manifest.json").read_text())
            self.assertEqual(saved["overall"], "fail")
            self.assertNotEqual(saved["artifacts"]["service-trace.json"], before)
            self.assertEqual(saved["artifacts"], artifact_hashes(root))
            saved["overall"] = "pass"
            (root / "manifest.json").write_text(json.dumps(saved))
            self.assertFalse(finalize_manifest(root, "different-head"))
            self.assertTrue(finalize_manifest(root, "tested-head"))
            saved["profiles"][1]["rows"][0]["outcome"] = "fail"
            (root / "manifest.json").write_text(json.dumps(saved))
            self.assertFalse(finalize_manifest(root, "tested-head"))

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
        self.assertIn('path: ${{ env.QERITH_CLIENT_EVIDENCE_DIR }}\n', job)
        self.assertNotIn('path: ${{ env.QERITH_CLIENT_EVIDENCE_DIR }}/', job)


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
                context.minimum_version = ssl.TLSVersion.TLSv1_2
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
                    context.minimum_version = ssl.TLSVersion.TLSv1_2
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
