#!/usr/bin/env python3
"""Single-destination TCP forwarder.

WHY THIS EXISTS
Cells 2 and 3 (curator, main) must reach the local Qwen inference
endpoint and nothing else. Docker cannot express that directly: a container
attached to a normal bridge network reaches the host gateway AND the whole
internet through the same default route, and a network marked `internal: true`
has no gateway at all — so it also cannot reach the host.

The resolution is topological rather than rule-based. Those cells sit on an
`internal: true` network with no route off it. This forwarder is the only
dual-homed member, and it accepts on the internal side and connects to exactly
one hard-coded destination on the outside. The clients point their model
baseUrl at this service instead of at host.docker.internal.

The result is a capability, not a filter: there is no allowlist to keep in
sync, no proxy variable the client has to honour, and no second destination
reachable by any request — because the destination is not taken from the
request at all. A compromised curator can talk to the inference endpoint and
has nowhere else to go.
"""

import os
import select
import socket
import socketserver
import sys

TARGET_HOST = os.environ.get("FORWARD_TO_HOST", "host.docker.internal")
TARGET_PORT = int(os.environ.get("FORWARD_TO_PORT", "1234"))
LISTEN_PORT = int(os.environ.get("FORWARD_LISTEN_PORT", "1234"))
CONNECT_TIMEOUT = 10
IDLE_TIMEOUT = 300


def log(msg):
    print(f"tcp-forward: {msg}", file=sys.stderr, flush=True)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        peer = self.client_address[0]
        try:
            upstream = socket.create_connection(
                (TARGET_HOST, TARGET_PORT), CONNECT_TIMEOUT
            )
        except OSError as exc:
            log(f"{peer} -> upstream unreachable: {exc}")
            return
        try:
            socks = [self.request, upstream]
            while True:
                r, _, x = select.select(socks, [], socks, IDLE_TIMEOUT)
                if x or not r:
                    return
                for s in r:
                    data = s.recv(65536)
                    if not data:
                        return
                    (upstream if s is self.request else self.request).sendall(data)
        except OSError:
            return
        finally:
            upstream.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    log(f"listening on :{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT} (fixed)")
    Server(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
