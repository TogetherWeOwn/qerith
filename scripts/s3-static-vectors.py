#!/usr/bin/env python3
"""Generate synthetic STATIC fixtures, not client certification. No network calls.

Run with python3 -I scripts/s3-static-vectors.py using botocore==1.34.46.
Pinned upstream: fdee2825e01b4c3e7bc7c6f21ee384bebf7b9e0c (Apache-2.0).
This uses the installed SDK, never downloaded source or a handwritten signer.
"""
import datetime
import json
from pathlib import Path
from unittest.mock import patch

import botocore
from botocore.auth import S3SigV4Auth, S3SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

assert botocore.__version__ == "1.34.46"
CREDS = Credentials("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
HOST = "s3.us-east-1.amazonaws.com"
DATE = datetime.datetime(2013, 5, 24)
CASES = [
    ("header-empty", "GET", "/bucket/key", {}, b"", False, False),
    ("header-put", "PUT", "/bucket/key", {"Content-Length": "3"}, b"abc", False, False),
    ("encoded-path", "GET", "/bucket/A//./../%E9%9B%AA+%2B%25%2f", {}, b"", False, False),
    ("query-order", "GET", "/bucket/key?prefix=%E9%9B%AA%2B%25&delimiter=%2F&list-type=2", {}, b"", False, False),
    ("empty-query", "GET", "/bucket/key?uploads", {}, b"", False, False),
    ("repeated-query", "GET", "/bucket/key?z=2&z=1&Z=&=x&&plus=+&percent=%25", {}, b"", False, True),
    ("header-whitespace", "PUT", "/bucket/key", {"Content-Length": "3", "X-Amz-Meta-Name": "  a\t b   c  "}, b"abc", False, False),
    ("signed-metadata", "PUT", "/bucket/key", {"Content-Length": "3", "Content-Disposition": 'attachment; filename="a  b.txt"', "Cache-Control": "private, no-store", "Expires": "Sat, 25 May 2013 00:00:00 GMT", "Content-Language": "en"}, b"abc", False, False),
    ("presign-get", "GET", "/bucket/key", {}, b"", True, False),
    ("presign-put", "PUT", "/bucket/key", {"Content-Length": "3", "Content-MD5": "kAFQmDzST7DWlj99KOF/cg=="}, b"abc", True, False),
    ("presign-head", "HEAD", "/bucket/key", {}, b"", True, False),
]
rows = []
for name, method, target, headers, body, presigned, canonical_only in CASES:
    req = AWSRequest(method=method, url=f"https://{HOST}{target}", headers=headers, data=None if presigned else body)
    signer = S3SigV4QueryAuth(CREDS, "s3", "us-east-1", expires=60) if presigned else S3SigV4Auth(CREDS, "s3", "us-east-1")
    with patch("botocore.auth.datetime.datetime") as clock:
        clock.utcnow.return_value = DATE
        signer.add_auth(req)
    signed_target = req.url.removeprefix(f"https://{HOST}")
    # Authorization is added after the canonical request is calculated.
    auth = req.headers.get("Authorization")
    if auth:
        signed = auth.split("SignedHeaders=")[1].split(",")[0]
        del req.headers["Authorization"]
    else:
        signed = "content-length;content-md5;host" if method == "PUT" else "host"
        req.url = req.url.split("&X-Amz-Signature=")[0]
    canonical = signer.canonical_request(req)
    fields = list(req.headers.items()) + [("Host", HOST)]
    if auth:
        fields.append(("Authorization", auth))
    rows.append(dict(name=name, method=method, target=signed_target, headers=fields,
                     signed_headers=signed, canonical=canonical, body=body.decode(),
                     presigned=presigned, canonical_only=canonical_only))
output = Path(__file__).resolve().parents[1] / "crates/qerith-core/tests/fixtures/s3-static.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(rows, indent=2) + "\n")
