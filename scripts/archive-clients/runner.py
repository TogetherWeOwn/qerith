#!/usr/bin/env -S python3 -I
"""Launched by the ignored Rust fixture. All runtime work belongs in Actions."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from contract import PROFILES, UNQUALIFIED, missing_result, passed
from relay import Relay, loopback_upstream

PROFILE_SECONDS = 100
RUNNER_SECONDS = 440


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def artifact_hashes(evidence):
    hashes = {}
    for path in sorted(evidence.rglob("*")):
        relative = path.relative_to(evidence)
        if path.is_file() and path.name != "manifest.json" and "private" not in relative.parts:
            with path.open("rb") as stream:
                hashes[str(relative)] = hashlib.file_digest(stream, "sha256").hexdigest()
    return hashes


def run_bounded(command, env, output, seconds):
    with output.open("wb") as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            return process.wait(timeout=seconds)
        finally:
            # The worker may have launched a CLI subprocess. Always reap the group,
            # including when the worker exits early, times out or receives SIGTERM.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
            # A leader can exit before its descendants. Do not leave that group alive.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def profile_environment(profile, private, cert, cli, access_key, secret_key):
    home = private / profile
    home.mkdir(parents=True)
    config = home / "config"
    restrictive = profile.endswith("restrictive")
    text = "[default]\nregion = us-east-1\n"
    if restrictive:
        text += ("retry_mode = standard\nmax_attempts = 1\n"
                 "request_checksum_calculation = when_required\n"
                 "response_checksum_validation = when_required\n"
                 "s3 =\n    addressing_style = path\n    payload_signing_enabled = true\n")
    config.write_text(text)
    # No ambient credentials, profiles, proxies, AWS_DATA_PATH, service endpoints,
    # plugin config or user Python imports reach a client. Only the Rust fixture's
    # synthetic credentials are passed explicitly, never a usable AWS account.
    return {
        "PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8",
        "AWS_CONFIG_FILE": str(config), "AWS_SHARED_CREDENTIALS_FILE": str(home / "absent"),
        "AWS_ACCESS_KEY_ID": access_key,
        "AWS_SECRET_ACCESS_KEY": secret_key,
        "AWS_DEFAULT_REGION": "us-east-1", "AWS_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "true", "AWS_CA_BUNDLE": str(cert),
        "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off",
        "QERITH_CLIENT_CERT": str(cert), "QERITH_AWS_CLI": str(cli),
    }


def initial_manifest(evidence):
    manifest = {
        "schema": "qerith.archive-clients.v1", "head": os.environ["QERITH_EVIDENCE_HEAD"],
        "scope": "synthetic opaque-byte low-level S3 client qualification only",
        "backbone_identity": "simulated; no real independence/readability proof",
        "pins": json.loads((ROOT / "pins.json").read_text()),
        "platform": {"system": platform.platform(), "python": sys.version,
                     "openssl": __import__("ssl").OPENSSL_VERSION},
        "bounds": {"runner_seconds": RUNNER_SECONDS, "profile_seconds": PROFILE_SECONDS,
                   "cli_call_seconds": 20, "control_seconds": 5, "list_pages": 8,
                   "restore_polls": 0, "restore_completion": "one explicit fixture control call"},
        "framing": "raw TLS relay; no translation; chunked/trailers unqualified",
        "profiles": [missing_result(p, "runner not completed") for p in PROFILES],
        "unqualified": list(UNQUALIFIED), "overall": "fail", "artifacts": {},
    }
    write_json(evidence / "manifest.json", manifest)
    return manifest


def execute(args):
    evidence = Path(os.environ["QERITH_CLIENT_EVIDENCE_DIR"]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    manifest = initial_manifest(evidence)
    started = time.monotonic()
    try:
        loopback_upstream(args.upstream)
        assert os.environ.get("GITHUB_ACTIONS") == "true", "runtime is Actions-only"
        pins = manifest["pins"]
        assert platform.python_version() == pins["python"]["version"], "unexpected Python build"
        assert platform.machine() == "x86_64", "unexpected runner architecture"
        installed = {name: importlib.metadata.version(name) for name in (
            "boto3", "botocore", "s3transfer", "jmespath", "python-dateutil", "six", "urllib3", "pip",
        )}
        manifest["python_inventory"] = installed
        assert installed["boto3"] == pins["python"]["boto3"]
        assert installed["botocore"] == pins["python"]["botocore"]
        try:
            importlib.metadata.version("awscrt")
        except importlib.metadata.PackageNotFoundError:
            pass
        else:
            raise AssertionError("unselected Boto3 CRT extra installed")
        cert = Path(os.environ["QERITH_CLIENT_CERT"]).resolve()
        key = Path(os.environ["QERITH_CLIENT_KEY"]).resolve()
        cli = Path(os.environ["QERITH_AWS_CLI"]).resolve()
        manifest["cli_version"] = subprocess.check_output([str(cli), "--version"], timeout=5).decode().strip()
        assert manifest["cli_version"].startswith("aws-cli/" + pins["aws_cli"]["version"] + " ")
        private = Path(os.environ["QERITH_CLIENT_PRIVATE_DIR"]).resolve()
        private.mkdir(parents=True, exist_ok=True)
        access_key = os.environ["AWS_ACCESS_KEY_ID"]
        secret_key = os.environ["AWS_SECRET_ACCESS_KEY"]
        assert access_key == "fixture" and secret_key, "expected Rust-owned synthetic credentials"
        with Relay(args.upstream, cert, key, evidence / "relay") as relay:
            import http.client
            connection = http.client.HTTPConnection(*loopback_upstream(args.upstream), timeout=5)
            try:
                connection.request("POST", "/__fixture/configure",
                                   body=json.dumps({"host": relay.endpoint.removeprefix("https://")}),
                                   headers={"Authorization": f"Bearer {args.control_token}",
                                            "Content-Type": "application/json"})
                response = connection.getresponse()
                body = response.read(65537)
                assert response.status == 200 and len(body) <= 65536
                manifest["configure"] = json.loads(body)
            finally:
                connection.close()
            manifest["endpoint"] = relay.endpoint
            for index, profile in enumerate(PROFILES):
                destination = evidence / profile
                destination.mkdir()
                env = profile_environment(profile, private, cert, cli, access_key, secret_key)
                command = [sys.executable, "-I", str(ROOT / "worker.py"),
                           "--profile", profile, "--endpoint", relay.endpoint,
                           "--upstream", args.upstream, "--control-token", args.control_token,
                           "--evidence", str(destination)]
                try:
                    remaining = RUNNER_SECONDS - (time.monotonic() - started)
                    assert remaining > 0, "runner deadline"
                    code = run_bounded(command, env, destination / "worker.log", min(PROFILE_SECONDS, remaining))
                    manifest["profiles"][index]["exit_code"] = code
                except subprocess.TimeoutExpired:
                    manifest["profiles"][index]["error"] = "profile deadline exceeded; process group terminated"
                path = destination / "result.json"
                if path.exists():
                    result = json.loads(path.read_text())
                    manifest["profiles"][index].update(result)
                write_json(evidence / "manifest.json", manifest)
        manifest["relay_errors"] = relay.errors
        manifest["overall"] = "pass" if passed(manifest["profiles"]) and not relay.errors else "fail"
    except BaseException as error:
        # Exception strings may contain subprocess argv, including the fixture control
        # token. Preserve type only here; worker logs already explain synthetic rows.
        manifest["runner_error"] = type(error).__name__
        manifest["overall"] = "fail"
        raise
    finally:
        manifest["elapsed_seconds"] = round(time.monotonic() - started, 3)
        manifest["artifacts"] = artifact_hashes(evidence)
        write_json(evidence / "manifest.json", manifest)
    return 0 if manifest["overall"] == "pass" else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--control-token", required=True)
    args = parser.parse_args()

    def terminate(_signal, _frame):
        raise KeyboardInterrupt("runner cancelled")

    signal.signal(signal.SIGTERM, terminate)
    try:
        return execute(args)
    except BaseException as error:
        print(f"archive client runner failed: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
