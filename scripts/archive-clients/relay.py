#!/usr/bin/env python3
"""Bounded loopback TLS termination, deliberately without an HTTP parser."""

import contextlib
import ipaddress
import json
import select
import socket
import ssl
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit


MAX_CONNECTIONS = 1024
MAX_ACTIVE = 8
MAX_STREAM_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
CONNECTION_SECONDS = 45
IDLE_SECONDS = 10


def loopback_upstream(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not parsed.port or not ipaddress.ip_address(parsed.hostname).is_loopback):
        raise ValueError("upstream must be an explicit plain-HTTP loopback port")
    return parsed.hostname, parsed.port


class Relay:
    def __init__(self, upstream, cert, key, evidence):
        self.upstream = loopback_upstream(upstream)
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.context.load_cert_chain(cert, key)
        self.evidence = Path(evidence)
        self.evidence.mkdir(parents=True, exist_ok=True)
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(MAX_ACTIVE)
        self.listener.settimeout(0.2)
        self.endpoint = f"https://127.0.0.1:{self.listener.getsockname()[1]}"
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(MAX_ACTIVE)
        self.threads = []
        self.connections = 0
        self.total_bytes = 0
        self.errors = []
        self.thread = threading.Thread(target=self.accept, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.listener.close()
        self.thread.join(timeout=2)
        for thread in self.threads:
            thread.join(timeout=6)
        if self.thread.is_alive() or any(t.is_alive() for t in self.threads):
            self.errors.append("relay thread did not terminate within cleanup bound")
        (self.evidence / "relay.json").write_text(json.dumps({
            "connections": self.connections, "bytes": self.total_bytes,
            "errors": self.errors,
        }, indent=2) + "\n")

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if self.connections >= MAX_CONNECTIONS or not self.slots.acquire(blocking=False):
                client.close()
                self.errors.append("relay connection admission bound exceeded")
                continue
            self.connections += 1
            thread = threading.Thread(target=self.forward, args=(client, self.connections), daemon=True)
            self.threads.append(thread)
            thread.start()

    def forward(self, raw_client, number):
        started = time.monotonic()
        trace = {"connection": number, "request_bytes": 0, "response_bytes": 0}
        stem = self.evidence / f"connection-{number:04d}"
        try:
            raw_client.settimeout(5)
            with self.context.wrap_socket(raw_client, server_side=True) as client:
                with socket.create_connection(self.upstream, timeout=5) as server:
                    with stem.with_suffix(".request.bin").open("wb") as request:
                        with stem.with_suffix(".response.bin").open("wb") as response:
                            streams = [(client, server, request, "request_bytes"),
                                       (server, client, response, "response_bytes")]
                            last_activity = time.monotonic()
                            while not self.stop.is_set():
                                now = time.monotonic()
                                if now - started > CONNECTION_SECONDS or now - last_activity > IDLE_SECONDS:
                                    raise TimeoutError("relay connection/idle deadline")
                                # SSL may hold decrypted bytes even when the FD is not readable.
                                ready, _, _ = select.select([client, server], [], [], 0.2)
                                if client.pending() and client not in ready:
                                    ready.append(client)
                                for source, target, output, field in streams:
                                    if source not in ready:
                                        continue
                                    data = source.recv(65536)
                                    if not data:
                                        return
                                    last_activity = time.monotonic()
                                    trace[field] += len(data)
                                    with self.lock:
                                        self.total_bytes += len(data)
                                        over_budget = self.total_bytes > MAX_TOTAL_BYTES
                                    if trace[field] > MAX_STREAM_BYTES or over_budget:
                                        raise ValueError("relay byte budget exceeded")
                                    output.write(data)
                                    # No header rewriting, URL parsing, dechunking or reserialization.
                                    target.sendall(data)
        except Exception as error:
            trace["error"] = f"{type(error).__name__}: {error}"
            if not isinstance(error, (ConnectionError, ssl.SSLError)) and not self.stop.is_set():
                with self.lock:
                    self.errors.append(trace["error"])
        finally:
            with contextlib.suppress(OSError):
                raw_client.close()
            stem.with_suffix(".json").write_text(json.dumps(trace, indent=2) + "\n")
            self.slots.release()
