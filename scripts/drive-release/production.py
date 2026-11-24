"""First-ever Drive deploy to the pinned production Cloudflare targets."""

from base64 import b64decode
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
from secrets import token_hex
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from preflight import DIGEST, RUN_NUMBER, SHA, UUID, dispatch_sha, json_object, require, utc_time

SHARED_ACCOUNT = "209cf7dd678adfb683947dd7874d05af"
SHARED_SUBDOMAIN = "5150"
NAME = "qerith-drive-production"
APP = Path(__file__).resolve().parents[2] / "apps/drive"
BUILD_CONFIG = "wrangler.build.jsonc"
PACKAGE = ".svelte-kit/first-release-package/_worker.js"
ASSETS = ".svelte-kit/cloudflare"
WORKER = f"/workers/scripts/{NAME}"
STAGING_DB = "87ac8041-ad2d-4650-b0d7-05bb78846f60"
PRISTINE_SCHEMA = (
    "SELECT 1 AS present FROM main.sqlite_schema "
    "WHERE NOT (type = 'table' AND name = '_cf_KV') "
    "AND NOT (type = 'index' AND name = 'sqlite_autoindex__cf_KV_1' AND tbl_name = '_cf_KV') LIMIT 1"
)
MAX_MIGRATIONS = 100
MAX_PROTECTED_JSON_BYTES = 4096
CREDENTIALS = {
    "cfRead": "DRIVE_PRODUCTION_CF_READ_TOKEN",
    "cfDeploy": "DRIVE_PRODUCTION_CF_DEPLOY_TOKEN",
    "owner": "DRIVE_PRODUCTION_OWNER_TOKEN",
}


@dataclass(frozen=True)
class Boundary:
    account_id: str
    worker_subdomain: str
    d1_id: str | None = None

    @property
    def origin(self):
        return f"https://{NAME}.{self.worker_subdomain}.workers.dev"


