"""First-ever Drive deploy to the dedicated production Cloudflare targets."""

from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from preflight import DIGEST, RUN_NUMBER, SHA, UUID, dispatch_sha, json_object, require, utc_time

ACCOUNT = "209cf7dd678adfb683947dd7874d05af"
NAME = "qerith-drive-production"
SUBDOMAIN = "5150"
ORIGIN = f"https://{NAME}.{SUBDOMAIN}.workers.dev"
ENDPOINT = f"https://{ACCOUNT}.r2.cloudflarestorage.com"
APP = Path(__file__).resolve().parents[2] / "apps/drive"
PACKAGE = ".svelte-kit/first-release-package/_worker.js"
ASSETS = ".svelte-kit/cloudflare"
WORKER = f"/workers/scripts/{NAME}"
BUCKET = f"/r2/buckets/{NAME}"
STAGING_DB = "87ac8041-ad2d-4650-b0d7-05bb78846f60"
PRISTINE_SCHEMA = (
    "SELECT 1 AS present FROM main.sqlite_schema "
    "WHERE NOT (type = 'table' AND name = '_cf_KV') "
    "AND NOT (type = 'index' AND name = 'sqlite_autoindex__cf_KV_1' AND tbl_name = '_cf_KV') LIMIT 1"
)
MAX_MIGRATIONS = 100
CREDENTIALS = {
    "cfRead": ("DRIVE_PRODUCTION_CF_READ_TOKEN",),
    "cfDeploy": ("DRIVE_PRODUCTION_CF_DEPLOY_TOKEN",),
    "r2Read": ("DRIVE_PRODUCTION_R2_READ_ID", "DRIVE_PRODUCTION_R2_READ_SECRET"),
    "r2App": ("DRIVE_PRODUCTION_R2_APP_ID", "DRIVE_PRODUCTION_R2_APP_SECRET"),
    "owner": ("DRIVE_PRODUCTION_OWNER_TOKEN",),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTPS = build_opener(NoRedirect)


def fingerprint(text):
    return sha256(text.encode()).hexdigest()


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def target_and_approval(env, sha, now):
    target = json_object(env.get("DRIVE_PRODUCTION_TARGET", ""))
    require(
        set(target) == {"accountId", "worker", "origin", "d1Id", "r2Bucket", "storageEpoch", "credentials"}
        and target["accountId"] == ACCOUNT and target["worker"] == NAME
        and target["origin"] == ORIGIN and target["r2Bucket"] == NAME
        and UUID.fullmatch(target["d1Id"]) and target["d1Id"] not in (STAGING_DB, "00000000-0000-0000-0000-000000000000")
        and re.fullmatch(r"prod-[a-z0-9-]{1,48}", target["storageEpoch"])
        and set(target["credentials"]) == set(CREDENTIALS),
        "Production target does not match the dedicated release namespace.",
    )
    credentials = {key: tuple(env.get(name, "") for name in names) for key, names in CREDENTIALS.items()}
    for key, values in credentials.items():
        require(
            all(re.fullmatch(r"[A-Za-z0-9_+/=-]{20,256}", value) for value in values)
            and target["credentials"][key] == fingerprint("\0".join(values)),
            "Production credentials are missing or differ from reviewed custody evidence.",
        )
    require(
        credentials["cfRead"] != credentials["cfDeploy"]
        and credentials["r2Read"][0] != credentials["r2App"][0]
        and re.fullmatch(r"[A-Za-z0-9_-]{43}", credentials["owner"][0]),
        "Production must use separate read and write identities and a bounded owner token.",
    )

    digest, run_id, attempt = (env.get(key, "") for key in ("CHECKED_BUILD_DIGEST", "STAGING_RUN_ID", "STAGING_RUN_ATTEMPT"))
    require(
        SHA.fullmatch(sha) and DIGEST.fullmatch(digest) and RUN_NUMBER.fullmatch(run_id)
        and RUN_NUMBER.fullmatch(attempt) and env.get("ACCEPTED_SHA") == env.get("PRODUCTION_ACCEPTED_SHA") == sha,
        "Production inputs differ from exact-SHA preflight.",
    )
    approval = json_object(env.get("DRIVE_PRODUCTION_APPROVAL", ""))
    require(
        set(approval) == {"sourceSha", "buildDigest", "stagingRunId", "stagingRunAttempt",
                          "targetDigest", "bookmarkDigest", "expiresAt"}
        and approval["sourceSha"] == sha and approval["buildDigest"] == digest
        and approval["stagingRunId"] == run_id
        and type(approval["stagingRunAttempt"]) is int and approval["stagingRunAttempt"] == int(attempt)
        and approval["targetDigest"] == fingerprint(canonical(target))
        and DIGEST.fullmatch(approval["bookmarkDigest"])
        and now < utc_time(approval["expiresAt"]) <= now + timedelta(hours=1),
        "Candidate, target, snapshot or staging evidence differs from unexpired independent approval.",
    )
    return target, credentials, approval


def cloudflare(token, path, *, body=None, missing_worker=False):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}
    if path.startswith(f"{BUCKET}/") or path == BUCKET:
        headers["cf-r2-jurisdiction"] = "default"
    payload = json.dumps(body).encode() if body is not None else None
    request = Request(f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}{path}", payload, headers)
    try:
        with HTTPS.open(request, timeout=8) as response:
            data = response.read(65537)
    except HTTPError as error:
        if missing_worker and error.code == 404:
            with error:
                failure = json_object(error.read(4097))
            if failure["success"] is False and [item["code"] for item in failure["errors"]] == [10007]:
                return None
        raise SystemExit("Required scoped Cloudflare request failed.") from None
    except (OSError, URLError):
        raise SystemExit("Required scoped Cloudflare request could not be completed.") from None
    require(len(data) <= 65536, "Cloudflare evidence exceeded the response limit.")
    result = json_object(data)
    require(result["success"] is True and result["errors"] == [], "Cloudflare rejected the scoped request.")
    return result["result"]


