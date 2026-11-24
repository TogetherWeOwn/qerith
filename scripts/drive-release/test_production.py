from base64 import b64encode
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from io import StringIO
import os
from pathlib import Path
import re
import runpy
import shlex
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from textwrap import dedent
import unittest
from unittest.mock import MagicMock, Mock, call, patch

import production as prod


ACCOUNT = "1234567890abcdef" * 2
SUBDOMAIN = "synthetic-dedicated"
ORIGIN = "https://qerith-drive-production.synthetic-dedicated.workers.dev"
PIN = {"accountId": ACCOUNT, "workerSubdomain": SUBDOMAIN}
SHARED_ACCOUNT = "b" * 32
SHARED_SUBDOMAIN = "synthetic-shared"
SHARED_ORIGIN = f"https://qerith-drive-production.{SHARED_SUBDOMAIN}.workers.dev"
DISPATCH = {
    "GITHUB_REPOSITORY": "TogetherWeOwn/qerith",
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REF": "refs/heads/main",
    "GITHUB_SHA": "a" * 40,
}
INCIDENT = {
    "DRIVE_PRODUCTION_CF_SWITCH_READ_TOKEN": "r" * 40,
    "DRIVE_PRODUCTION_CF_SWITCH_WRITE_TOKEN": "w" * 40,
}
SHA = DISPATCH["GITHUB_SHA"]
DIGEST = "b" * 64
D1 = "01234567-1234-4321-1234-0123456789ab"
SHARED_PIN = {"mode": "shared-account", "accountId": SHARED_ACCOUNT,
              "workerSubdomain": SHARED_SUBDOMAIN, "d1Id": D1}
UUID = "01234567-ab12-ab12-ab12-0123456789ab"
DB = f"/d1/database/{D1}"
BOOKMARK = "00000000-00000000-00000000-00000000"
RUN_ID = "124"
ATTEMPT = "2"

REPO_ROOT = Path(__file__).resolve().parents[2]


def d1(response):
    return [{"success": True, "results": response}]


def encoded_json(value):
    return b64encode(prod.canonical(value).encode()).decode()


def workflow_jobs():
    workflow = REPO_ROOT / ".github/workflows/deploy-drive-production.yml"
    jobs = re.split(r"(?m)^  ([a-z-]+):\n", workflow.read_text().split("\njobs:\n", 1)[1])
    return dict(zip(jobs[1::2], jobs[2::2], strict=True))


