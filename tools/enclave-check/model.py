#!/usr/bin/env python3
"""Config files -> a trust topology graph.

This module is deliberately dumb about security policy: it knows how to READ a
multi-container agent deployment (compose files, agent configs, a guard plugin,
two proxy implementations) and turn it into a graph of services, networks,
mounts, credentials, models and directed egress edges. Every security judgement
lives in check.py + invariants.yaml, never here.

Three things it refuses to guess about, because guessing wrong inverts answers:

  1. COMPOSE MERGE SEMANTICS. `docker compose -f a.yml -f b.yml` MERGES most
     keys. A `networks:` list in the override is APPENDED to the base list, so
     an override that "moves" a service actually leaves it dual-homed. Only the
     `!override` tag replaces, and only `!reset` removes. Both are modelled.

  2. PROXY MATCHING SEMANTICS. egress-proxy.py matches EGRESS_ALLOW by EXACT
     lowercased host, with no suffix wildcards, and refuses IP literals even
     when they are listed. A checker that assumed suffix matching would report
     reachability that does not exist.

  3. FORWARDER TRANSITIVITY. tcp-forward.py dials exactly
     FORWARD_TO_HOST:FORWARD_TO_PORT and never relays between its own legs, so
     a dual-homed forwarder is a directed edge to ONE host:port, not a bridge.
     Modelling it as a bridge would make every internal network look routable.

Anything the model cannot determine is recorded as an Unknown rather than
defaulted, so a check can return UNKNOWN instead of a confident wrong answer.

No third-party imports. See README.md for why there is a YAML loader in here.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
from urllib.parse import urlsplit


class ModelError(Exception):
    """The inputs could not be modelled. Never swallowed into a PASS."""


# ─────────────────────────────────────────────────────────────────────────────
# Minimal YAML
#
# Python has no stdlib YAML and this tool takes no pip dependency, so this is a
# loader for the subset docker-compose files (and our own invariants.yaml)
# actually use: block maps, block sequences, flow sequences/maps, quoted and
# plain scalars, comments, block scalars (| >) and custom tags (!reset /
# !override). It does NOT implement anchors, aliases, tabs, multi-document
# streams or complex keys — all of which it REJECTS loudly with a file:line
# error rather than mis-parsing them into a confident wrong answer.
# ─────────────────────────────────────────────────────────────────────────────

class Tagged:
    """A value carrying a YAML tag, e.g. `networks: !override [default]`."""

    __slots__ = ("tag", "value")

    def __init__(self, tag, value):
        self.tag = tag
        self.value = value

    def __repr__(self):
        return f"!{self.tag} {self.value!r}"


class _Line:
    __slots__ = ("indent", "text", "no", "preparsed")

    def __init__(self, indent, text, no, preparsed=None):
        self.indent = indent
        self.text = text
        self.no = no
        # Block-scalar bodies are captured verbatim at scan time; the parser
        # must not comment-strip or re-indent them.
        self.preparsed = preparsed


_BLOCK_SCALAR_RE = re.compile(r"^(?P<key>.*?):\s*(?P<style>[|>])(?P<chomp>[-+]?)\s*$")
_ANCHOR_RE = re.compile(r"(^|[\s\[{,])[&*][A-Za-z_][\w-]*")


def _strip_comment(text):
    """Cut a trailing `#` comment, respecting quotes.

    `- net_executor   # internal: true` must not become a mapping.
    """
    out = []
    quote = None
    prev_ws = True
    for i, ch in enumerate(text):
        if quote:
            out.append(ch)
            if ch == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
            prev_ws = False
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(ch)
            prev_ws = False
            continue
        if ch == "#" and prev_ws:
            break
        out.append(ch)
        prev_ws = ch in " \t"
    return "".join(out).rstrip()


def _fold_block(body_lines, style, chomp):
    text = "\n".join(body_lines)
    if style == ">":
        out, para = [], []
        for line in body_lines:
            if line.strip():
                para.append(line.strip())
            else:
                out.append(" ".join(para))
                para = []
        out.append(" ".join(para))
        text = "\n".join(p for p in out)
    text = text.rstrip("\n")
    if chomp != "-":
        text += "\n"
    return text


def _scan_lines(text, origin):
    raw_lines = text.splitlines()
    lines = []
    i = 0
    while i < len(raw_lines):
        raw = raw_lines[i]
        no = i + 1
        i += 1
        if raw.strip().startswith("#") or not raw.strip():
            continue
        if "\t" in raw[: len(raw) - len(raw.lstrip())]:
            raise ModelError(f"{origin}:{no}: tab indentation is not supported")
        indent = len(raw) - len(raw.lstrip(" "))
        # Comments come off FIRST: `- net_x   # internal: true` must not be read
        # as a mapping, and a `*` in prose must not be read as an alias.
        stripped = _strip_comment(raw)
        if not stripped.strip():
            continue
        if _ANCHOR_RE.search(stripped):
            raise ModelError(f"{origin}:{no}: anchors/aliases are not supported")
        block = _BLOCK_SCALAR_RE.match(stripped.strip())
        if block and _map_split(block.group("key") + ":") is not None:
            body = []
            while i < len(raw_lines):
                nxt = raw_lines[i]
                if nxt.strip() and (len(nxt) - len(nxt.lstrip(" "))) <= indent:
                    break
                body.append(nxt)
                i += 1
            base = min(
                (len(b) - len(b.lstrip(" ")) for b in body if b.strip()), default=0
            )
            body = [b[base:] if b.strip() else "" for b in body]
            value = _fold_block(body, block.group("style"), block.group("chomp"))
            lines.append(
                _Line(indent, block.group("key").strip() + ":", no, preparsed=value)
            )
            continue
        lines.append(_Line(indent, stripped.strip(), no))
    return lines


def _map_split(text):
    """Index of the `:` separating key from value at depth 0, or None."""
    quote = None
    depth = 0
    for i, ch in enumerate(text):
        if quote:
            if ch == quote and (i == 0 or text[i - 1] != "\\"):
                quote = None
            continue
        if ch in ("'", '"'):
            quote = ch
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
        elif ch == ":" and depth == 0:
            if i + 1 == len(text) or text[i + 1] in " \t":
                return i
    return None


_INT_RE = re.compile(r"^[-+]?\d+$")
_FLOAT_RE = re.compile(r"^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$")


def _plain_scalar(s):
    if s in ("", "~", "null", "Null", "NULL"):
        return None
    if s in ("true", "True", "TRUE"):
        return True
    if s in ("false", "False", "FALSE"):
        return False
    if _INT_RE.match(s):
        return int(s)
    if _FLOAT_RE.match(s):
        return float(s)
    return s


def _read_quoted(s, i):
    quote = s[i]
    i += 1
    out = []
    while i < len(s):
        ch = s[i]
        if ch == "\\" and quote == '"' and i + 1 < len(s):
            nxt = s[i + 1]
            out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
            i += 2
            continue
        if ch == quote:
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    raise ModelError(f"unterminated quoted scalar: {s!r}")


def _parse_flow(s, i, origin, no):
    """Parse a flow collection or scalar starting at s[i]. -> (value, next_i)"""
    while i < len(s) and s[i] in " \t":
        i += 1
    if i >= len(s):
        return None, i
    if s[i] == "[":
        items = []
        i += 1
        while True:
            while i < len(s) and s[i] in " \t,":
                i += 1
            if i < len(s) and s[i] == "]":
                return items, i + 1
            if i >= len(s):
                raise ModelError(f"{origin}:{no}: unterminated flow sequence")
            val, i = _parse_flow(s, i, origin, no)
            items.append(val)
    if s[i] == "{":
        out = {}
        i += 1
        while True:
            while i < len(s) and s[i] in " \t,":
                i += 1
            if i < len(s) and s[i] == "}":
                return out, i + 1
            if i >= len(s):
                raise ModelError(f"{origin}:{no}: unterminated flow mapping")
            key, i = _parse_flow(s, i, origin, no)
            while i < len(s) and s[i] in " \t":
                i += 1
            if i >= len(s) or s[i] != ":":
                raise ModelError(f"{origin}:{no}: flow mapping key without ':'")
            i += 1
            val, i = _parse_flow(s, i, origin, no)
            out[key] = val
    if s[i] in ("'", '"'):
        return _read_quoted(s, i)
    j = i
    while j < len(s) and s[j] not in ",]}":
        j += 1
    return _plain_scalar(s[i:j].strip()), j


def _parse_scalar(text, origin, no):
    text = text.strip()
    if text[:1] in ("[", "{", "'", '"'):
        val, i = _parse_flow(text, 0, origin, no)
        rest = text[i:].strip()
        if rest:
            raise ModelError(f"{origin}:{no}: trailing content after scalar: {rest!r}")
        return val
    return _plain_scalar(text)


_TAG_RE = re.compile(r"^!([A-Za-z_][\w-]*)\s*(.*)$", re.S)


class _Parser:
    def __init__(self, lines, origin):
        self.lines = lines
        self.i = 0
        self.origin = origin

    def peek(self):
        return self.lines[self.i] if self.i < len(self.lines) else None

    def node(self, indent):
        ln = self.peek()
        if ln is None:
            return None
        if ln.text == "-" or ln.text.startswith("- "):
            return self.seq(indent)
        return self.map(indent)

    def _value_for(self, rest, ln, indent):
        tag = None
        m = _TAG_RE.match(rest) if rest.startswith("!") else None
        if m:
            tag, rest = m.group(1), m.group(2).strip()
        if rest == "":
            nxt = self.peek()
            value = self.node(nxt.indent) if nxt and nxt.indent > indent else None
        else:
            value = _parse_scalar(rest, self.origin, ln.no)
        return Tagged(tag, value) if tag else value

    def map(self, indent):
        out = {}
        while True:
            ln = self.peek()
            if ln is None or ln.indent != indent:
                break
            if ln.text == "-" or ln.text.startswith("- "):
                break
            split = _map_split(ln.text)
            if split is None:
                raise ModelError(
                    f"{self.origin}:{ln.no}: expected 'key: value', got {ln.text!r}"
                )
            key = _parse_scalar(ln.text[:split], self.origin, ln.no)
            rest = ln.text[split + 1 :].strip()
            self.i += 1
            if ln.preparsed is not None:
                out[key] = ln.preparsed
                continue
            out[key] = self._value_for(rest, ln, indent)
        return out

    def seq(self, indent):
        out = []
        while True:
            ln = self.peek()
            if ln is None or ln.indent != indent:
                break
            if not (ln.text == "-" or ln.text.startswith("- ")):
                break
            rest = ln.text[1:].lstrip()
            offset = len(ln.text) - len(rest)
            self.i += 1
            if rest == "":
                nxt = self.peek()
                out.append(self.node(nxt.indent) if nxt and nxt.indent > indent else None)
                continue
            if not rest.startswith("!") and _map_split(rest) is not None:
                child = indent + offset
                self.lines.insert(self.i, _Line(child, rest, ln.no))
                out.append(self.map(child))
                continue
            out.append(self._value_for(rest, ln, indent))
        return out


def load_yaml(text, origin="<string>"):
    lines = _scan_lines(text, origin)
    if not lines:
        return {}
    parser = _Parser(lines, origin)
    value = parser.node(lines[0].indent)
    if parser.i != len(parser.lines):
        ln = parser.lines[parser.i]
        raise ModelError(f"{origin}:{ln.no}: unexpected indentation at {ln.text!r}")
    return value


def load_yaml_file(path):
    with open(path, "r", encoding="utf-8") as fh:
        return load_yaml(fh.read(), origin=os.path.basename(path))


# ─────────────────────────────────────────────────────────────────────────────
# Interpolation
# ─────────────────────────────────────────────────────────────────────────────

_VAR_RE = re.compile(
    r"""\$(?:
        \{(?P<braced>[A-Za-z_]\w*)(?P<op>:-|-|:\?|\?)?(?P<default>[^}]*)\}
      | (?P<bare>[A-Za-z_]\w*)
    )""",
    re.X,
)

UNSET = "\x00UNSET\x00"


def load_dotenv(path):
    env = {}
    if not path or not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            if key.startswith("export "):
                key = key[7:].strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            env[key] = val
    return env


def interpolate_str(text, env, unresolved=None):
    """Expand ${VAR}, ${VAR:-default}, $VAR and a leading `~/`.

    Unresolvable variables are replaced with a UNSET-marked token and recorded,
    so a check that depends on one can answer UNKNOWN instead of guessing.
    """

    def repl(m):
        name = m.group("braced") or m.group("bare")
        default = m.group("default") or ""
        op = m.group("op")
        if name in env and (env[name] != "" or op in ("-", "?", None)):
            return env[name]
        if op in (":-", "-"):
            return default
        if unresolved is not None:
            unresolved.append(name)
        return f"{UNSET}{name}{UNSET}"

    out = _VAR_RE.sub(repl, text)
    if out.startswith("~/") or out == "~":
        home = env.get("HOME") or os.path.expanduser("~")
        out = home + out[1:]
    return out


def interpolate(obj, env, unresolved=None):
    if isinstance(obj, Tagged):
        return Tagged(obj.tag, interpolate(obj.value, env, unresolved))
    if isinstance(obj, dict):
        return {k: interpolate(v, env, unresolved) for k, v in obj.items()}
    if isinstance(obj, list):
        return [interpolate(v, env, unresolved) for v in obj]
    if isinstance(obj, str):
        return interpolate_str(obj, env, unresolved)
    return obj


def has_unset(value):
    return isinstance(value, str) and UNSET in value


def clean_unset(value):
    """Render an unresolved interpolation readably for output."""
    if not isinstance(value, str):
        return value
    return re.sub(re.escape(UNSET) + r"(\w+)" + re.escape(UNSET), r"${\1:UNSET}", value)


# ─────────────────────────────────────────────────────────────────────────────
# Compose merge
#
# Reference: compose-spec "Merging compose files". Sequences are APPENDED,
# mappings are merged key-by-key, scalars are replaced. `!override` replaces the
# whole value, `!reset` removes it. Getting append-vs-replace backwards on
# `networks:` is the specific bug this models around.
# ─────────────────────────────────────────────────────────────────────────────

_RESET = object()


def _merge_value(base, over, path, notes):
    if isinstance(over, Tagged):
        if over.tag == "reset":
            notes.append(f"!reset at {path}")
            return _RESET if over.value in (None, [], {}) else over.value
        if over.tag == "override":
            notes.append(f"!override at {path} (replaces, does not merge)")
            return over.value
        raise ModelError(f"unsupported YAML tag !{over.tag} at {path}")
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            merged = _merge_value(base.get(k), v, f"{path}.{k}", notes)
            if merged is _RESET:
                out.pop(k, None)
            else:
                out[k] = merged
        return out
    if isinstance(base, list) and isinstance(over, list):
        out = list(base)
        for item in over:
            if item not in out:
                out.append(item)
        notes.append(f"merged (appended) list at {path}: {base} + {over} -> {out}")
        return out
    return over


def merge_documents(docs, names=None):
    """Merge parsed compose documents left-to-right. Returns (doc, notes)."""
    notes = []
    if not docs:
        return {}, notes
    out = docs[0]
    for idx, doc in enumerate(docs[1:], 1):
        label = names[idx] if names else f"doc{idx}"
        merged = _merge_value(out, doc, label, notes)
        out = {} if merged is _RESET else merged
    return out, notes


# ─────────────────────────────────────────────────────────────────────────────
# Topology
# ─────────────────────────────────────────────────────────────────────────────

class Mount:
    __slots__ = ("source", "target", "mode", "raw", "kind")

    def __init__(self, source, target, mode, raw, kind):
        self.source = source          # expanded host path, or volume name
        self.target = target          # container path
        self.mode = mode              # "ro" | "rw"
        self.raw = raw
        self.kind = kind              # "bind" | "volume" | "unknown"

    @property
    def readonly(self):
        return self.mode == "ro"

    def __repr__(self):
        return f"<Mount {self.source}:{self.target}:{self.mode}>"


class Network:
    __slots__ = ("name", "internal", "declared", "external")

    def __init__(self, name, internal=False, declared=True, external=False):
        self.name = name
        self.internal = internal
        self.declared = declared
        self.external = external

    def __repr__(self):
        return f"<Network {self.name} internal={self.internal}>"


class AgentConfig:
    """A parsed openclaw.json, plus where it came from."""

    __slots__ = ("path", "data", "error")

    def __init__(self, path, data, error=None):
        self.path = path
        self.data = data or {}
        self.error = error

    @property
    def agents(self):
        return [a for a in ((self.data.get("agents") or {}).get("list") or []) if isinstance(a, dict)]

    @property
    def providers(self):
        return (self.data.get("models") or {}).get("providers") or {}

    @property
    def mcp_servers(self):
        return (self.data.get("mcp") or {}).get("servers") or {}

    @property
    def plugins_allow(self):
        return (self.data.get("plugins") or {}).get("allow") or []

    def plugin_entries_enabled(self):
        entries = (self.data.get("plugins") or {}).get("entries") or {}
        return {k: (v or {}).get("enabled") for k, v in entries.items()}

    @property
    def tools_profile(self):
        return (self.data.get("tools") or {}).get("profile")


class Service:
    def __init__(self, name, raw):
        self.name = name
        self.raw = raw or {}
        self.env = {}          # expanded
        self.env_raw = {}      # pre-interpolation, so ${X} is still visible
        self.network_names = []
        self.network_mode = None
        self.volumes = []
        self.secrets = []
        self.ports = []
        self.command = None
        self.image = self.raw.get("image")
        self.extra_hosts = []
        self.agent_config = None   # AgentConfig | None
        self.unknowns = []

    # ── mounts ────────────────────────────────────────────────────────────
    def mounts_ending(self, suffix):
        """Mounts whose HOST path ends on the given path segments.

        Segment-exact: `/exchange/briefs` does not match `/exchange/briefs-pending`.
        """
        suffix = "/" + suffix.strip("/")
        return [m for m in self.volumes if str(m.source).rstrip("/").endswith(suffix)]

    def targets_ending(self, suffix):
        suffix = "/" + suffix.strip("/")
        return [m for m in self.volumes if str(m.target).rstrip("/").endswith(suffix)]

    # ── credentials ───────────────────────────────────────────────────────
    def credential_evidence(self, name_patterns, placeholder_values):
        """(has_credential, [reasons]).

        A `${VAR}` that is unresolved at check time still counts: the launcher
        supplies it at runtime. Only a literal placeholder (`dummy`) does not.
        """
        reasons = []
        for s in self.secrets:
            reasons.append(f"secrets: {s}")
        for key, raw in self.env_raw.items():
            if not any(_glob(key, p) for p in name_patterns):
                continue
            expanded = self.env.get(key, "")
            if "$" in str(raw) or has_unset(expanded):
                reasons.append(f"env {key} (runtime-supplied: {clean_unset(raw)})")
            elif str(expanded).strip() in placeholder_values:
                continue
            else:
                reasons.append(f"env {key}")
        return (bool(reasons), reasons)

    # ── proxies / forwarders ──────────────────────────────────────────────
    @property
    def is_egress_proxy(self):
        return "EGRESS_ALLOW" in self.env

    def egress_allow(self):
        """Hosts this proxy will actually permit, using egress-proxy.py's rules.

        Exact lowercased host match only; IP literals are ALWAYS denied even
        when listed, so they are returned separately as dead entries.
        """
        allowed, dead = set(), set()
        for host in str(self.env.get("EGRESS_ALLOW", "")).split(","):
            host = host.strip().lower()
            if not host:
                continue
            if _is_ip_literal(host.strip("[]")):
                dead.add(host)
            else:
                allowed.add(host)
        return allowed, dead

    @property
    def forward_target(self):
        """(host, port) for a tcp-forward.py instance, else None."""
        cmd = self.command
        text = " ".join(cmd) if isinstance(cmd, list) else str(cmd or "")
        if "tcp-forward.py" not in text:
            return None
        return (self.env.get("FORWARD_TO_HOST"), self.env.get("FORWARD_TO_PORT"))

    def proxy_env(self):
        out = {}
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            if key in self.env:
                out[key] = self.env[key]
        return out

    def no_proxy_entries(self):
        """The UNION of both spellings, not the first one found.

        This read `self.env.get("NO_PROXY", self.env.get("no_proxy"))` until
        2026-08-08 — uppercase first, lowercase only as a fallback. compose sets
        BOTH on every proxied cell and HTTP clients honour either, so a hole
        punched in the lowercase spelling alone was invisible while the uppercase
        one stayed clean. Found by negative control, not by reading: the
        `add *.com to lowercase no_proxy only` mutation left the invariant
        passing.

        Returning the union means an entry that is dangerous in either spelling
        is judged, and a disagreement between the two shows up as the superset
        rather than being silently resolved in favour of whichever came first.
        """
        entries, seen, found = [], set(), False
        for key in ("NO_PROXY", "no_proxy"):
            raw = self.env.get(key)
            if raw is None:
                continue
            found = True
            for e in str(raw).split(","):
                e = e.strip()
                if e and e not in seen:
                    seen.add(e)
                    entries.append(e)
        return entries if found else None

    def __repr__(self):
        return f"<Service {self.name}>"


def _glob(text, pattern):
    rx = "^" + ".*".join(re.escape(p) for p in pattern.split("*")) + "$"
    return re.match(rx, text) is not None


def _is_ip_literal(host):
    if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", host):
        return all(0 <= int(p) <= 255 for p in host.split("."))
    return ":" in host and re.match(r"^[0-9a-fA-F:]+$", host) is not None


def _as_env_dict(value):
    """`environment:` is either a list of K=V or a mapping."""
    out = {}
    if isinstance(value, dict):
        for k, v in value.items():
            out[str(k)] = "" if v is None else str(v)
    elif isinstance(value, list):
        for item in value:
            if item is None:
                continue
            text = str(item)
            key, sep, val = text.partition("=")
            out[key.strip()] = val if sep else ""
    return out


def _parse_mount(entry):
    if isinstance(entry, dict):
        src = entry.get("source")
        tgt = entry.get("target")
        mode = "ro" if entry.get("read_only") else "rw"
        kind = entry.get("type") or ("bind" if str(src).startswith(("/", ".", "~")) else "volume")
        return Mount(src, tgt, mode, entry, kind)
    text = str(entry)
    parts = text.split(":")
    if len(parts) == 1:
        return Mount(None, parts[0], "rw", text, "volume")
    src, tgt = parts[0], parts[1]
    mode = "rw"
    if len(parts) >= 3:
        flags = [p for p in parts[2:] if p]
        mode = "ro" if "ro" in flags else "rw"
    kind = "bind" if src.startswith(("/", ".", "~")) or UNSET in src else "volume"
    return Mount(src, tgt, mode, text, kind)


def resolve_bind_source(source, compose_dir):
    """Resolve a compose bind source the way Docker Compose does.

    Relative paths are relative to the compose file's directory (not cwd).
    ``~`` is expanded. Absolute paths are left alone.
    """
    if source is None:
        return source
    text = str(source)
    if UNSET in text:
        return text
    text = os.path.expanduser(text)
    if not os.path.isabs(text):
        base = compose_dir or os.getcwd()
        text = os.path.normpath(os.path.join(base, text))
    return text


def _secret_names(value):
    out = []
    for item in value or []:
        if isinstance(item, dict):
            name = item.get("source")
            target = item.get("target")
            out.append(f"{name} -> {target}" if target else str(name))
        else:
            out.append(str(item))
    return out


class Topology:
    def __init__(self, doc, sources, notes=None, unresolved=None, raw_doc=None):
        self.doc = doc
        # The same document with NO interpolation applied. `${SOME_API_KEY}` is
        # evidence that a credential is supplied at runtime, which is a
        # different fact from "the variable is empty in this shell".
        self.raw_doc = raw_doc or {}
        self.sources = sources          # dict of resolved input paths
        self.notes = notes or []
        self.unresolved = sorted(set(unresolved or []))
        self.services = {}
        self.networks = {}
        self.top_secrets = doc.get("secrets") or {}
        self.guard_policy = None        # dict | None
        self.guard_error = None
        self._build()

    # ── construction ──────────────────────────────────────────────────────
    def _build(self):
        for name, cfg in (self.doc.get("networks") or {}).items():
            cfg = cfg or {}
            self.networks[name] = Network(
                name,
                internal=bool(cfg.get("internal")),
                declared=True,
                external=bool(cfg.get("external")),
            )
        for name, raw in (self.doc.get("services") or {}).items():
            self.services[name] = self._service(name, raw or {})
        for svc in self.services.values():
            for net in svc.network_names:
                if net not in self.networks:
                    self.networks[net] = Network(net, internal=False, declared=False)
                    self.notes.append(
                        f"network {net!r} used by {svc.name} but not declared; "
                        "compose would create it as a default (non-internal) bridge"
                    )

    def _service(self, name, raw):
        svc = Service(name, raw)
        uninterpolated = ((self.raw_doc.get("services") or {}).get(name) or {})
        svc.env_raw = _as_env_dict(uninterpolated.get("environment", raw.get("environment")))
        svc.env = _as_env_dict(raw.get("environment"))
        svc.network_mode = raw.get("network_mode")
        nets = raw.get("networks")
        if isinstance(nets, dict):
            svc.network_names = list(nets.keys())
        elif isinstance(nets, list):
            svc.network_names = [str(n) for n in nets if n is not None]
        elif svc.network_mode:
            svc.network_names = []
        else:
            # Compose attaches a service with no `networks:` key to `default`.
            # This is the trap the sealer's comment warns about: absence is not
            # isolation, only `network_mode: none` is.
            svc.network_names = ["default"]
        if svc.network_mode in ("none",):
            svc.network_names = []
        svc.volumes = [_parse_mount(v) for v in (raw.get("volumes") or [])]
        svc.secrets = _secret_names(raw.get("secrets"))
        svc.ports = [str(p) for p in (raw.get("ports") or [])]
        svc.command = raw.get("command")
        svc.extra_hosts = [str(h) for h in (raw.get("extra_hosts") or [])]
        return svc

    # ── network questions ─────────────────────────────────────────────────
    def is_internal(self, net_name):
        net = self.networks.get(net_name)
        return bool(net and net.internal)

    def internal_legs(self, svc):
        return [n for n in svc.network_names if self.is_internal(n)]

    def external_legs(self, svc):
        return [n for n in svc.network_names if not self.is_internal(n)]

    def dual_homed(self):
        return {
            s.name: (self.internal_legs(s), self.external_legs(s))
            for s in self.services.values()
            if self.internal_legs(s) and self.external_legs(s)
        }

    def shares_network(self, a, b):
        return bool(set(a.network_names) & set(b.network_names))

    def service_by_hostname(self, host):
        """Resolve a compose DNS name: service name or container_name."""
        if host in self.services:
            return self.services[host]
        for svc in self.services.values():
            if svc.raw.get("container_name") == host:
                return svc
        return None

    # ── model questions ───────────────────────────────────────────────────
    def model_endpoints(self, svc, env_keys):
        """[(source, url)] every model endpoint this service is configured with."""
        out = []
        if svc.agent_config:
            for pname, prov in (svc.agent_config.providers or {}).items():
                url = (prov or {}).get("baseUrl")
                if url:
                    out.append((f"models.providers.{pname}.baseUrl", url))
        for key in env_keys:
            if key in svc.env and str(svc.env[key]).startswith(("http://", "https://")):
                out.append((f"env {key}", svc.env[key]))
        return out

    def endpoint_reachable(self, svc, url):
        """True / False / None(unknown), plus a reason."""
        try:
            host = urlsplit(url).hostname
        except ValueError:
            return None, f"unparseable url {url!r}"
        if not host:
            return None, f"no host in {url!r}"
        if host in ("localhost", "127.0.0.1", "::1"):
            return True, "loopback (in-container)"
        peer = self.service_by_hostname(host)
        if peer is not None:
            if self.shares_network(svc, peer):
                shared = sorted(set(svc.network_names) & set(peer.network_names))
                return True, f"peer {peer.name} on {','.join(shared)}"
            return False, f"peer {peer.name} shares no network"
        if host in ("host.docker.internal", "gateway.docker.internal"):
            if any(h.startswith(f"{host}:") for h in svc.extra_hosts):
                return True, "host gateway via extra_hosts"
            return None, "host gateway without extra_hosts"
        if not self.external_legs(svc):
            proxies = self.reachable_egress_proxies(svc)
            for pname, allowed in proxies.items():
                if host.lower() in allowed:
                    return True, f"allowlisted on {pname}"
            return False, "public host, no non-internal leg and not proxy-allowlisted"
        return None, "public host reachable via non-internal leg (not statically resolvable)"

    def reachable_egress_proxies(self, svc):
        """{proxy_name: allowed_hosts} for proxies this service is POINTED AT.

        Being on the same network as a proxy is not enough — the client has to
        be configured to use it. Both conditions are required here.
        """
        out = {}
        for url in svc.proxy_env().values():
            host = urlsplit(str(url)).hostname
            peer = self.service_by_hostname(host) if host else None
            if peer and peer.is_egress_proxy and self.shares_network(svc, peer):
                allowed, _dead = peer.egress_allow()
                out[peer.name] = allowed
        return out


# ─────────────────────────────────────────────────────────────────────────────
# build-guard AGENT_POLICY
#
# The plugin declares an empty, closed configSchema, so this policy is not
# configurable and the source IS the config. Parsed with a brace matcher; any
# shape change raises rather than silently yielding an empty policy (an empty
# policy would look like "nothing denied" and turn a FAIL into a PASS).
# ─────────────────────────────────────────────────────────────────────────────

_CONST_RE = re.compile(r'^const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"\s*;', re.M)
_POLICY_RE = re.compile(r"const\s+AGENT_POLICY\s*=\s*\{")
_EXPECTED_FIELDS = ("read", "readDeny", "write", "writeDeny")


def _match_braces(src, start):
    """Index just past the `}` matching the `{` at src[start]. String/comment aware."""
    depth = 0
    i = start
    while i < len(src):
        ch = src[i]
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < len(src):
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    break
                i += 1
        elif src.startswith("//", i):
            i = src.find("\n", i)
            if i == -1:
                return len(src)
        elif src.startswith("/*", i):
            j = src.find("*/", i)
            i = len(src) if j == -1 else j + 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ModelError("unbalanced braces while reading AGENT_POLICY")


def _strip_js_comments(src):
    out = []
    i = 0
    while i < len(src):
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = len(src) if j == -1 else j
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i)
            i = len(src) if j == -1 else j + 2
            continue
        ch = src[i]
        out.append(ch)
        if ch in ("'", '"', "`"):
            i += 1
            while i < len(src):
                out.append(src[i])
                if src[i] == "\\":
                    i += 1
                    if i < len(src):
                        out.append(src[i])
                    i += 1
                    continue
                if src[i] == ch:
                    break
                i += 1
        i += 1
    return "".join(out)


def _split_top_level(body, sep=","):
    parts, depth, cur = [], 0, []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch in ("'", '"', "`"):
            quote = ch
            cur.append(ch)
            i += 1
            while i < len(body):
                cur.append(body[i])
                if body[i] == "\\":
                    i += 1
                    if i < len(body):
                        cur.append(body[i])
                    i += 1
                    continue
                if body[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch in "[{(":
            depth += 1
        elif ch in "]})":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
            i += 1
            continue
        cur.append(ch)
        i += 1
    if "".join(cur).strip():
        parts.append("".join(cur))
    return parts


def _js_string(token, consts, where):
    token = token.strip()
    if not token:
        return None
    if token[0] in ("'", '"') and token[-1] == token[0]:
        return token[1:-1]
    if token[0] == "`" and token[-1] == "`":
        inner = token[1:-1]

        def sub(m):
            name = m.group(1).strip()
            if name not in consts:
                raise ModelError(f"{where}: template refers to unknown const {name!r}")
            return consts[name]

        return re.sub(r"\$\{([^}]*)\}", sub, inner)
    if token in consts:
        return consts[token]
    raise ModelError(f"{where}: cannot resolve path expression {token!r}")


def parse_agent_policy(path):
    """-> {agent: {read: [..]|None, readDeny: [..], write: [..], writeDeny: [..]}}"""
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    consts = {m.group(1): m.group(2) for m in _CONST_RE.finditer(src)}
    m = _POLICY_RE.search(src)
    if not m:
        raise ModelError(f"{path}: `const AGENT_POLICY = {{` not found (shape changed?)")
    open_brace = m.end() - 1
    end = _match_braces(src, open_brace)
    body = _strip_js_comments(src[open_brace + 1 : end - 1])
    policy = {}
    for chunk in _split_top_level(body):
        if not chunk.strip():
            continue
        key, sep, rest = chunk.partition(":")
        if not sep:
            raise ModelError(f"{path}: AGENT_POLICY entry without ':' -> {chunk[:60]!r}")
        agent = key.strip().strip("'\"")
        rest = rest.strip()
        if not rest.startswith("{"):
            raise ModelError(f"{path}: AGENT_POLICY[{agent}] is not an object literal")
        inner_end = _match_braces(rest, 0)
        entry = {}
        for field_chunk in _split_top_level(rest[1 : inner_end - 1]):
            if not field_chunk.strip():
                continue
            fkey, fsep, fval = field_chunk.partition(":")
            if not fsep:
                raise ModelError(f"{path}: AGENT_POLICY[{agent}] bad field {field_chunk[:40]!r}")
            fkey = fkey.strip().strip("'\"")
            fval = fval.strip()
            if fval == "null":
                entry[fkey] = None
            elif fval.startswith("["):
                arr_end = _match_bracket(fval)
                items = _split_top_level(fval[1 : arr_end - 1])
                entry[fkey] = [
                    _js_string(it, consts, f"{path}:AGENT_POLICY[{agent}].{fkey}")
                    for it in items
                    if it.strip()
                ]
            else:
                raise ModelError(
                    f"{path}: AGENT_POLICY[{agent}].{fkey} is neither null nor an array"
                )
        missing = [f for f in _EXPECTED_FIELDS if f not in entry]
        if missing:
            raise ModelError(
                f"{path}: AGENT_POLICY[{agent}] missing field(s) {missing} — shape changed"
            )
        policy[agent] = entry
    if not policy:
        raise ModelError(f"{path}: AGENT_POLICY parsed empty — shape changed")
    return policy


def _match_bracket(text):
    depth = 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < len(text) and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ModelError("unbalanced brackets in AGENT_POLICY array")


# ─────────────────────────────────────────────────────────────────────────────
# Entry point used by check.py
# ─────────────────────────────────────────────────────────────────────────────

def build_topology(compose_paths, env_file=None, extra_env=None, sources_cfg=None):
    sources_cfg = sources_cfg or {}
    env = {}
    env.update(load_dotenv(env_file))
    env.update(os.environ)
    env.update(extra_env or {})

    docs, raw_docs, unresolved, notes = [], [], [], []
    for path in compose_paths:
        raw = load_yaml_file(path)
        if not isinstance(raw, dict):
            raise ModelError(f"{path}: top level is not a mapping")
        raw_docs.append(raw)
        docs.append(interpolate(copy.deepcopy(raw), env, unresolved))
    names = [os.path.basename(p) for p in compose_paths]
    doc, merge_notes = merge_documents(docs, names)
    raw_doc, _ = merge_documents(raw_docs, names)
    notes.extend(merge_notes)

    topo = Topology(
        doc,
        sources={"compose": list(compose_paths), "env_file": env_file},
        notes=notes,
        unresolved=unresolved,
        raw_doc=raw_doc,
    )

    # Compose resolves relative bind sources against the compose file's directory.
    compose_dir = os.path.dirname(os.path.abspath(compose_paths[0])) if compose_paths else None
    for svc in topo.services.values():
        for mount in svc.volumes:
            if mount.kind == "bind" and mount.source:
                mount.source = resolve_bind_source(mount.source, compose_dir)

    # Attach agent configs by following the mount that carries them. Generic:
    # any service whose volumes place an <agent_config_file> at
    # <agent_config_target> is an agent cell, whatever it is called.
    target_dir = sources_cfg.get("agent_config_target", "/home/node/.openclaw")
    cfg_name = sources_cfg.get("agent_config_file", "openclaw.json")
    for svc in topo.services.values():
        path = None
        for mount in svc.volumes:
            if mount.kind != "bind" or not mount.source:
                continue
            tgt = str(mount.target).rstrip("/")
            if tgt == f"{target_dir}/{cfg_name}":
                path = str(mount.source)
                break
            if tgt == target_dir.rstrip("/"):
                path = os.path.join(str(mount.source), cfg_name)
        if not path:
            continue
        if UNSET in path:
            svc.unknowns.append(f"agent config path unresolved: {clean_unset(path)}")
            continue
        if not os.path.exists(path):
            svc.agent_config = AgentConfig(path, None, error="file not found")
            svc.unknowns.append(f"agent config not readable: {path}")
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                svc.agent_config = AgentConfig(path, json.load(fh))
        except Exception as exc:  # noqa: BLE001 - reported, never swallowed
            svc.agent_config = AgentConfig(path, None, error=str(exc))
            svc.unknowns.append(f"agent config unparseable: {path}: {exc}")

    guard_path = sources_cfg.get("build_guard")
    if guard_path:
        if not os.path.exists(guard_path):
            topo.guard_error = f"{guard_path}: not found"
        else:
            try:
                topo.guard_policy = parse_agent_policy(guard_path)
            except ModelError as exc:
                topo.guard_error = str(exc)
    return topo


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