def query_d1(read, db, sql):
    result = read(f"{db}/query", body={"sql": sql})
    require(
        len(result) == 1 and result[0]["success"] is True and type(result[0]["results"]) is list,
        "D1 read-only evidence is incomplete.",
    )
    return result[0]["results"]


def cloud_run(args, env, timeout, label):
    try:
        return subprocess.run(
            args, cwd=APP, env=env, timeout=timeout, stdin=subprocess.DEVNULL,
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        raise SystemExit(f"{label} failed or timed out. Reconcile provider state before retrying.") from None


def cli_env():
    return {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ} | {
        "CI": "true", "NO_COLOR": "1", "WRANGLER_SEND_METRICS": "false",
    }


def r2_listing(reader, operation, limit):
    env = cli_env() | {
        "AWS_ACCESS_KEY_ID": reader[0], "AWS_SECRET_ACCESS_KEY": reader[1],
        "AWS_CONFIG_FILE": "/dev/null", "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
        "AWS_EC2_METADATA_DISABLED": "true", "AWS_MAX_ATTEMPTS": "1",
    }
    args = ["aws", "--no-cli-pager", "--no-paginate", "--cli-connect-timeout", "5",
            "--cli-read-timeout", "8", "--output", "json", "--region", "auto", "--endpoint-url", ENDPOINT,
            "s3api", operation, "--bucket", NAME, limit, "1"]
    return json_object(cloud_run(args, env, 15, "R2 read-only listing"))


def verify_emptiness(read, db, list_r2):
    require(query_d1(read, db, PRISTINE_SCHEMA) == [], "D1 has an application schema or migration ledger.")
    objects = list_r2("list-objects-v2", "--max-keys")
    require(
        objects["Name"] == NAME and objects["IsTruncated"] is False
        and type(objects["KeyCount"]) is int and objects["KeyCount"] == 0
        and all(objects.get(key, "") == "" for key in
                ("Prefix", "Delimiter", "StartAfter", "ContinuationToken", "NextContinuationToken"))
        and objects.get("Contents", []) == [] and objects.get("CommonPrefixes", []) == [],
        "The dedicated R2 bucket is nonempty or its object listing is incomplete.",
    )
    multipart = list_r2("list-multipart-uploads", "--max-uploads")
    require(
        multipart["Bucket"] == NAME and multipart["IsTruncated"] is False
        and all(multipart.get(key, "") == "" for key in
                ("Prefix", "Delimiter", "KeyMarker", "UploadIdMarker", "NextKeyMarker", "NextUploadIdMarker"))
        and multipart.get("Uploads", []) == [] and multipart.get("CommonPrefixes", []) == [],
        "An unfinished R2 multipart upload exists or its listing is incomplete.",
    )


def verify_targets(read, db):
    actual = read(db)
    require(
        actual["uuid"] == db.rsplit("/", 1)[1] and actual["name"] == NAME and actual["version"] == "production",
        "Production D1 identity or Time Travel compatibility differs from reviewed target.",
    )
    bucket = read(BUCKET)
    require(bucket["name"] == NAME and bucket["jurisdiction"] == "default", "Production R2 identity differs.")
    require(
        read(f"{BUCKET}/domains/managed")["enabled"] is False
        and read(f"{BUCKET}/domains/custom")["domains"] == [],
        "Production R2 must have no public domain.",
    )
    require(
        read("/workers/subdomain")["subdomain"] == SUBDOMAIN
        and read(f"{WORKER}/settings", missing_worker=True) is None,
        "Production Worker namespace differs or a prior Worker already exists.",
    )


def verify_snapshot(read, db, list_r2, expected):
    before = read(f"{db}/time_travel/bookmark")["bookmark"]
    verify_emptiness(read, db, list_r2)
    after = read(f"{db}/time_travel/bookmark")["bookmark"]
    require(
        re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", before) and after == before
        and fingerprint(before) == expected,
        "Could not verify the approved D1 Time Travel snapshot across the empty-target check.",
    )
    print(f"Verified pristine D1, empty private R2 and pre-migration snapshot SHA-256 {expected}.", flush=True)


def switch_state(read, write, on):
    write(f"{WORKER}/subdomain", body={"enabled": on, "previews_enabled": False})
    verify_surface(read, on)


def verify_surface(read, on):
    state = read(f"{WORKER}/subdomain")
    require(
        state["enabled"] is on and state["previews_enabled"] is False,
        "Production Worker workers.dev status or preview isolation could not be verified.",
    )


def probe_status(path):
    request = Request(f"{ORIGIN}{path}", method="HEAD", headers={"Cache-Control": "no-cache"})
    try:
        with HTTPS.open(request, timeout=5) as response:
            return response.status
    except HTTPError as error:
        with error:
            return error.code
    except (OSError, URLError):
        return None


def verify_deployment(read, version_id):
    deployed = read(f"{WORKER}/deployments")["deployments"]
    require(
        deployed and len(deployed[0]["versions"]) == 1
        and deployed[0]["versions"][0]["version_id"] == version_id
        and deployed[0]["versions"][0]["percentage"] == 100,
        "Cloudflare serving version differs from the checked upload.",
    )


def verify_serving(read, version_id, sha):
    verify_deployment(read, version_id)
    for retry in range(6):
        if probe_status("/sign-in") == 200 and probe_status("/api/root-listing") == 401:
            print(f"Private serving probes passed. SHA {sha}, Worker version {version_id}.", flush=True)
            return
        if retry < 5:
            sleep(3)
    raise SystemExit("Serving probes failed or anonymous API denial drifted.")


def migration_names():
    names = sorted(path.name for path in (APP / "migrations").glob("*.sql"))
    require(
        0 < len(names) < MAX_MIGRATIONS and all(re.fullmatch(r"[0-9]{4}_[a-z0-9_]+\.sql", name) for name in names),
        "Expected a bounded, ordered set of checked-in Drive migrations.",
    )
    return names


def worker_config(target, approval):
    values = {
        "DRIVE_ORIGIN": ORIGIN,
        "DRIVE_FIRST_RELEASE_ORIGIN": ORIGIN,
        "DRIVE_STAGING_INVITE_ACCEPTANCE": "1",
        "DRIVE_STAGING_READ_GRANTS": "1",
        "DRIVE_STAGING_SHARED_LISTING": "1",
        "DRIVE_OWNER_ENROLLMENT_RELEASE": approval["sourceSha"],
        "DRIVE_S3_ENDPOINT": ENDPOINT,
        "DRIVE_S3_BUCKET": NAME,
        "DRIVE_S3_REGION": "auto",
        "DRIVE_S3_STORAGE_EPOCH": target["storageEpoch"],
        "DRIVE_S3_QUALIFICATION": canonical({
            "version": 1, "storageConfigId": json.dumps([ENDPOINT, NAME, target["storageEpoch"]], separators=(",", ":")),
            "region": "auto", "sourceSha": approval["sourceSha"], "runId": approval["stagingRunId"],
            "runAttempt": approval["stagingRunAttempt"], "completionTimeoutMs": 30_000,
        }),
    }
    return {
        "account_id": ACCOUNT, "name": NAME, "main": str(APP / PACKAGE),
        "compatibility_date": "2026-07-30",
        "compatibility_flags": ["nodejs_compat", "enable_request_signal"],
        "workers_dev": False, "preview_urls": False,
        "assets": {"directory": str(APP / ASSETS), "binding": "ASSETS", "run_worker_first": True},
        "d1_databases": [{"binding": "DB", "database_name": NAME, "database_id": target["d1Id"],
                         "migrations_dir": str(APP / "migrations")}],
        "vars": values,
    }


def wrangler(args, env, timeout, label):
    cloud_run([str(APP / "node_modules/.bin/wrangler"), *args], env, timeout, label)


def promote(target, credentials, approval, read, write, list_r2):
    db = f"/d1/database/{target['d1Id']}"
    names = migration_names()
    require((APP / PACKAGE).is_file() and (APP / ASSETS).is_dir(), "Checked release package is missing.")

    with TemporaryDirectory(prefix="drive-first-production-") as temporary:
        tmp = Path(temporary)
        config = tmp / "wrangler.json"
        configuration = worker_config(target, approval)
        config.write_text(canonical(configuration), encoding="utf-8")
        dry_run = tmp / "dry-run"
        wrangler(["deploy", "--no-bundle", "--config", str(config), "--dry-run", "--outdir", str(dry_run)],
                 cli_env(), 60, "Offline production package validation")
        require(
            (dry_run / "_worker.js").read_bytes() == (APP / PACKAGE).read_bytes(),
            "Wrangler changed the checked Worker module.",
        )
        output = tmp / "deployment.jsonl"
        env = cli_env() | {"CLOUDFLARE_API_TOKEN": credentials["cfDeploy"][0],
                           "CLOUDFLARE_ACCOUNT_ID": ACCOUNT, "WRANGLER_OUTPUT_FILE_PATH": str(output)}

        verify_targets(read, db)
        verify_snapshot(read, db, list_r2, approval["bookmarkDigest"])
        require(datetime.now(timezone.utc) < utc_time(approval["expiresAt"]), "Independent release approval expired.")
        wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", str(config)], env, 120, "D1 migration")
        rows = query_d1(read, db, f"SELECT name FROM d1_migrations ORDER BY id LIMIT {MAX_MIGRATIONS}")
        require(rows == [{"name": name} for name in names], "The production D1 migration ledger differs from reviewed source.")
        require(datetime.now(timezone.utc) < utc_time(approval["expiresAt"]), "Independent release approval expired.")

        owner_expiry = int(datetime.now(timezone.utc).timestamp() * 1000) + 300_000
        secrets = tmp / "secrets.json"
        secrets.write_text(canonical({
            "DRIVE_S3_ACCESS_KEY_ID": credentials["r2App"][0],
            "DRIVE_S3_SECRET_ACCESS_KEY": credentials["r2App"][1],
            "DRIVE_OWNER_ENROLLMENT": f"{approval['sourceSha']}:{owner_expiry}:{credentials['owner'][0]}",
        }), encoding="utf-8")
        secrets.chmod(0o600)
        wrangler(["deploy", "--no-bundle", "--config", str(config), "--secrets-file", str(secrets)],
                 env, 120, "Closed Worker deploy")
        records = [json_object(line) for line in output.read_bytes().splitlines()]
        deployments = [record for record in records if record.get("type") == "deploy"]
        require(len(deployments) == 1, "Expected one exact Cloudflare deployment.")
        deployment = deployments[0]
        version = deployment["version_id"]
        require(
            deployment["worker_name"] == NAME and UUID.fullmatch(version),
            "Closed Worker deploy did not return the dedicated Worker identity.",
        )
        verify_surface(read, False)
        verify_worker_bindings(read, version, configuration)
        verify_deployment(read, version)
        require(
            datetime.now(timezone.utc) < utc_time(approval["expiresAt"])
            and owner_expiry - int(datetime.now(timezone.utc).timestamp() * 1000) >= 120_000,
            "Independent approval expired or owner enrollment window is too short.",
        )
        try:
            switch_state(read, write, True)
            verify_serving(read, version, approval["sourceSha"])
        except BaseException:
            switch_off(read, write)
            raise


def verify_worker_bindings(read, version, config):
    result = read(f"{WORKER}/versions/{version}")
    require(result["id"] == version, "Cloudflare version identity differs.")
    bindings = result["resources"]["bindings"]
    by_name = {binding["name"]: binding for binding in bindings}
    expected_secrets = {"DRIVE_S3_ACCESS_KEY_ID", "DRIVE_S3_SECRET_ACCESS_KEY", "DRIVE_OWNER_ENROLLMENT"}
    require(
        len(by_name) == len(bindings)
        and set(by_name) == set(config["vars"]) | expected_secrets | {"DB", "ASSETS"}
        and by_name["DB"]["type"] == "d1" and by_name["DB"]["id"] == config["d1_databases"][0]["database_id"]
        and by_name["ASSETS"]["type"] == "assets"
        and all(by_name[key]["type"] == "secret_text" for key in expected_secrets)
        and all(by_name[key]["type"] == "plain_text" and by_name[key]["text"] == value
                for key, value in config["vars"].items()),
        "Worker has unexpected, missing or incorrect production bindings.",
    )


def switch_off(read, write):
    require(read("/workers/subdomain")["subdomain"] == SUBDOMAIN, "Production Worker namespace differs.")
    switch_state(read, write, False)
    for retry in range(6):
        if probe_status("/sign-in") == 404:
            print("Production Worker route switched off. Provider and origin deny serving.", flush=True)
            return
        if retry < 5:
            sleep(3)
    raise SystemExit("Provider route is off but origin denial was not verified. Escalate immediately.")


def main(env):
    sha = dispatch_sha(env)
    read_token = env.get("DRIVE_PRODUCTION_CF_READ_TOKEN", "")
    write_token = env.get("DRIVE_PRODUCTION_CF_DEPLOY_TOKEN", "")

    def read(path, **options):
        return cloudflare(read_token, path, **options)

    def write(path, **options):
        return cloudflare(write_token, path, **options)

    if sys.argv[1:] == ["switch-off"]:
        require(
            read_token != write_token
            and all(re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token) for token in (read_token, write_token)),
            "Production switch-off requires the scoped reader and deploy credentials.",
        )
        switch_off(read, write)
    else:
        require(sys.argv[1:] == ["release"], "Invalid production operation.")
        target, credentials, approval = target_and_approval(env, sha, datetime.now(timezone.utc))
        promote(target, credentials, approval, read, write, lambda *args: r2_listing(credentials["r2Read"], *args))


if __name__ == "__main__":
    try:
        main(os.environ)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise SystemExit("Required production evidence was incomplete or malformed. Check provider state before retrying.") from None