class ProductionFixture(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.boundary = prod.production_boundary({"DRIVE_PRODUCTION_BOUNDARY": encoded_json(PIN)})
        self.credentials = {
            key: str(index) * (43 if key == "owner" else 40)
            for index, key in enumerate(prod.CREDENTIALS, 1)
        }
        self.target = {
            "accountId": ACCOUNT, "worker": prod.NAME, "origin": ORIGIN,
            "d1Id": D1,
            "credentials": {key: prod.fingerprint(value) for key, value in self.credentials.items()},
        }
        self.approval = {
            "sourceSha": SHA, "buildDigest": DIGEST, "stagingRunId": RUN_ID,
            "stagingRunAttempt": int(ATTEMPT), "targetDigest": prod.fingerprint(prod.canonical(self.target)),
            "bookmarkDigest": prod.fingerprint(BOOKMARK), "expiresAt": (self.now + timedelta(minutes=30)).isoformat(),
        }
        self.env = DISPATCH | {
            "DRIVE_PRODUCTION_BOUNDARY": encoded_json(PIN),
            "CHECKED_BUILD_DIGEST": DIGEST, "STAGING_RUN_ID": RUN_ID, "STAGING_RUN_ATTEMPT": ATTEMPT,
            "ACCEPTED_SHA": SHA, "PRODUCTION_ACCEPTED_SHA": SHA,
        }
        self.env.update({name: self.credentials[key] for key, name in prod.CREDENTIALS.items()})
        self.responses = {
            DB: {"uuid": D1, "name": prod.NAME, "version": "production"},
            "/workers/subdomain": {"subdomain": SUBDOMAIN},
            f"{prod.WORKER}/settings": None,
            f"{DB}/query": d1([]),
            f"{DB}/time_travel/bookmark": {"bookmark": BOOKMARK},
        }
        self.read = Mock(side_effect=self.read_provider)
        self.write = Mock()

    def read_provider(self, path, **_):
        return self.responses[path]

    def release_env(self):
        return self.env | {"DRIVE_PRODUCTION_TARGET": encoded_json(self.target),
                           "DRIVE_PRODUCTION_APPROVAL": prod.canonical(self.approval)}

    def gate(self):
        return prod.target_and_approval(self.boundary, self.release_env(), SHA, self.now)

    def use_shared_account(self):
        self.enterContext(patch.multiple(prod, SHARED_ACCOUNT=SHARED_ACCOUNT, SHARED_SUBDOMAIN=SHARED_SUBDOMAIN))
        self.env["DRIVE_PRODUCTION_BOUNDARY"] = encoded_json(SHARED_PIN)
        self.boundary = prod.production_boundary(self.env)
        self.responses["/workers/subdomain"] = {"subdomain": SHARED_SUBDOMAIN}
        self.target.update(accountId=SHARED_ACCOUNT, origin=SHARED_ORIGIN)
        self.approve_target()

    def approve_target(self):
        self.approval["targetDigest"] = prod.fingerprint(prod.canonical(self.target))


class ProductionTests(ProductionFixture):
    def test_both_operations_refuse_missing_invalid_or_shared_pin_before_provider_access(self):
        invalid_json = (
            "", "null", "[]", "{", " " * 4097, "[" * 2000,
            prod.canonical({"accountId": ACCOUNT}),
            prod.canonical(PIN | {"origin": ORIGIN}),
            prod.canonical({"accountId": prod.SHARED_ACCOUNT, "workerSubdomain": prod.SHARED_SUBDOMAIN}),
            '{"accountId":"' + ACCOUNT + '","workerSubdomain":"first","workerSubdomain":"second"}',
            *(prod.canonical(PIN | {"accountId": account}) for account in
              (prod.SHARED_ACCOUNT, ACCOUNT.upper(), ACCOUNT[:-1], ACCOUNT + "\n", 123)),
            *(prod.canonical(PIN | {"workerSubdomain": label}) for label in
              (prod.SHARED_SUBDOMAIN, "Uppercase", "a.b", "-a", "a-", "a" * 64, "a\n", "é", True)),
        )
        invalid = (
            None, "", "not-base64", prod.canonical(PIN), encoded_json(PIN) + "\n",
            *(b64encode(pin.encode()).decode() for pin in invalid_json),
        )
        for operation in ("release", "switch-off"):
            for pin in invalid:
                env = self.release_env() | INCIDENT
                env.pop("DRIVE_PRODUCTION_BOUNDARY")
                if pin is not None:
                    env["DRIVE_PRODUCTION_BOUNDARY"] = pin
                with self.subTest(operation=operation, pin=pin), \
                     patch.object(sys, "argv", ["production.py", operation]), \
                     patch.object(prod.HTTPS, "open") as request, patch.object(prod, "cloud_run") as command:
                    with self.assertRaisesRegex(SystemExit, "production boundary"):
                        prod.main(env)
                    request.assert_not_called()
                    command.assert_not_called()

    def test_release_refuses_pin_account_or_origin_mismatch_before_provider_access(self):
        for pin in (PIN | {"accountId": "c" * 32}, PIN | {"workerSubdomain": "another-dedicated"}):
            env = self.release_env() | {"DRIVE_PRODUCTION_BOUNDARY": encoded_json(pin)}
            with self.subTest(pin=pin), patch.object(sys, "argv", ["production.py", "release"]), \
                 patch.object(prod.HTTPS, "open") as request, patch.object(prod, "cloud_run") as command:
                with self.assertRaisesRegex(SystemExit, "pinned release namespace"):
                    prod.main(env)
                request.assert_not_called()
                command.assert_not_called()

    def test_shared_path_refuses_wrong_pair_mode_or_incomplete_pin_for_both_operations(self):
        # Exercise old and new shapes against the same synthetic shared identity.
        self.use_shared_account()
        for pin in (
            {"accountId": SHARED_ACCOUNT, "workerSubdomain": SHARED_SUBDOMAIN},
            {key: value for key, value in SHARED_PIN.items() if key != "d1Id"},
            SHARED_PIN | {"mode": "dedicated"}, SHARED_PIN | {"accountId": ACCOUNT},
            SHARED_PIN | {"workerSubdomain": SUBDOMAIN}, SHARED_PIN | {"origin": SHARED_ORIGIN},
            *(SHARED_PIN | {"d1Id": value} for value in
              (None, "", D1.upper(), prod.STAGING_DB, "00000000-0000-0000-0000-000000000000")),
        ):
            env = self.release_env() | INCIDENT | {"DRIVE_PRODUCTION_BOUNDARY": encoded_json(pin)}
            for operation in ("release", "switch-off"):
                with self.subTest(pin=pin, operation=operation), \
                     patch.object(sys, "argv", ["production.py", operation]), \
                     patch.object(prod.HTTPS, "open") as request, patch.object(prod, "cloud_run") as command:
                    with self.assertRaisesRegex(SystemExit, "production boundary"):
                        prod.main(env)
                    request.assert_not_called()
                    command.assert_not_called()

    def test_shared_release_refuses_staging_or_different_d1_even_with_matching_approval_digest(self):
        self.use_shared_account()
        target = self.target.copy()
        for key, value in (
            ("accountId", ACCOUNT), ("worker", "qerith-drive-staging"),
            ("origin", f"https://qerith-drive-staging.{SHARED_SUBDOMAIN}.workers.dev"),
            ("d1Id", prod.STAGING_DB), ("d1Id", UUID), ("d1Id", None),
            ("r2Bucket", "qerith-drive-staging"), ("storageEpoch", "prod-first"),
        ):
            self.target = target | {key: value}
            self.approve_target()
            with self.subTest(key=key, value=value), patch.object(sys, "argv", ["production.py", "release"]), \
                 patch.object(prod.HTTPS, "open") as request, patch.object(prod, "cloud_run") as command:
                with self.assertRaisesRegex(SystemExit, "pinned release namespace"):
                    prod.main(self.release_env())
                request.assert_not_called()
                command.assert_not_called()

    def test_switch_off_workflow_uses_only_protected_inputs_and_does_not_log_them(self):
        self.assert_protected_switch_off(PIN, ACCOUNT, SUBDOMAIN, ORIGIN,
                                         lambda script: runpy.run_path(str(script), run_name="__main__"))

    def test_shared_switch_off_uses_only_durable_pin_and_incident_credentials(self):
        self.use_shared_account()
        self.assert_protected_switch_off(SHARED_PIN, SHARED_ACCOUNT, SHARED_SUBDOMAIN, SHARED_ORIGIN,
                                         lambda _: prod.main(os.environ))

    def assert_protected_switch_off(self, pin, account, subdomain, origin, run):
        job = workflow_jobs()["switch-off"]
        self.assertIn("    needs: preflight\n    if: inputs.operation == 'switch-off'\n    environment: production\n", job)
        mapping = dict(re.findall(r"(?m)^          (\w+): (\$\{\{.*\}\})$", job.split("        env:\n", 1)[1]))
        secret_values = INCIDENT | {"DRIVE_PRODUCTION_BOUNDARY": encoded_json(pin)}
        self.assertEqual(mapping, {name: "${{ secrets." + name + " }}" for name in secret_values})
        command = shlex.split(job.split("        run: ", 1)[1])
        self.assertEqual(command, ["python3", "-EsB", "scripts/drive-release/production.py", "switch-off"])
        api = f"https://api.cloudflare.com/client/v4/accounts/{account}"
        state = {"enabled": False, "previews_enabled": False}
        read_token, write_token = INCIDENT.values()
        requests = iter([
            (api + "/workers/subdomain", "GET", read_token, None, {"subdomain": subdomain}),
            (api + prod.WORKER + "/subdomain", "POST", write_token, state, state),
            (api + prod.WORKER + "/subdomain", "GET", read_token, None, state),
        ])

        def provider(request, **_):
            url, method, token, body, result = next(requests)
            self.assertEqual(request.full_url, url)
            self.assertEqual(request.get_method(), method)
            self.assertEqual(request.get_header("Authorization"), f"Bearer {token}" if token else None)
            self.assertEqual(prod.json_object(request.data) if request.data else None, body)
            response = MagicMock()
            response.__enter__.return_value = response
            response.read.return_value = prod.canonical({"success": True, "errors": [], "result": result}).encode()
            return response

        def curl(args, **options):
            self.assertRegex(args[-1], rf"^{re.escape(origin)}/sign-in\?qerith_probe=[a-f0-9]{{32}}$")
            self.assertEqual(options["env"], {})
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            self.assertEqual(options["stdout"], subprocess.PIPE)
            self.assertIsNone(next(requests, None), "Origin probed before provider flag readback")
            return subprocess.CompletedProcess(args, 0, stdout=b"404\nDYNAMIC")

        output = StringIO()
        with patch.object(sys, "argv", command[2:]), patch.dict(os.environ, DISPATCH | secret_values, clear=True), \
             patch("urllib.request.OpenerDirector.open", side_effect=provider) as request, \
             patch.object(subprocess, "run", side_effect=curl) as probe, \
             redirect_stdout(output), redirect_stderr(output):
            run(REPO_ROOT / command[2])
        self.assertEqual(request.call_count, 3)
        probe.assert_called_once()
        self.assertEqual(output.getvalue(), "Production Worker route switched off. Provider and origin deny serving.\n")
        for value in (*secret_values.values(), prod.canonical(pin), *pin.values(), origin):
            self.assertNotIn(value, output.getvalue())

    def test_workflow_rejects_unprotected_inputs_without_printing_them(self):
        jobs = workflow_jobs()
        preflight = jobs["preflight"]
        self.assertIn("vars.DRIVE_PRODUCTION_BOUNDARY != '' || secrets.DRIVE_PRODUCTION_BOUNDARY != ''", preflight)
        self.assertIn("secrets.DRIVE_PRODUCTION_CF_SWITCH_READ_TOKEN != '' || secrets.DRIVE_PRODUCTION_CF_SWITCH_WRITE_TOKEN != ''", preflight)
        scope_guard = dedent(preflight.split("        run: |\n", 1)[1].split("      - uses:", 1)[0])
        for boundary, incident in ((False, False), (True, False), (False, True)):
            with self.subTest(boundary=boundary, incident=incident):
                result = subprocess.run(
                    ["/bin/bash", "-e", "-o", "pipefail", "-c", scope_guard], capture_output=True, timeout=5,
                    env={"UNPROTECTED_BOUNDARY": str(boundary).lower(), "UNPROTECTED_INCIDENT": str(incident).lower()},
                )
                self.assertEqual(result.returncode, int(boundary or incident))
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, (
                    b"Production boundary and incident inputs must be set only in the production environment.\n"
                    if boundary or incident else b""
                ))

    def test_deploy_step_receives_only_reviewed_worker_d1_and_bootstrap_inputs(self):
        job = workflow_jobs()["deploy"]
        self.assertIn("    if: inputs.operation == 'release'\n    environment: production\n", job)
        deploy = job.split("      - name: Prove empty D1 and snapshot, then migrate and activate\n", 1)[1]
        mapping = dict(re.findall(r"(?m)^          (\w+): (\$\{\{.*\}\})$", deploy))
        self.assertEqual(mapping, {
            "CHECKED_BUILD_DIGEST": "${{ steps.recheck.outputs.build_digest }}",
            "ACCEPTED_SHA": "${{ inputs.accepted_sha }}",
            "PRODUCTION_ACCEPTED_SHA": "${{ vars.PRODUCTION_ACCEPTED_SHA }}",
            "STAGING_RUN_ID": "${{ inputs.staging_run_id }}",
            "STAGING_RUN_ATTEMPT": "${{ inputs.staging_run_attempt }}",
            "DRIVE_PRODUCTION_APPROVAL": "${{ vars.DRIVE_PRODUCTION_APPROVAL }}",
            **{name: "${{ secrets." + name + " }}" for name in
               ("DRIVE_PRODUCTION_BOUNDARY", "DRIVE_PRODUCTION_TARGET", *prod.CREDENTIALS.values())},
        })

    def test_switch_off_refuses_missing_or_identical_incident_credentials(self):
        for env in (self.release_env(), self.env | dict.fromkeys(INCIDENT, "r" * 40)):
            with patch.object(sys, "argv", ["production.py", "switch-off"]), \
                 patch.object(prod.HTTPS, "open") as request, \
                 self.assertRaisesRegex(SystemExit, "incident read and write credentials"):
                prod.main(env)
            request.assert_not_called()

    def test_switch_off_refuses_different_provider_namespace_before_write(self):
        self.responses["/workers/subdomain"] = {"subdomain": "another-account"}
        with patch.object(prod, "probe_status") as probe, self.assertRaisesRegex(SystemExit, "namespace differs"):
            prod.switch_off(self.boundary, self.read, self.write)
        self.write.assert_not_called()
        probe.assert_not_called()

    def test_d1_metadata_uses_the_pinned_account(self):
        with patch.object(prod.HTTPS, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = (
                b'{"success":true,"errors":[],"result":{}}'
            )
            prod.cloudflare(self.boundary, self.credentials["cfRead"], DB)
        sent = request.call_args.args[0]
        self.assertEqual(sent.full_url, f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}{DB}")

    def test_null_worker_settings_success_is_incomplete_presence_evidence(self):
        with patch.object(prod.HTTPS, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = (
                b'{"success":true,"errors":[],"result":null}'
            )
            with self.assertRaisesRegex(SystemExit, "Worker presence evidence is incomplete"):
                prod.cloudflare(self.boundary, self.credentials["cfRead"], f"{prod.WORKER}/settings", missing_worker=True)

    def test_accepts_only_reviewed_exact_target_secrets_and_approval(self):
        self.assertEqual(self.gate(), (self.target, self.credentials, self.approval))
        for key, value in (("origin", "https://qerith-drive-staging.5150.workers.dev"),
                           ("d1Id", prod.STAGING_DB)):
            original = self.target[key]
            self.target[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "pinned release namespace"):
                self.gate()
            self.target[key] = original
        changed = prod.CREDENTIALS["cfDeploy"]
        self.env[changed] = "D" * 40
        with self.assertRaisesRegex(SystemExit, "reviewed custody evidence"):
            self.gate()

    def test_rejects_approval_for_different_build_run_target_or_expiry(self):
        for key, value in (
            ("sourceSha", "c" * 40), ("buildDigest", "c" * 64), ("stagingRunId", "125"),
            ("stagingRunAttempt", 1), ("targetDigest", "e" * 64), ("bookmarkDigest", ""),
            ("expiresAt", self.now.isoformat()), ("expiresAt", (self.now + timedelta(days=1)).isoformat()),
        ):
            original = self.approval[key]
            self.approval[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "independent approval"):
                self.gate()
            self.approval[key] = original

    def test_rejects_wrong_provider_scope_and_existing_worker(self):
        prod.verify_targets(self.boundary, self.read, DB)
        for path, response in (
            (DB, {"uuid": prod.STAGING_DB, "name": prod.NAME, "version": "production"}),
            (DB, {"uuid": D1, "name": prod.NAME, "version": "alpha"}),
            ("/workers/subdomain", {"subdomain": "another-account"}),
            (f"{prod.WORKER}/settings", {}),
        ):
            original = self.responses[path]
            self.responses[path] = response
            with self.subTest(path=path), self.assertRaises(SystemExit):
                prod.verify_targets(self.boundary, self.read, DB)
            self.responses[path] = original

    def test_sql_read_disallows_any_application_schema_even_without_rows(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)")
            self.assertEqual(db.execute(prod.PRISTINE_SCHEMA).fetchall(), [])
            db.execute("CREATE TABLE drive_principals (name TEXT)")
            self.assertEqual(db.execute(prod.PRISTINE_SCHEMA).fetchall(), [(1,)])
            db.execute("INSERT INTO drive_principals VALUES ('synthetic')")
            self.assertEqual(db.execute(prod.PRISTINE_SCHEMA).fetchall(), [(1,)])
            db.execute("DROP TABLE drive_principals")
            db.execute("CREATE TABLE d1_migrations (id INTEGER)")
            self.assertEqual(db.execute(prod.PRISTINE_SCHEMA).fetchall(), [(1,)])

    def test_rejects_bookmark_that_changes_across_empty_schema_read(self):
        read = Mock(side_effect=[{"bookmark": BOOKMARK}, d1([]), {"bookmark": "different-bookmark"}])
        with self.assertRaisesRegex(SystemExit, "Time Travel snapshot"):
            prod.verify_snapshot(read, DB, self.approval["bookmarkDigest"])

    def test_never_treats_missing_or_malformed_scope_evidence_as_empty(self):
        self.responses[f"{DB}/query"] = [{"success": False, "results": []}]
        with self.assertRaisesRegex(SystemExit, "read-only evidence"):
            prod.verify_snapshot(self.read, DB, self.approval["bookmarkDigest"])
        self.assertEqual(self.read.call_count, 2)

    def test_checked_config_keeps_worker_closed_and_deletion_disabled(self):
        config = prod.worker_config(self.boundary, self.target, self.approval)
        self.assertEqual(config["account_id"], ACCOUNT)
        self.assertEqual(config["name"], prod.NAME)
        self.assertFalse(config["workers_dev"])
        self.assertFalse(config["preview_urls"])
        self.assertNotIn("routes", config)
        self.assertNotIn("triggers", config)
        self.assertNotIn("r2_buckets", config)
        self.assertEqual(config["d1_databases"][0]["database_id"], D1)
        self.assertEqual(config["vars"]["DRIVE_ORIGIN"], ORIGIN)
        self.assertEqual(config["vars"]["DRIVE_FIRST_RELEASE_ORIGIN"], ORIGIN)
        self.assertFalse(any(key.startswith("DRIVE_S3_") for key in config["vars"]))
        self.assertEqual(config["vars"]["DRIVE_OWNER_ENROLLMENT_RELEASE"], SHA)
        self.assertFalse(any("DELETION" in key or "DELETE" in key for key in config["vars"]))

    def test_copies_checked_build_compatibility_without_importing_destinations_or_bindings(self):
        date = "2026-08-01"
        flags = ["nodejs_compat", "enable_request_signal", "global_fetch_strictly_public"]
        with TemporaryDirectory() as directory, patch.object(prod, "APP", Path(directory)):
            (prod.APP / prod.BUILD_CONFIG).write_text(prod.canonical({
                "compatibility_date": date, "compatibility_flags": flags,
                "name": "qerith-drive-staging", "vars": {"DRIVE_S3_ENDPOINT": "synthetic"},
            }))
            config = prod.worker_config(self.boundary, self.target, self.approval)
        self.assertEqual(config["compatibility_date"], date)
        self.assertEqual(config["compatibility_flags"], flags)
        self.assertEqual(config["name"], prod.NAME)
        self.assertNotIn("DRIVE_S3_ENDPOINT", config["vars"])

    def test_rejects_extra_bindings_and_wrong_database_on_the_deployed_version(self):
        config = prod.worker_config(self.boundary, self.target, self.approval)
        bindings = [
            {"name": "DB", "type": "d1", "id": D1},
            {"name": "ASSETS", "type": "assets"},
            *[{"name": name, "type": "plain_text", "text": value} for name, value in config["vars"].items()],
            {"name": "DRIVE_OWNER_ENROLLMENT", "type": "secret_text"},
        ]
        self.responses[f"{prod.WORKER}/versions/{UUID}"] = {"id": UUID, "resources": {"bindings": bindings}}
        prod.verify_worker_bindings(self.read, UUID, config)
        bindings[0]["id"] = prod.STAGING_DB
        with self.assertRaisesRegex(SystemExit, "incorrect production bindings"):
            prod.verify_worker_bindings(self.read, UUID, config)
        bindings[0]["id"] = D1
        for name, kind in (("DRIVE_STAGING_DELETE_REQUESTS", "plain_text"),
                           ("DRIVE_S3_ACCESS_KEY_ID", "secret_text")):
            bindings.append({"name": name, "type": kind})
            with self.subTest(name=name), self.assertRaisesRegex(SystemExit, "unexpected"):
                prod.verify_worker_bindings(self.read, UUID, config)
            bindings.pop()

    def test_switch_off_touches_only_dedicated_subdomain_and_verifies_denial(self):
        self.responses[f"{prod.WORKER}/subdomain"] = {"enabled": False, "previews_enabled": False}
        with patch.object(prod, "probe_status", return_value=404) as probe:
            prod.switch_off(self.boundary, self.read, self.write)
        self.write.assert_called_once_with(f"{prod.WORKER}/subdomain", body={"enabled": False, "previews_enabled": False})
        probe.assert_called_once_with(self.boundary, "/sign-in")

    def test_origin_probe_uses_fresh_cache_keys_and_bounded_curl(self):
        urls = set()
        with patch.object(prod.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"404\n")) as run:
            for method, path, flag in (("HEAD", "/sign-in", "--head"),
                                       ("HEAD", "/sign-in", "--head"),
                                       ("GET", "/api/owner/invitations", "--get")):
                self.assertEqual(prod.probe_status(self.boundary, path, method=method), 404)
                url = run.call_args.args[0][-1]
                if method == "HEAD":
                    self.assertRegex(url, rf"^{re.escape(ORIGIN + path)}\?qerith_probe=[a-f0-9]{{32}}$")
                else:
                    self.assertEqual(url, f"{ORIGIN}/api/owner/invitations")
                self.assertNotIn(url, urls)
                urls.add(url)
                command = [
                    "curl", "--disable", flag, "--no-location", "--proto", "=https",
                    "--header", "Cache-Control: no-cache, no-store", "--max-time", "5",
                    "--silent", "--output", "/dev/null",
                    "--write-out", "%{http_code}\n%header{cf-cache-status}", url,
                ]
                run.assert_called_once_with(command, env={}, timeout=6, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True)
                run.reset_mock()

    def test_origin_probe_rejects_unconfirmed_transport_and_cache_status(self):
        for response, expected in (
            (b"404\n", 404), (b"404\nMISS", 404), (b"404\nDYNAMIC", 404), (b"404\nBYPASS", 404),
            (b"200\n", 200), (b"401\n", 401), (b"403\n", 403), (b"302\n", 302),
            (b"404\nHIT", None), (b"404\nSTALE", None), (b"404\nUPDATING", None), (b"404\nREVALIDATED", None),
            (b"404\nEXPIRED", None), (b"404\nUNKNOWN", None), (b"404", None), (b"000\n", None),
        ):
            with self.subTest(response=response), patch.object(
                prod.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=response),
            ):
                self.assertEqual(prod.probe_status(self.boundary, "/sign-in"), expected)
        for error in (subprocess.CalledProcessError(60, [], output=b"404\n"),
                      subprocess.TimeoutExpired([], 6), OSError()):
            with self.subTest(error=type(error)), patch.object(prod.subprocess, "run", side_effect=error):
                self.assertIsNone(prod.probe_status(self.boundary, "/sign-in"))

    def test_switch_off_fails_closed_on_unverified_provider_flags_or_origin(self):
        with patch.object(prod, "probe_status", side_effect=(403, 302, None, 200, None, 403)) as probe, \
             patch.object(prod, "sleep"):
            for enabled, previews in ((True, False), (False, True)):
                self.responses[f"{prod.WORKER}/subdomain"] = {"enabled": enabled, "previews_enabled": previews}
                with self.assertRaisesRegex(SystemExit, "preview isolation could not be verified"):
                    prod.switch_off(self.boundary, self.read, self.write)
            probe.assert_not_called()
            self.responses[f"{prod.WORKER}/subdomain"] = {"enabled": False, "previews_enabled": False}
            with self.assertRaisesRegex(SystemExit, "origin denial was not verified"):
                prod.switch_off(self.boundary, self.read, self.write)
            self.assertEqual(probe.call_count, 6)


