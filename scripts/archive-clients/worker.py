#!/usr/bin/env python3
"""One isolated low-level S3 client/profile; no high-level transfer manager."""

import argparse
import base64
import hashlib
import http.client
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


sys.path.insert(0, str(Path(__file__).resolve().parent))
from contract import ROWS

OPAQUE = bytes(range(256)) + b"\x00opaque-fixture\xff"
METADATA = {"fixture": "archive-v1"}
CONTENT_TYPE = "application/octet-stream"
KEY = "opaque/%2F +/café/../payload.bin"
MAX_POLLS = 8


def digest(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def serializable(value):
    if isinstance(value, bytes):
        return {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
    if isinstance(value, dict):
        return {k: serializable(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [serializable(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


class S3Failure(Exception):
    def __init__(self, status, code):
        super().__init__(f"S3 {status}: {code}")
        self.status, self.code = status, code


class Client:
    def __init__(self, args, evidence):
        self.args, self.evidence = args, evidence
        self.restrictive = args.profile.endswith("restrictive")
        self.sequence = 0
        self.trace = []
        self.client = None
        if args.profile.startswith("boto3"):
            config = Config()
            if self.restrictive:
                config = Config(
                    region_name="us-east-1", signature_version="s3v4",
                    s3={"addressing_style": "path", "payload_signing_enabled": True},
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"mode": "standard", "total_max_attempts": 1},
                    connect_timeout=2, read_timeout=3,
                )
            self.client = boto3.client(
                "s3", endpoint_url=args.endpoint, region_name="us-east-1",
                aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
                verify=os.environ["QERITH_CLIENT_CERT"], config=config,
            )
            cfg = self.client.meta.config
            self.settings = {key: getattr(cfg, key) for key in (
                "region_name", "signature_version", "s3", "retries", "connect_timeout",
                "read_timeout", "request_checksum_calculation", "response_checksum_validation",
            )}
        else:
            self.settings = {
                "config": Path(os.environ["AWS_CONFIG_FILE"]).read_text(),
                "retry_timeouts": "vendor defaults" if not self.restrictive else
                    "standard; max_attempts=1; connect=2s; read=3s",
            }

    def call(self, operation, **parameters):
        self.sequence += 1
        entry = {"sequence": self.sequence, "operation": operation,
                 "parameters": serializable(parameters)}
        self.trace.append(entry)
        try:
            if self.client:
                result = getattr(self.client, operation)(**parameters)
                if "Body" in result:
                    with result["Body"] as body:
                        result["Body"] = body.read(1024 * 1024 + 1)
                    assert len(result["Body"]) <= 1024 * 1024, "response body bound"
            else:
                result = self.cli(operation, parameters)
            entry["response"] = serializable(result)
            return result
        except ClientError as error:
            result = error.response
            entry["error"] = serializable(result)
            raise S3Failure(result["ResponseMetadata"]["HTTPStatusCode"],
                            result["Error"]["Code"]) from error
        except Exception as error:
            entry["error"] = str(error)[:4096]
            raise
        finally:
            (self.evidence / "calls.json").write_text(json.dumps(self.trace, indent=2) + "\n")

    def cli(self, operation, parameters):
        parameters = dict(parameters)
        command = [os.environ["QERITH_AWS_CLI"], "--endpoint-url", self.args.endpoint,
                   "--region", "us-east-1", "--output", "json", "--no-cli-pager"]
        if self.restrictive:
            command += ["--cli-connect-timeout", "2", "--cli-read-timeout", "3"]
        command += ["--debug", "s3api", operation.replace("_", "-")]
        if isinstance(parameters.get("CopySource"), dict):
            source = parameters["CopySource"]
            parameters["CopySource"] = quote(source["Bucket"] + "/" + source["Key"], safe="/")
        if "Body" in parameters:
            body = self.evidence / f"body-{self.sequence}.bin"
            body.write_bytes(parameters.pop("Body"))
            command += ["--body", str(body)]
        command += ["--cli-input-json", json.dumps(parameters)]
        output = self.evidence / f"get-{self.sequence}.bin"
        if operation == "get_object":
            command.append(str(output))
        completed = subprocess.run(command, capture_output=True, timeout=20, check=False)
        # Debug supplies the actual HTTP status absent from normal s3api JSON.
        # The parent runner strips ambient credentials; these logs are synthetic only.
        (self.evidence / f"cli-{self.sequence}.stderr").write_bytes(completed.stderr[:262144])
        text = completed.stderr.decode("utf-8", errors="replace")
        statuses = re.findall(r'"[A-Z]+ [^\r\n]* HTTP/1\.[01]" (\d{3}) ', text)
        status = int(statuses[-1]) if statuses else None
        if completed.returncode:
            match = re.search(r"An error occurred \(([^)]+)\)", text)
            if not match:
                raise RuntimeError(f"CLI exit {completed.returncode}: {text[:2048]}")
            raise S3Failure(status, match.group(1))
        assert status is not None, "CLI debug trace contained no HTTP status"
        result = json.loads(completed.stdout or b"{}")
        result["ResponseMetadata"] = {"HTTPStatusCode": status}
        if operation == "get_object":
            assert output.stat().st_size <= 1024 * 1024, "CLI GET body bound"
            result["Body"] = output.read_bytes()
        return result

    def expect_error(self, operation, codes, status=None, **parameters):
        try:
            self.call(operation, **parameters)
        except S3Failure as error:
            assert error.code in codes, f"wanted {codes}, got {error.code}"
            if status is not None and error.status is not None:
                assert error.status == status, (error.status, status)
            return {"code": error.code, "status": error.status}
        raise AssertionError(f"{operation} unexpectedly succeeded")


def control(args, command):
    parsed = urlsplit(args.upstream)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    try:
        connection.request("POST", f"/__fixture/{command}", body=b"",
                           headers={"Authorization": f"Bearer {args.control_token}"})
        response = connection.getresponse()
        body = response.read(65537)
        assert len(body) <= 65536, "control response bound"
        assert response.status == 200, f"fixture {command}: {response.status}"
        result = json.loads(body)
        assert isinstance(result, dict), "control must return a JSON object"
        return result
    finally:
        connection.close()


class Matrix:
    def __init__(self, args, evidence):
        self.args, self.evidence = args, evidence
        self.client = Client(args, evidence)
        self.bucket = f"qerith-{args.profile}"
        self.object = {"Bucket": self.bucket, "Key": KEY}
        self.rows = []
        self.baseline = None
        self.upload_id = None

    def row(self, name, action, fatal=True):
        assert name == ROWS[len(self.rows)], name
        first_call = self.client.sequence + 1
        try:
            observed = action()
            self.rows.append({"id": name, "outcome": "pass", "observed": serializable(observed)})
        except Exception as error:
            self.rows.append({"id": name, "outcome": "fail",
                              "error": f"{type(error).__name__}: {error}"[:4096]})
            if fatal:
                raise
        finally:
            self.rows[-1]["trace"] = {"artifact": "calls.json", "first_call": first_call,
                                       "last_call": self.client.sequence}
            self.save()

    def save(self):
        observed = {row["id"]: row for row in self.rows}
        rows = [dict(observed.get(name, {"id": name, "outcome": "unqualified",
                                        "reason": "predecessor did not complete"}),
                     must_pass=self.client.restrictive) for name in ROWS]
        result = {"profile": self.args.profile, "settings": self.client.settings,
                  "rows": rows, "qualified": all(r["outcome"] == "pass" for r in rows)}
        (self.evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")

    def check_head(self, state):
        head = self.client.call("head_object", **self.object, ChecksumMode="ENABLED")
        stable = {k: head.get(k) for k in (
            "ContentLength", "ETag", "LastModified", "ContentType", "CacheControl", "Metadata",
            "ChecksumSHA256", "ChecksumCRC32", "ChecksumType",
        )}
        assert head["ContentLength"] == len(OPAQUE)
        assert head["ContentType"] == CONTENT_TYPE
        assert head["Metadata"] == METADATA
        assert head["CacheControl"] == "no-cache"
        if self.baseline is None:
            self.baseline = stable
            if self.client.restrictive:
                assert head["ChecksumSHA256"] == digest(OPAQUE)
        else:
            assert stable == self.baseline, (stable, self.baseline)
        restore = head.get("Restore")
        if state == "none":
            assert restore is None, restore
        elif state == "pending":
            assert restore == 'ongoing-request="true"', restore
        else:
            assert restore and 'ongoing-request="false"' in restore and 'expiry-date="' in restore
        return head

    def cold(self, **parameters):
        return self.client.expect_error("get_object", ["InvalidObjectState"], 403,
                                        **self.object, **parameters)

    def upload(self):
        options = {"ChecksumAlgorithm": "SHA256", "ChecksumSHA256": digest(OPAQUE)} if self.client.restrictive else {}
        return self.client.call("put_object", **self.object, Body=OPAQUE,
                                ContentType=CONTENT_TYPE, CacheControl="no-cache", Metadata=METADATA,
                                **options)

    def list_pages(self):
        for key in ("list-a.bin", "list-b.bin"):
            options = {"ChecksumAlgorithm": "SHA256", "ChecksumSHA256": digest(OPAQUE)} if self.client.restrictive else {}
            self.client.call("put_object", Bucket=self.bucket, Key=key, Body=OPAQUE, **options)
        token, keys = None, []
        for page in range(MAX_POLLS):
            params = {"Bucket": self.bucket, "MaxKeys": 1, "EncodingType": "url"}
            if token is not None:
                params["ContinuationToken"] = token
            result = self.client.call("list_objects_v2", **params)
            keys.extend(item["Key"] for item in result.get("Contents", []))
            if not result.get("IsTruncated"):
                assert quote(KEY, safe="") in keys, keys
                assert page >= 2 and len(keys) == 3, "pagination not exercised"
                return {"encoded_keys": keys, "pages": page + 1}
            next_token = result["NextContinuationToken"]
            assert next_token != token, "non-advancing continuation token"
            token = next_token
        raise AssertionError("listing exceeded application page bound")

    def multipart(self):
        obj = {"Bucket": self.bucket, "Key": "multipart.bin"}
        options = {"ChecksumAlgorithm": "SHA256", "ChecksumType": "COMPOSITE"} if self.client.restrictive else {}
        start = self.client.call("create_multipart_upload", **obj, ContentType=CONTENT_TYPE,
                                 Metadata=METADATA, **options)
        upload = {**obj, "UploadId": start["UploadId"]}
        parts = []
        for number, data in ((1, bytes(range(256))), (2, bytes(reversed(range(256))))):
            options = {"ChecksumAlgorithm": "SHA256", "ChecksumSHA256": digest(data)} if self.client.restrictive else {}
            result = self.client.call("upload_part", **upload, PartNumber=number, Body=data, **options)
            part = {"PartNumber": number, "ETag": result["ETag"]}
            part.update({key: value for key, value in result.items() if key.startswith("Checksum")})
            parts.append(part)
        listed = self.client.call("list_parts", **upload)
        assert [p["PartNumber"] for p in listed["Parts"]] == [1, 2]
        result = self.client.call("complete_multipart_upload", **upload, MultipartUpload={"Parts": parts})
        assert result["Key"] == obj["Key"] and result["Bucket"] == self.bucket
        self.client.expect_error("get_object", ["InvalidObjectState"], 403, **obj)
        return result

    def abort(self):
        obj = {"Bucket": self.bucket, "Key": "aborted.bin"}
        upload = self.client.call("create_multipart_upload", **obj)
        params = {**obj, "UploadId": upload["UploadId"]}
        self.client.call("abort_multipart_upload", **params)
        return self.client.expect_error("upload_part", ["NoSuchUpload"], 404,
                                        **params, PartNumber=1, Body=b"aborted")

    def restore_request(self, expected=202):
        result = self.client.call("restore_object", **self.object, RestoreRequest={"Days": 1})
        assert result["ResponseMetadata"]["HTTPStatusCode"] == expected, result
        return result

    def pending(self):
        self.check_head("pending")
        self.cold()
        return self.client.expect_error("restore_object", ["RestoreAlreadyInProgress"], 409,
                                        **self.object, RestoreRequest={"Days": 1})

    def pending_restart(self):
        result = control(self.args, "restart")
        self.check_head("pending")
        self.cold()
        return result

    def get(self, ranged=False):
        params = {"Range": "bytes=1-31"} if ranged else {"ChecksumMode": "ENABLED"}
        result = self.client.call("get_object", **self.object, **params)
        assert result["Body"] == (OPAQUE[1:32] if ranged else OPAQUE)
        if ranged:
            assert result["ContentRange"] == f"bytes 1-31/{len(OPAQUE)}"
        else:
            assert result["ETag"] == self.baseline["ETag"]
            if self.client.restrictive:
                assert result["ChecksumSHA256"] == digest(OPAQUE)
        return result

    def condition(self):
        return self.client.expect_error("get_object", ["304", "NotModified"], 304,
                                        **self.object, IfNoneMatch=self.baseline["ETag"])

    def restored_copy(self):
        result = self.client.call("copy_object", Bucket=self.bucket, Key="copy.bin",
                                  CopySource={"Bucket": self.bucket, "Key": KEY})
        head = self.client.call("head_object", Bucket=self.bucket, Key="copy.bin")
        assert head["Metadata"] == METADATA and head["ContentLength"] == len(OPAQUE)
        self.client.expect_error("get_object", ["InvalidObjectState"], 403,
                                  Bucket=self.bucket, Key="copy.bin")
        return result

    def expire(self):
        result = control(self.args, "expire")
        self.check_head("none")
        self.cold()
        return result

    def failed_restore(self):
        control(self.args, "fail")
        self.restore_request()
        result = control(self.args, "restore")
        self.check_head("none")
        self.cold()
        return result

    def missing(self):
        results = [self.client.expect_error("get_object", ["NoSuchKey"], 404,
                                            Bucket=self.bucket, Key="absent.bin")]
        results.append(self.client.expect_error("head_object", ["404", "NotFound"], 404,
                                                Bucket=self.bucket, Key="absent.bin"))
        results.append(self.client.expect_error("head_bucket", ["403", "AccessDenied"], 403,
                                                Bucket="qerith-absent-bucket"))
        return results

    def delete(self):
        keys = [KEY, "multipart.bin", "copy.bin", "list-a.bin", "list-b.bin", "absent.bin"]
        result = self.client.call("delete_objects", Bucket=self.bucket,
                                  Delete={"Objects": [{"Key": key} for key in keys]})
        assert not result.get("Errors"), result
        assert sorted(item["Key"] for item in result["Deleted"]) == sorted(keys)
        self.client.call("delete_object", **self.object)
        self.client.expect_error("get_object", ["NoSuchKey"], 404, **self.object)
        return result

    def run(self):
        c = self.client
        self.row("create-bucket", lambda: c.call("create_bucket", Bucket=self.bucket))
        self.row("bucket-inventory", self.inventory)
        self.row("put-object", self.upload)
        self.row("retained-head", lambda: self.check_head("none"))
        self.row("retained-get-denied", self.cold)
        self.row("cold-copy-denied", lambda: c.expect_error("copy_object", ["InvalidObjectState"], 403,
            Bucket=self.bucket, Key="copy.bin", CopySource={"Bucket": self.bucket, "Key": KEY}))
        self.row("conditional-before-restore", self.condition)
        self.row("list-pagination", self.list_pages)
        self.row("multipart", self.multipart)
        self.row("abort-multipart", self.abort)
        self.row("archive-empty-cache", lambda: control(self.args, "archive"))
        self.row("before-restore", lambda: [self.check_head("none"), self.cold()])
        self.row("restore-admission", self.restore_request)
        self.row("pending-restore", self.pending)
        self.row("pending-restart", self.pending_restart)
        self.row("whole-generation-restore", lambda: control(self.args, "restore"))
        self.row("completed-head", lambda: self.check_head("complete"))
        self.row("completed-get", self.get)
        self.row("range-get", lambda: self.get(True))
        self.row("conditional-completed", self.conditions_completed)
        self.row("restored-copy", self.restored_copy, fatal=False)
        self.row("renew-restore", lambda: self.restore_request(200))
        self.row("expired-restore", self.expire)
        self.row("restore-io-failure", self.failed_restore)
        self.row("missing-errors", self.missing)
        self.row("delete-nonempty-bucket", lambda: c.expect_error("delete_bucket", ["BucketNotEmpty"], 409,
                                                                 Bucket=self.bucket))
        self.row("delete-objects", self.delete)
        self.row("delete-bucket", lambda: c.call("delete_bucket", Bucket=self.bucket))

    def inventory(self):
        result = self.client.call("list_buckets")
        assert self.bucket in [b["Name"] for b in result["Buckets"]]
        self.client.call("head_bucket", Bucket=self.bucket)
        self.client.call("get_bucket_location", Bucket=self.bucket)
        return result

    def conditions_completed(self):
        return [self.condition(), self.client.expect_error("get_object", ["PreconditionFailed"], 412,
                    **self.object, IfMatch='"different"'),
                self.client.expect_error("get_object", ["InvalidRange"], 416,
                    **self.object, Range="bytes=99999-")]


def main():
    parser = argparse.ArgumentParser()
    for name in ("profile", "endpoint", "upstream", "control-token", "evidence"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    evidence = Path(args.evidence)
    evidence.mkdir(parents=True, exist_ok=True)
    matrix = Matrix(args, evidence)
    matrix.save()
    try:
        matrix.run()
    finally:
        if matrix.client.client:
            matrix.client.client.close()
        matrix.save()


if __name__ == "__main__":
    main()
