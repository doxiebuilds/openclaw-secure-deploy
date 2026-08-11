#!/usr/bin/env python3
"""Allowlisting forward proxy. Default deny.

WHY THIS EXISTS
Cell 1 (scout) is the only cell with a route to the public internet, because
fetching public sources is its entire job. That makes it the one place where a
successful prompt injection could exfiltrate — so its reach is narrowed to the
hosts its jobs actually need. Everything else, including RFC1918, the Docker
host gateway and the cloud metadata address, is refused.

DEFAULT DENY IS THE POINT. An allowlist that fails open when it cannot parse a
request is not an allowlist. Every path that cannot positively identify an
allowed host returns 403.

WHAT THIS DOES NOT DO
It does not inspect TLS payloads. For an https:// target the client issues
CONNECT and the proxy either refuses or opens an opaque tunnel to the named
host. So this controls WHERE scout can talk, never WHAT it says — which is the
right split: content inspection of an encrypted channel would mean terminating
TLS, and a proxy holding the certificate authority for the agent's traffic is a
worse thing to own than the risk it removes.

IT ONLY WORKS IF THE CLIENT USES IT. Nothing here forces traffic through the
proxy; that is the container's network topology and the HTTPS_PROXY environment
variable. Verify with the negative test in docs/security_verification.md rather
than assuming: a client that ignores the proxy variables reaches the internet
directly and this file is decoration.
"""

import ipaddress
import os
import select
import socket
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

ALLOWED = {
    h.strip().lower()
    for h in os.environ.get("EGRESS_ALLOW", "").split(",")
    if h.strip()
}
LISTEN_PORT = int(os.environ.get("EGRESS_PORT", "3128"))
MAX_BYTES = int(os.environ.get("EGRESS_MAX_BYTES", str(8 * 1024 * 1024)))
CONNECT_TIMEOUT = 15
IDLE_TIMEOUT = 120


def log(msg):
    # Unbuffered: this is the audit trail for what scout tried to reach, and a
    # buffered log that dies with the container is not an audit trail.
    print(f"egress-proxy: {msg}", file=sys.stderr, flush=True)


def host_allowed(host):
    """Exact host match only. No suffix wildcards.

    A rule like ".github.com" would also admit "evil.github.com.attacker.net"
    under a sloppy check, and even done correctly a wildcard admits every
    subdomain an attacker can get issued. The list is short; keep it literal.
    """
    if not host:
        return False
    host = host.lower().strip("[]")
    if host in ALLOWED:
        return True
    # An IP literal is never allowlisted: it is the standard way to skip a
    # name-based rule, and every legitimate destination here has a name.
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return False


def resolve_is_public(host):
    """Refuse names that resolve into private space (DNS rebinding).

    An allowlisted name whose A record points at 169.254.169.254 or 10.x would
    otherwise be a clean path to cloud metadata or the Docker host.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False, "dns-failure"
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False, f"unparseable-address:{addr}"
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        ):
            return False, f"private-address:{addr}"
    return True, None


def pump(a, b):
    """Bidirectional copy with a byte cap."""
    total = 0
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, IDLE_TIMEOUT)
            if x or not r:
                return
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                total += len(data)
                if total > MAX_BYTES:
                    log(f"cap {MAX_BYTES} exceeded; closing tunnel")
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # BaseHTTPRequestHandler logs to stderr with a noisy format; route it
    # through ours so every decision is one greppable line.
    def log_message(self, fmt, *args):
        return

    def _deny(self, host, why):
        log(f"DENY {self.command} {host!r} ({why})")
        body = b"egress denied by allowlist\n"
        try:
            self.send_response(403)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def _check(self, host):
        if not host_allowed(host):
            self._deny(host, "not-in-allowlist")
            return False
        ok, why = resolve_is_public(host)
        if not ok:
            self._deny(host, why)
            return False
        return True

    def do_CONNECT(self):
        host, _, port = self.path.rpartition(":")
        host = host.strip("[]")
        try:
            port = int(port)
        except ValueError:
            return self._deny(self.path, "unparseable-port")
        if port not in (443, 8080):
            return self._deny(host, f"port-not-allowed:{port}")
        if not self._check(host):
            return
        try:
            upstream = socket.create_connection((host, port), CONNECT_TIMEOUT)
        except OSError as exc:
            return self._deny(host, f"upstream-unreachable:{exc}")
        log(f"ALLOW CONNECT {host}:{port}")
        try:
            self.send_response(200, "Connection Established")
            self.end_headers()
            self.connection.setblocking(True)
            pump(self.connection, upstream)
        finally:
            upstream.close()

    def _do_plain(self):
        parts = urlsplit(self.path)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return self._deny(self.path, "not-an-absolute-http-url")
        if not self._check(parts.hostname):
            return
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port not in (80, 443, 8080):
            return self._deny(parts.hostname, f"port-not-allowed:{port}")
        try:
            upstream = socket.create_connection((parts.hostname, port), CONNECT_TIMEOUT)
        except OSError as exc:
            return self._deny(parts.hostname, f"upstream-unreachable:{exc}")
        log(f"ALLOW {self.command} {parts.hostname}:{port}{parts.path}")
        try:
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            req = [f"{self.command} {path} HTTP/1.1"]
            for k, v in self.headers.items():
                if k.lower() in ("proxy-connection", "proxy-authorization"):
                    continue
                req.append(f"{k}: {v}")
            req.append("Connection: close")
            upstream.sendall(("\r\n".join(req) + "\r\n\r\n").encode("latin-1"))
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                upstream.sendall(self.rfile.read(min(length, MAX_BYTES)))
            self.connection.setblocking(True)
            pump(self.connection, upstream)
        finally:
            upstream.close()

    do_GET = do_POST = do_HEAD = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _do_plain


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    if not ALLOWED:
        # Fail closed at startup rather than silently proxying nothing, or —
        # worse — being read as "no allowlist configured means allow all".
        log("FATAL: EGRESS_ALLOW is empty; refusing to start")
        sys.exit(1)
    log(f"listening on :{LISTEN_PORT}; allow={sorted(ALLOWED)}")
    Server(("0.0.0.0", LISTEN_PORT), Handler).serve_forever()