def protected_json(encoded, message):
    # Keep structured values out of the runner environment. GitHub masks the
    # single-line secret, and decoding happens only inside this process.
    require(0 < len(encoded) <= 4 * ((MAX_PROTECTED_JSON_BYTES + 2) // 3), message)
    try:
        raw = b64decode(encoded, validate=True)
        require(0 < len(raw) <= MAX_PROTECTED_JSON_BYTES, message)
        return json_object(raw.decode("utf-8"))
    except (ValueError, RecursionError):
        raise SystemExit(message) from None


def production_d1_id(value):
    return (type(value) is str and UUID.fullmatch(value) is not None
            and value not in (STAGING_DB, "00000000-0000-0000-0000-000000000000"))


def production_boundary(env):
    message = "Missing or invalid production boundary."
    pin = protected_json(env.get("DRIVE_PRODUCTION_BOUNDARY", ""), message)
    require(type(pin) is dict, message)
    if set(pin) == {"mode", "accountId", "workerSubdomain", "d1Id"}:
        require(
            pin["mode"] == "shared-account"
            and (pin["accountId"], pin["workerSubdomain"]) == (SHARED_ACCOUNT, SHARED_SUBDOMAIN)
            and production_d1_id(pin["d1Id"]),
            message,
        )
        return Boundary(SHARED_ACCOUNT, SHARED_SUBDOMAIN, pin["d1Id"])
    require(
        set(pin) == {"accountId", "workerSubdomain"}
        and type(pin["accountId"]) is str and re.fullmatch(r"[0-9a-f]{32}", pin["accountId"])
        and type(pin["workerSubdomain"]) is str
        and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", pin["workerSubdomain"])
        and pin["accountId"] != SHARED_ACCOUNT and pin["workerSubdomain"] != SHARED_SUBDOMAIN,
        message,
    )
    return Boundary(pin["accountId"], pin["workerSubdomain"])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


HTTPS = build_opener(NoRedirect)


def fingerprint(text):
    return sha256(text.encode()).hexdigest()


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def target_and_approval(boundary, env, sha, now):
    target = protected_json(
        env.get("DRIVE_PRODUCTION_TARGET", ""), "Missing or invalid production target.",
    )
    require(
        type(target) is dict and set(target) == {"accountId", "worker", "origin", "d1Id", "credentials"}
        and target["accountId"] == boundary.account_id and target["worker"] == NAME
        and target["origin"] == boundary.origin
        and production_d1_id(target["d1Id"])
        and (boundary.d1_id is None or target["d1Id"] == boundary.d1_id)
        and type(target["credentials"]) is dict and set(target["credentials"]) == set(CREDENTIALS),
        "Production target does not match the pinned release namespace.",
    )
    credentials = {key: env.get(name, "") for key, name in CREDENTIALS.items()}
    for key, value in credentials.items():
        require(
            re.fullmatch(r"[A-Za-z0-9_+/=-]{20,256}", value)
            and target["credentials"][key] == fingerprint(value),
            "Production credentials are missing or differ from reviewed custody evidence.",
        )
    require(
        credentials["cfRead"] != credentials["cfDeploy"]
        and re.fullmatch(r"[A-Za-z0-9_-]{43}", credentials["owner"]),
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


def cloudflare(boundary, token, path, *, body=None, missing_worker=False):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}
    payload = json.dumps(body).encode() if body is not None else None
    request = Request(f"https://api.cloudflare.com/client/v4/accounts/{boundary.account_id}{path}", payload, headers)
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
    if missing_worker:
        require(type(result["result"]) is dict, "Cloudflare Worker presence evidence is incomplete.")
    return result["result"]


def query_d1(read, db, sql):
    result = read(f"{db}/query", body={"sql": sql})
    require(
        len(result) == 1 and result[0]["success"] is True and type(result[0]["results"]) is list,
        "D1 read-only evidence is incomplete.",
    )
    return result[0]["results"]


def cloud_run(args, env, timeout, label, *, failure_hint="Reconcile provider state before retrying."):
    try:
        return subprocess.run(
            args, cwd=APP, env=env, timeout=timeout, stdin=subprocess.DEVNULL,
            check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        raise SystemExit(f"{label} failed or timed out. {failure_hint}") from None


def cli_env():
    return {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR") if key in os.environ} | {
        "CI": "true", "NO_COLOR": "1", "WRANGLER_SEND_METRICS": "false",
    }


def verify_targets(boundary, read, db):
    actual = read(db)
    require(
        actual["uuid"] == db.rsplit("/", 1)[1] and actual["name"] == NAME and actual["version"] == "production",
        "Production D1 identity or Time Travel compatibility differs from reviewed target.",
    )
    verify_absent_worker(boundary, read)


def verify_absent_worker(boundary, read):
    require(
        read("/workers/subdomain")["subdomain"] == boundary.worker_subdomain
        and read(f"{WORKER}/settings", missing_worker=True) is None,
        "Production Worker namespace differs or a prior Worker already exists.",
    )


def verify_snapshot(read, db, expected):
    before = read(f"{db}/time_travel/bookmark")["bookmark"]
    require(query_d1(read, db, PRISTINE_SCHEMA) == [], "D1 has an application schema or migration ledger.")
    after = read(f"{db}/time_travel/bookmark")["bookmark"]
    require(
        re.fullmatch(r"[A-Za-z0-9_-]{1,1024}", before) and after == before
        and fingerprint(before) == expected,
        "Could not verify the approved D1 Time Travel snapshot across the empty-target check.",
    )
    print(f"Verified pristine D1 and pre-migration snapshot SHA-256 {expected}.", flush=True)


def switch_state(read, write, on):
    write(f"{WORKER}/subdomain", body={"enabled": on, "previews_enabled": False})
    verify_surface(read, on)


def verify_surface(read, on):
    state = read(f"{WORKER}/subdomain")
    require(
        state["enabled"] is on and state["previews_enabled"] is False,
        "Production Worker workers.dev status or preview isolation could not be verified.",
    )


def probe_status(boundary, path, *, method="HEAD"):
    # The workers.dev edge can reject urllib's request signature. Curl
    # reached the synthetic route before and after switch-off.
    url = f"{boundary.origin}{path}"
    # Owner API admission requires the exact route and rejects unknown queries.
    if path == "/sign-in":
        url += f"?qerith_probe={token_hex(16)}"
    try:
        result = subprocess.run(
            ["curl", "--disable", {"HEAD": "--head", "GET": "--get"}[method],
             "--no-location", "--proto", "=https", "--header", "Cache-Control: no-cache, no-store",
             "--max-time", "5", "--silent", "--output", "/dev/null",
             "--write-out", "%{http_code}\n%header{cf-cache-status}", url],
            env={}, timeout=6, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    status, separator, cache_status = result.stdout.partition(b"\n")
    if (separator and re.fullmatch(rb"[1-5][0-9]{2}", status)
            and cache_status.upper() in (b"", b"MISS", b"BYPASS", b"DYNAMIC")):
        return int(status)
    return None


def verify_deployment(read, version_id):
    deployed = read(f"{WORKER}/deployments")["deployments"]
    require(
        deployed and len(deployed[0]["versions"]) == 1
        and deployed[0]["versions"][0]["version_id"] == version_id
        and deployed[0]["versions"][0]["percentage"] == 100,
        "Cloudflare serving version differs from the checked upload.",
    )


def verify_serving(boundary, read, version_id, sha):
    verify_deployment(read, version_id)
    for retry in range(6):
        if (probe_status(boundary, "/sign-in") == 200
                and probe_status(boundary, "/api/owner/invitations", method="GET") == 401):
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


def worker_config(boundary, target, approval):
    build = json_object((APP / BUILD_CONFIG).read_bytes())
    values = {
        "DRIVE_ORIGIN": boundary.origin,
        "DRIVE_FIRST_RELEASE_ORIGIN": boundary.origin,
        "DRIVE_STAGING_INVITE_ACCEPTANCE": "1",
        "DRIVE_STAGING_READ_GRANTS": "1",
        "DRIVE_STAGING_SHARED_LISTING": "1",
        "DRIVE_OWNER_ENROLLMENT_RELEASE": approval["sourceSha"],
    }
    return {
        "account_id": boundary.account_id, "name": NAME, "main": str(APP / PACKAGE),
        "compatibility_date": build["compatibility_date"],
        "compatibility_flags": build["compatibility_flags"],
        "workers_dev": False, "preview_urls": False,
        "assets": {"directory": str(APP / ASSETS), "binding": "ASSETS", "run_worker_first": True},
        "d1_databases": [{"binding": "DB", "database_name": NAME, "database_id": target["d1Id"],
                         "migrations_dir": str(APP / "migrations")}],
        "vars": values,
    }


def wrangler(args, env, timeout, label):
    cloud_run([str(APP / "node_modules/.bin/wrangler"), *args], env, timeout, label)


def promote(boundary, target, credentials, approval, read, write):
    db = f"/d1/database/{target['d1Id']}"
    names = migration_names()
    require((APP / PACKAGE).is_file() and (APP / ASSETS).is_dir(), "Checked release package is missing.")

    with TemporaryDirectory(prefix="drive-first-production-") as temporary:
        tmp = Path(temporary)
        config = tmp / "wrangler.json"
        configuration = worker_config(boundary, target, approval)
        config.write_text(canonical(configuration), encoding="utf-8")
        dry_run = tmp / "dry-run"
        wrangler(["deploy", "--no-bundle", "--config", str(config), "--dry-run", "--outdir", str(dry_run)],
                 cli_env(), 60, "Offline production package validation")
        require(
            (dry_run / "_worker.js").read_bytes() == (APP / PACKAGE).read_bytes(),
            "Wrangler changed the checked Worker module.",
        )
        cloud_run(["node", "scripts/production-shell-smoke.mjs", str(config)], cli_env(), 60,
                  "Offline storage-unconfigured serving probes",
                  failure_hint="No provider requests were made. Check sign-in and anonymous owner API denial without storage.")
        print("Verified private serving probes with local D1 and no object storage.", flush=True)
        output = tmp / "deployment.jsonl"
        env = cli_env() | {"CLOUDFLARE_API_TOKEN": credentials["cfDeploy"],
                           "CLOUDFLARE_ACCOUNT_ID": boundary.account_id, "WRANGLER_OUTPUT_FILE_PATH": str(output)}

        verify_targets(boundary, read, db)
        verify_snapshot(read, db, approval["bookmarkDigest"])
        require(datetime.now(timezone.utc) < utc_time(approval["expiresAt"]), "Independent release approval expired.")
        wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", str(config)], env, 120, "D1 migration")
        rows = query_d1(read, db, f"SELECT name FROM d1_migrations ORDER BY id LIMIT {MAX_MIGRATIONS}")
        require(rows == [{"name": name} for name in names], "The production D1 migration ledger differs from reviewed source.")
        verify_absent_worker(boundary, read)
        require(datetime.now(timezone.utc) < utc_time(approval["expiresAt"]), "Independent release approval expired.")

        owner_expiry = int(datetime.now(timezone.utc).timestamp() * 1000) + 300_000
        secrets = tmp / "secrets.json"
        secrets.write_text(canonical({
            "DRIVE_OWNER_ENROLLMENT": f"{approval['sourceSha']}:{owner_expiry}:{credentials['owner']}",
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
            verify_serving(boundary, read, version, approval["sourceSha"])
        except BaseException:
            switch_off(boundary, read, write)
            raise


def verify_worker_bindings(read, version, config):
    result = read(f"{WORKER}/versions/{version}")
    require(result["id"] == version, "Cloudflare version identity differs.")
    bindings = result["resources"]["bindings"]
    by_name = {binding["name"]: binding for binding in bindings}
    expected_secrets = {"DRIVE_OWNER_ENROLLMENT"}
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


def switch_off(boundary, read, write):
    require(read("/workers/subdomain")["subdomain"] == boundary.worker_subdomain, "Production Worker namespace differs.")
    switch_state(read, write, False)
    for retry in range(6):
        if probe_status(boundary, "/sign-in") == 404:
            print("Production Worker route switched off. Provider and origin deny serving.", flush=True)
            return
        if retry < 5:
            sleep(3)
    raise SystemExit("Provider route is off but origin denial was not verified. Escalate immediately.")


def main(env):
    sha = dispatch_sha(env)
    require(SHA.fullmatch(sha), "Dispatch SHA must be lowercase 40-hex.")
    boundary = production_boundary(env)

    def read(path, **options):
        return cloudflare(boundary, read_token, path, **options)

    def write(path, **options):
        return cloudflare(boundary, write_token, path, **options)

    if sys.argv[1:] == ["switch-off"]:
        read_token = env.get("DRIVE_PRODUCTION_CF_SWITCH_READ_TOKEN", "")
        write_token = env.get("DRIVE_PRODUCTION_CF_SWITCH_WRITE_TOKEN", "")
        require(
            read_token != write_token
            and all(re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token) for token in (read_token, write_token)),
            "Production switch-off requires separate scoped incident read and write credentials.",
        )
        switch_off(boundary, read, write)
    else:
        require(sys.argv[1:] == ["release"], "Invalid production operation.")
        target, credentials, approval = target_and_approval(boundary, env, sha, datetime.now(timezone.utc))
        read_token = credentials["cfRead"]
        write_token = credentials["cfDeploy"]
        promote(boundary, target, credentials, approval, read, write)


if __name__ == "__main__":
    try:
        main(os.environ)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise SystemExit("Required production evidence was incomplete or malformed. Check provider state before retrying.") from None