class DeploymentOrderTests(ProductionFixture):
    def setUp(self):
        super().setUp()
        build_config = (prod.APP / prod.BUILD_CONFIG).read_bytes()
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        app = Path(directory.name)
        patcher = patch.object(prod, "APP", app)
        patcher.start()
        self.addCleanup(patcher.stop)
        (app / prod.BUILD_CONFIG).write_bytes(build_config)
        (app / prod.ASSETS).mkdir(parents=True)
        (app / prod.PACKAGE).parent.mkdir(parents=True)
        (app / prod.PACKAGE).write_text("export default {}")
        (app / "migrations").mkdir()
        (app / "migrations/0001_identity.sql").write_text("SELECT 1;")
        self.events = []
        self.committed = False
        self.active = False
        self.bindings = prod.worker_config(self.boundary, self.target, self.approval)

    def read_provider(self, path, **options):
        self.events.append((path, options.get("body")))
        if path == f"{DB}/query" and self.committed:
            return d1([{"name": "0001_identity.sql"}])
        if path == f"{prod.WORKER}/subdomain":
            return {"enabled": self.active, "previews_enabled": False}
        if path == f"{prod.WORKER}/deployments":
            return {"deployments": [{"versions": [{"version_id": UUID, "percentage": 100}]}]}
        if path == f"{prod.WORKER}/versions/{UUID}":
            config = self.bindings
            return {"id": UUID, "resources": {"bindings": [
                {"name": "DB", "type": "d1", "id": D1},
                {"name": "ASSETS", "type": "assets"},
                *[{"name": name, "type": "plain_text", "text": value}
                  for name, value in config["vars"].items()],
                {"name": "DRIVE_OWNER_ENROLLMENT", "type": "secret_text"},
            ]}}
        return super().read_provider(path, **options)

    def fake_wrangler(self, args, env, *_):
        if "--dry-run" not in args:
            self.assertEqual(env["CLOUDFLARE_ACCOUNT_ID"], self.boundary.account_id)
            self.assertEqual(env["CLOUDFLARE_API_TOKEN"], self.credentials["cfDeploy"])
        config = prod.json_object(Path(args[args.index("--config") + 1]).read_bytes())
        self.assertEqual(config, self.bindings)
        if "--dry-run" in args:
            self.events.append(("dry-run", args))
            directory = Path(args[args.index("--outdir") + 1])
            directory.mkdir()
            (directory / "_worker.js").write_bytes((prod.APP / prod.PACKAGE).read_bytes())
            self.assertNotIn("CLOUDFLARE_API_TOKEN", env)
        elif args[0] == "d1":
            self.events.append(("d1", args))
            self.committed = True
            self.assertEqual(args[:5], ["d1", "migrations", "apply", "DB", "--remote"])
        else:
            self.events.append(("deploy", args))
            self.assertIn("--no-bundle", args)
            secrets = Path(args[args.index("--secrets-file") + 1])
            self.assertEqual(secrets.stat().st_mode & 0o777, 0o600)
            values = prod.json_object(secrets.read_bytes())
            self.assertEqual(set(values), {"DRIVE_OWNER_ENROLLMENT"})
            self.assertRegex(values["DRIVE_OWNER_ENROLLMENT"], f"^{SHA}:[0-9]{{13}}:{self.credentials['owner']}$")
            record = {"type": "deploy", "worker_name": prod.NAME, "version_id": UUID}
            Path(env["WRANGLER_OUTPUT_FILE_PATH"]).write_text(prod.canonical(record) + "\n")

    def fake_switch(self, path, *, body):
        self.assertEqual(path, f"{prod.WORKER}/subdomain")
        self.active = body["enabled"]
        self.events.append(("switch", self.active))

    def fake_shell_probe(self, args, env, timeout, label, *, failure_hint):
        self.assertEqual(args[:2], ["node", "scripts/production-shell-smoke.mjs"])
        self.assertEqual(prod.json_object(Path(args[2]).read_bytes()), self.bindings)
        self.assertEqual(env, prod.cli_env())
        self.assertEqual(timeout, 60)
        self.assertIn("No provider requests were made.", failure_hint)
        self.events.append(("shell probe", label))

    def promote(self, status=(200, 401)):
        self.write.side_effect = self.fake_switch
        with patch.object(prod, "wrangler", side_effect=self.fake_wrangler), \
             patch.object(prod, "cloud_run", side_effect=self.fake_shell_probe), \
             patch.object(prod, "probe_status", side_effect=status) as probe, patch.object(prod, "sleep"):
            prod.promote(self.boundary, self.target, self.credentials, self.approval, self.read, self.write)
        return probe.call_args_list

    def test_no_write_if_empty_target_or_snapshot_changes(self):
        before = deepcopy(self.responses)
        for path, response in (
            (DB, {"uuid": prod.STAGING_DB, "name": prod.NAME, "version": "production"}),
            (f"{DB}/query", d1([{"present": 1}])),
            (f"{DB}/time_travel/bookmark", {"bookmark": "unapproved-bookmark"}),
        ):
            self.responses[path] = response
            self.events.clear()
            with self.subTest(path=path), self.assertRaises(SystemExit):
                self.promote()
            self.assertFalse(self.committed)
            self.write.assert_not_called()
            self.responses = deepcopy(before)

    def test_migrates_after_snapshot_and_activates_only_verified_closed_version(self):
        probes = self.promote()
        self.assertEqual(probes, [call(self.boundary, "/sign-in"), call(self.boundary, "/api/owner/invitations", method="GET")])
        positions = [key for key, _ in self.events]
        snapshot = f"{DB}/time_travel/bookmark"
        self.assertLess(positions.index("shell probe"), positions.index(DB))
        self.assertEqual(positions.count(snapshot), 2)
        self.assertLess(positions.index(snapshot, positions.index(snapshot) + 1), positions.index("d1"))
        self.assertLess(positions.index("d1"), positions.index("deploy"))
        self.assertLess(positions.index(f"{prod.WORKER}/versions/{UUID}"), positions.index("switch"))
        self.assertLess(positions.index(f"{prod.WORKER}/deployments"), positions.index("switch"))
        self.assertTrue(self.active)

    def test_shell_smoke_failure_refuses_before_any_provider_access(self):
        with patch.object(prod, "wrangler", side_effect=self.fake_wrangler), \
             patch.object(prod, "cloud_run", side_effect=SystemExit("Offline serving probes failed.")), \
             self.assertRaisesRegex(SystemExit, "Offline serving probes failed"):
            prod.promote(self.boundary, self.target, self.credentials, self.approval, self.read, self.write)
        self.read.assert_not_called()
        self.write.assert_not_called()
        self.assertFalse(self.committed)

    def test_worker_that_appears_during_migration_is_never_overwritten(self):
        before = self.read.side_effect

        def read(path, **options):
            if self.committed and path == f"{prod.WORKER}/settings":
                return {}
            return before(path, **options)

        self.read.side_effect = read
        with self.assertRaisesRegex(SystemExit, "prior Worker already exists"):
            self.promote()
        self.assertTrue(self.committed)
        self.assertNotIn("deploy", [key for key, _ in self.events])
        self.write.assert_not_called()

    def test_shared_release_pins_resources_and_private_origin_through_activation(self):
        self.use_shared_account()
        self.bindings = prod.worker_config(self.boundary, self.target, self.approval)
        self.assertEqual(self.bindings["account_id"], SHARED_ACCOUNT)
        self.assertEqual(self.bindings["name"], "qerith-drive-production")
        self.assertFalse(self.bindings["workers_dev"])
        self.assertFalse(self.bindings["preview_urls"])
        self.assertEqual(self.bindings["d1_databases"][0]["database_id"], D1)
        config = self.bindings["vars"]
        for key in ("DRIVE_ORIGIN", "DRIVE_FIRST_RELEASE_ORIGIN"):
            self.assertEqual(config[key], SHARED_ORIGIN)
        self.assertFalse(any(key.startswith("DRIVE_S3_") for key in config))
        self.assertEqual(config["DRIVE_OWNER_ENROLLMENT_RELEASE"], SHA)
        self.assertNotIn("DRIVE_FIRST_RELEASE_SMOKE_TOKEN", config)

        def provider(boundary, token, path, **options):
            self.assertEqual((boundary.account_id, boundary.worker_subdomain, boundary.d1_id),
                             (SHARED_ACCOUNT, SHARED_SUBDOMAIN, D1))
            if token == self.credentials["cfRead"]:
                return self.read(path, **options)
            self.assertEqual(token, self.credentials["cfDeploy"])
            return self.write(path, **options)

        self.write.side_effect = self.fake_switch
        with patch.object(sys, "argv", ["production.py", "release"]), \
             patch.object(prod, "cloudflare", side_effect=provider), \
             patch.object(prod, "wrangler", side_effect=self.fake_wrangler), \
             patch.object(prod, "cloud_run", side_effect=self.fake_shell_probe) as shell_probe, \
             patch.object(prod, "probe_status", side_effect=[200, 401]) as probe:
            self.responses[DB]["name"] = "qerith-drive-staging"
            with self.assertRaisesRegex(SystemExit, "D1 identity"):
                prod.main(self.release_env())
            self.assertFalse(self.committed)
            self.write.assert_not_called()
            self.responses[DB]["name"] = prod.NAME
            prod.main(self.release_env())
        self.assertEqual(shell_probe.call_count, 2)
        self.assertEqual(probe.call_args_list, [call(self.boundary, "/sign-in"),
                                               call(self.boundary, "/api/owner/invitations", method="GET")])
        self.assertTrue(self.active)

    def test_failed_serving_probe_switches_the_route_off(self):
        with self.assertRaisesRegex(SystemExit, "Serving probes failed"):
            self.promote([503] * 6 + [404])
        self.assertEqual([event for event in self.events if event[0] == "switch"], [("switch", True), ("switch", False)])
        self.assertFalse(self.active)
