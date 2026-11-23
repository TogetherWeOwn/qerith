from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import sqlite3
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, Mock, call, patch

import production as prod


ACCOUNT = "1234567890abcdef" * 2
SUBDOMAIN = "synthetic-dedicated"
ORIGIN = "https://qerith-drive-production.synthetic-dedicated.workers.dev"
ENDPOINT = "https://1234567890abcdef1234567890abcdef.r2.cloudflarestorage.com"
PIN = {"accountId": ACCOUNT, "workerSubdomain": SUBDOMAIN}
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
UUID = "01234567-ab12-ab12-ab12-0123456789ab"
DB = f"/d1/database/{D1}"
BOOKMARK = "00000000-00000000-00000000-00000000"
RUN_ID = "124"
ATTEMPT = "2"

OBJECTS = {"Name": prod.NAME, "KeyCount": 0, "IsTruncated": False}
MULTIPART = {"Bucket": prod.NAME, "IsTruncated": False}


def d1(response):
    return [{"success": True, "results": response}]


class ProductionFixture(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.boundary = prod.production_boundary({"DRIVE_PRODUCTION_BOUNDARY": prod.canonical(PIN)})
        self.credentials = {
            key: tuple(str(index) * (43 if key == "owner" else 40) for _ in names)
            for index, (key, names) in enumerate(prod.CREDENTIALS.items(), 1)
        }
        self.target = {
            "accountId": ACCOUNT, "worker": prod.NAME, "origin": ORIGIN,
            "d1Id": D1, "r2Bucket": prod.NAME, "storageEpoch": "prod-first",
            "credentials": {key: prod.fingerprint("\0".join(values)) for key, values in self.credentials.items()},
        }
        self.approval = {
            "sourceSha": SHA, "buildDigest": DIGEST, "stagingRunId": RUN_ID,
            "stagingRunAttempt": int(ATTEMPT), "targetDigest": prod.fingerprint(prod.canonical(self.target)),
            "bookmarkDigest": prod.fingerprint(BOOKMARK), "expiresAt": (self.now + timedelta(minutes=30)).isoformat(),
        }
        self.env = DISPATCH | {
            "DRIVE_PRODUCTION_BOUNDARY": prod.canonical(PIN),
            "CHECKED_BUILD_DIGEST": DIGEST, "STAGING_RUN_ID": RUN_ID, "STAGING_RUN_ATTEMPT": ATTEMPT,
            "ACCEPTED_SHA": SHA, "PRODUCTION_ACCEPTED_SHA": SHA,
        }
        for key, names in prod.CREDENTIALS.items():
            self.env.update(zip(names, self.credentials[key], strict=True))
        self.responses = {
            DB: {"uuid": D1, "name": prod.NAME, "version": "production"},
            prod.BUCKET: {"name": prod.NAME, "jurisdiction": "default"},
            f"{prod.BUCKET}/domains/managed": {"enabled": False},
            f"{prod.BUCKET}/domains/custom": {"domains": []},
            "/workers/subdomain": {"subdomain": SUBDOMAIN},
            f"{prod.WORKER}/settings": None,
            f"{DB}/query": d1([]),
            f"{DB}/time_travel/bookmark": {"bookmark": BOOKMARK},
        }
        self.read = Mock(side_effect=self.read_provider)
        self.list_r2 = Mock(side_effect=lambda op, _: OBJECTS if op == "list-objects-v2" else MULTIPART)
        self.write = Mock()

    def read_provider(self, path, **_):
        return self.responses[path]

    def release_env(self):
        return self.env | {"DRIVE_PRODUCTION_TARGET": prod.canonical(self.target),
                           "DRIVE_PRODUCTION_APPROVAL": prod.canonical(self.approval)}

    def gate(self):
        return prod.target_and_approval(self.boundary, self.release_env(), SHA, self.now)


class ProductionTests(ProductionFixture):
    def test_both_operations_refuse_missing_invalid_or_shared_pin_before_provider_access(self):
        invalid = (
            None, "", "null", "[]", "{", " " * 4097, "[" * 2000,
            prod.canonical({"accountId": ACCOUNT}),
            prod.canonical(PIN | {"origin": ORIGIN}),
            '{"accountId":"' + ACCOUNT + '","workerSubdomain":"first","workerSubdomain":"second"}',
            *(prod.canonical(PIN | {"accountId": account}) for account in
              (prod.SHARED_ACCOUNT, ACCOUNT.upper(), ACCOUNT[:-1], ACCOUNT + "\n", 123)),
            *(prod.canonical(PIN | {"workerSubdomain": label}) for label in
              (prod.SHARED_SUBDOMAIN, "Uppercase", "a.b", "-a", "a-", "a" * 64, "a\n", "é", True)),
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
            env = self.release_env() | {"DRIVE_PRODUCTION_BOUNDARY": prod.canonical(pin)}
            with self.subTest(pin=pin), patch.object(sys, "argv", ["production.py", "release"]), \
                 patch.object(prod.HTTPS, "open") as request, patch.object(prod, "cloud_run") as command:
                with self.assertRaisesRegex(SystemExit, "dedicated release namespace"):
                    prod.main(env)
                request.assert_not_called()
                command.assert_not_called()

    def test_switch_off_uses_only_durable_inputs_and_incident_credentials(self):
        env = DISPATCH | INCIDENT | {"DRIVE_PRODUCTION_BOUNDARY": prod.canonical(PIN)}
        api = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"
        state = {"enabled": False, "previews_enabled": False}
        read_token, write_token = INCIDENT.values()
        requests = iter([
            (api + "/workers/subdomain", "GET", read_token, None, {"subdomain": SUBDOMAIN}),
            (api + prod.WORKER + "/subdomain", "POST", write_token, state, state),
            (api + prod.WORKER + "/subdomain", "GET", read_token, None, state),
            (ORIGIN + "/sign-in", "HEAD", None, None, None),
        ])

        def provider(request, **_):
            url, method, token, body, result = next(requests)
            self.assertEqual(request.full_url, url)
            self.assertEqual(request.get_method(), method)
            self.assertEqual(request.get_header("Authorization"), f"Bearer {token}" if token else None)
            self.assertEqual(prod.json_object(request.data) if request.data else None, body)
            response = MagicMock()
            response.__enter__.return_value = response
            response.status = 404
            response.read.return_value = prod.canonical({"success": True, "errors": [], "result": result}).encode()
            return response

        with patch.object(sys, "argv", ["production.py", "switch-off"]), \
             patch.object(prod.HTTPS, "open", side_effect=provider) as request, \
             patch.object(prod, "cloud_run") as command:
            prod.main(env)
            self.assertEqual(request.call_count, 4)
            command.assert_not_called()
            request.reset_mock()
            with self.assertRaisesRegex(SystemExit, "incident read and write credentials"):
                prod.main(self.release_env())
            request.assert_not_called()

    def test_switch_off_refuses_different_provider_namespace_before_write(self):
        self.responses["/workers/subdomain"] = {"subdomain": "another-account"}
        with patch.object(prod, "probe_status") as probe, self.assertRaisesRegex(SystemExit, "namespace differs"):
            prod.switch_off(self.boundary, self.read, self.write)
        self.write.assert_not_called()
        probe.assert_not_called()

    def test_r2_listing_and_metadata_use_the_pinned_account(self):
        with patch.object(prod, "cloud_run", return_value=prod.canonical(OBJECTS)) as command:
            prod.r2_listing(self.boundary, self.credentials["r2Read"], "list-objects-v2", "--max-keys")
        args = command.call_args.args[0]
        self.assertEqual(args[args.index("--endpoint-url") + 1], ENDPOINT)
        self.assertEqual(args[-6:], ["s3api", "list-objects-v2", "--bucket", prod.NAME, "--max-keys", "1"])
        with patch.object(prod.HTTPS, "open") as request:
            request.return_value.__enter__.return_value.read.return_value = (
                b'{"success":true,"errors":[],"result":{}}'
            )
            prod.cloudflare(self.boundary, self.credentials["cfRead"][0], prod.BUCKET)
        sent = request.call_args.args[0]
        self.assertEqual(sent.full_url, f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}{prod.BUCKET}")
        self.assertEqual(sent.get_header("Cf-r2-jurisdiction"), "default")

    def test_accepts_only_reviewed_exact_target_secrets_and_approval(self):
        self.assertEqual(self.gate(), (self.target, self.credentials, self.approval))
        for key, value in (("origin", "https://qerith-drive-staging.5150.workers.dev"),
                           ("d1Id", prod.STAGING_DB), ("r2Bucket", "shared-staging-bucket")):
            original = self.target[key]
            self.target[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "dedicated release namespace"):
                self.gate()
            self.target[key] = original
        changed = prod.CREDENTIALS["r2App"][1]
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

    def test_rejects_wrong_provider_scope_public_bucket_and_existing_worker(self):
        prod.verify_targets(self.boundary, self.read, DB)
        for path, response in (
            (DB, {"uuid": prod.STAGING_DB, "name": prod.NAME, "version": "production"}),
            (DB, {"uuid": D1, "name": prod.NAME, "version": "alpha"}),
            (prod.BUCKET, {"name": prod.NAME, "jurisdiction": "eu"}),
            (f"{prod.BUCKET}/domains/managed", {"enabled": True}),
            (f"{prod.BUCKET}/domains/custom", {"domains": [{"enabled": False}]}),
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

    def test_rejects_objects_uploads_truncation_wrong_bucket_or_changed_bookmark(self):
        cases = (
            (OBJECTS | {"Contents": [{"Key": "synthetic"}]}, MULTIPART),
            (OBJECTS | {"IsTruncated": True}, MULTIPART),
            (OBJECTS | {"Prefix": "partial/"}, MULTIPART),
            (OBJECTS | {"Name": "wrong-bucket"}, MULTIPART),
            (OBJECTS, MULTIPART | {"Uploads": [{"UploadId": "synthetic"}]}),
            (OBJECTS, MULTIPART | {"IsTruncated": True}),
            (OBJECTS, MULTIPART | {"NextUploadIdMarker": "unexpected"}),
            (OBJECTS, MULTIPART | {"Bucket": "wrong-bucket"}),
        )
        for objects, multipart in cases:
            with self.subTest(objects=objects, multipart=multipart), self.assertRaisesRegex(SystemExit, "listing"):
                prod.verify_snapshot(
                    self.read, DB, Mock(side_effect=[objects, multipart]), self.approval["bookmarkDigest"],
                )
        self.responses[f"{DB}/time_travel/bookmark"] = {"bookmark": "different-bookmark"}
        with self.assertRaisesRegex(SystemExit, "Time Travel snapshot"):
            prod.verify_snapshot(self.read, DB, self.list_r2, self.approval["bookmarkDigest"])

    def test_never_treats_missing_or_malformed_scope_evidence_as_empty(self):
        self.responses[f"{DB}/query"] = [{"success": False, "results": []}]
        with self.assertRaisesRegex(SystemExit, "read-only evidence"):
            prod.verify_emptiness(self.read, DB, self.list_r2)
        self.list_r2.assert_not_called()

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
        self.assertEqual(config["vars"]["DRIVE_S3_ENDPOINT"], ENDPOINT)
        qualification = prod.json_object(config["vars"]["DRIVE_S3_QUALIFICATION"])
        self.assertEqual(prod.json_object(qualification["storageConfigId"]), [ENDPOINT, prod.NAME, "prod-first"])
        self.assertEqual(config["vars"]["DRIVE_OWNER_ENROLLMENT_RELEASE"], SHA)
        self.assertFalse(any("DELETION" in key or "DELETE" in key for key in config["vars"]))

    def test_rejects_extra_bindings_and_wrong_database_on_the_deployed_version(self):
        config = prod.worker_config(self.boundary, self.target, self.approval)
        bindings = [
            {"name": "DB", "type": "d1", "id": D1},
            {"name": "ASSETS", "type": "assets"},
            *[{"name": name, "type": "plain_text", "text": value} for name, value in config["vars"].items()],
            *[{"name": name, "type": "secret_text"} for name in
              ("DRIVE_S3_ACCESS_KEY_ID", "DRIVE_S3_SECRET_ACCESS_KEY", "DRIVE_OWNER_ENROLLMENT")],
        ]
        self.responses[f"{prod.WORKER}/versions/{UUID}"] = {"id": UUID, "resources": {"bindings": bindings}}
        prod.verify_worker_bindings(self.read, UUID, config)
        bindings[0]["id"] = prod.STAGING_DB
        with self.assertRaisesRegex(SystemExit, "incorrect production bindings"):
            prod.verify_worker_bindings(self.read, UUID, config)
        bindings[0]["id"] = D1
        bindings.append({"name": "DRIVE_STAGING_DELETE_REQUESTS", "type": "plain_text", "text": "1"})
        with self.assertRaisesRegex(SystemExit, "unexpected"):
            prod.verify_worker_bindings(self.read, UUID, config)

    def test_switch_off_touches_only_dedicated_subdomain_and_verifies_denial(self):
        self.responses[f"{prod.WORKER}/subdomain"] = {"enabled": False, "previews_enabled": False}
        with patch.object(prod, "probe_status", return_value=404) as probe:
            prod.switch_off(self.boundary, self.read, self.write)
        self.write.assert_called_once_with(f"{prod.WORKER}/subdomain", body={"enabled": False, "previews_enabled": False})
        probe.assert_called_once_with(self.boundary, "/sign-in")


class DeploymentOrderTests(ProductionFixture):
    def setUp(self):
        super().setUp()
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        app = Path(directory.name)
        patcher = patch.object(prod, "APP", app)
        patcher.start()
        self.addCleanup(patcher.stop)
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
                *[{"name": name, "type": "secret_text"} for name in
                  ("DRIVE_S3_ACCESS_KEY_ID", "DRIVE_S3_SECRET_ACCESS_KEY", "DRIVE_OWNER_ENROLLMENT")],
            ]}}
        return super().read_provider(path, **options)

    def fake_wrangler(self, args, env, *_):
        if "--dry-run" not in args:
            self.assertEqual(env["CLOUDFLARE_ACCOUNT_ID"], ACCOUNT)
            self.assertEqual(env["CLOUDFLARE_API_TOKEN"], self.credentials["cfDeploy"][0])
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
            config = prod.json_object(Path(args[args.index("--config") + 1]).read_bytes())
            self.assertEqual(config, self.bindings)
            secrets = Path(args[args.index("--secrets-file") + 1])
            self.assertEqual(secrets.stat().st_mode & 0o777, 0o600)
            record = {"type": "deploy", "worker_name": prod.NAME, "version_id": UUID}
            Path(env["WRANGLER_OUTPUT_FILE_PATH"]).write_text(prod.canonical(record) + "\n")

    def fake_switch(self, path, *, body):
        self.assertEqual(path, f"{prod.WORKER}/subdomain")
        self.active = body["enabled"]
        self.events.append(("switch", self.active))

    def promote(self, status=(200, 401)):
        self.write.side_effect = self.fake_switch
        with patch.object(prod, "wrangler", side_effect=self.fake_wrangler), \
             patch.object(prod, "probe_status", side_effect=status) as probe, patch.object(prod, "sleep"):
            prod.promote(self.boundary, self.target, self.credentials, self.approval, self.read, self.write, self.list_r2)
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
        self.assertEqual(positions.count(snapshot), 2)
        self.assertLess(positions.index(snapshot, positions.index(snapshot) + 1), positions.index("d1"))
        self.assertLess(positions.index("d1"), positions.index("deploy"))
        self.assertLess(positions.index(f"{prod.WORKER}/versions/{UUID}"), positions.index("switch"))
        self.assertLess(positions.index(f"{prod.WORKER}/deployments"), positions.index("switch"))
        self.assertTrue(self.active)

    def test_failed_serving_probe_switches_the_route_off(self):
        with self.assertRaisesRegex(SystemExit, "Serving probes failed"):
            self.promote([503] * 6 + [404])
        self.assertEqual([event for event in self.events if event[0] == "switch"], [("switch", True), ("switch", False)])
        self.assertFalse(self.active)
