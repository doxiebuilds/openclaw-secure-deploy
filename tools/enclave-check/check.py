#!/usr/bin/env python3
"""Evaluate the invariants in invariants.yaml against a modelled deployment.

    python3 tools/enclave-check/check.py                      # this repo
    python3 tools/enclave-check/check.py -f a.yml -f b.yml    # model an override
    python3 tools/enclave-check/check.py --only curator-cannot-see-past-its-own-gate -v
    python3 tools/enclave-check/check.py --dump-model
    python3 tools/enclave-check/check.py --json

Three results, and only three:

    PASS     the model proves the invariant holds
    FAIL     the model refutes it — a finding
    UNKNOWN  the model could not decide — ALSO a finding, never a pass

Exit status: 0 all PASS, 1 any FAIL, 2 any UNKNOWN (and no FAIL), 3 tool error.

This tool is read-only. It never runs docker, never touches the network, and
opens nothing outside --repo-root for writing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model as M  # noqa: E402

PASS, FAIL, UNKNOWN = "PASS", "FAIL", "UNKNOWN"
_RANK = {PASS: 0, UNKNOWN: 1, FAIL: 2}


class Result:
    def __init__(self, inv):
        self.id = inv.get("id", "<unnamed>")
        self.type = inv.get("type")
        self.statement = (inv.get("statement") or "").strip()
        self.why = (inv.get("why") or "").strip()
        self.status = PASS
        self.evidence = []
        self.reasons = []          # why it is not a PASS

    def record(self, status, reason=None):
        """Worst status wins. UNKNOWN can never be downgraded into a PASS."""
        if _RANK[status] > _RANK[self.status]:
            self.status = status
        if reason:
            self.reasons.append(f"{status}: {reason}")

    def ev(self, line):
        self.evidence.append(line)

    def as_dict(self):
        return {
            "id": self.id,
            "type": self.type,
            "status": self.status,
            "statement": self.statement,
            "reasons": self.reasons,
            "evidence": self.evidence,
        }


def _deref(value, spec):
    """`vocabulary.untrusted_mounts` -> the list it names."""
    if isinstance(value, str) and value.startswith("vocabulary."):
        vocab = spec.get("vocabulary") or {}
        key = value.split(".", 1)[1]
        if key not in vocab:
            raise M.ModelError(f"invariants.yaml: unknown {value}")
        return vocab[key]
    return value


def _vocab(spec, key, default=None):
    return (spec.get("vocabulary") or {}).get(key, default if default is not None else [])


def _mount_label(mount):
    return f"{M.clean_unset(str(mount.source))}:{mount.target}:{mount.mode}"


def _as_list(value):
    """Accept a scalar or a list in the spec, always hand back a list.

    Lets an invariant that grew from one path to several keep its old spelling
    working, so a stale spec fails loudly on its content rather than silently on
    its shape.
    """
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _mount_is_ro(mount):
    return str(mount.mode).lower() == "ro"


def _rel(path, root):
    """Repo-relative when it is inside the repo, absolute when it is not."""
    rel = os.path.relpath(path, root)
    return path if rel.startswith("..") else rel


# ─────────────────────────────────────────────────────────────────────────────
# Check types
#
# Signature: (topo, inv, spec) -> Result. Each is responsible for emitting
# UNKNOWN wherever the model is silent, rather than assuming the safe answer.
# ─────────────────────────────────────────────────────────────────────────────

def check_no_holder_of_set_with_model(topo, inv, spec):
    res = Result(inv)
    markers = _deref(inv.get("mount_markers"), spec)
    env_keys = _vocab(spec, "model_env_keys")
    if not markers:
        res.record(UNKNOWN, "no mount_markers configured")
        return res

    for svc in topo.services.values():
        held = [m for m in markers if svc.mounts_ending(m)]
        indeterminate = [
            v for v in svc.volumes if v.source and M.UNSET in str(v.source)
        ]
        if not held:
            continue
        endpoints = topo.model_endpoints(svc, env_keys)
        reach = [(src, url) + topo.endpoint_reachable(svc, url) for src, url in endpoints]
        live = [r for r in reach if r[2] is True]
        maybe = [r for r in reach if r[2] is None]
        holds_all = len(held) == len(markers)

        if holds_all:
            desc = f"{svc.name} holds ALL {len(markers)}: {', '.join(held)}"
            if live:
                res.record(
                    FAIL,
                    f"{svc.name} holds {', '.join(held)} AND a reachable model "
                    f"({live[0][0]} = {live[0][1]}, {live[0][3]})",
                )
                res.ev(f"FAIL  {desc}; model: {live[0][0]} -> {live[0][1]}")
            elif maybe:
                res.record(
                    UNKNOWN,
                    f"{svc.name} holds all three and declares a model endpoint whose "
                    f"reachability is undecidable ({maybe[0][1]}: {maybe[0][3]})",
                )
                res.ev(f"UNKNOWN {desc}; model endpoint {maybe[0][1]} ({maybe[0][3]})")
            elif indeterminate:
                res.record(
                    UNKNOWN,
                    f"{svc.name} holds all three; {len(indeterminate)} mount(s) "
                    "unresolved so a model mount cannot be ruled out",
                )
                res.ev(f"UNKNOWN {desc}; unresolved mounts present")
            else:
                why = []
                if not endpoints:
                    why.append("no model endpoint configured")
                else:
                    why.append(f"{len(endpoints)} model endpoint(s), none reachable")
                if svc.raw.get("network_mode") == "none":
                    why.append("network_mode: none")
                elif not svc.network_names:
                    why.append("no networks")
                if not svc.secrets:
                    why.append("no secrets:")
                res.ev(f"ok    {desc} — legal: {'; '.join(why)}")
        else:
            kind = "model" if endpoints else "no model"
            res.ev(
                f"ok    {svc.name} holds {len(held)}/{len(markers)} "
                f"({', '.join(held)}) — {kind}"
            )
    if not res.evidence:
        res.record(UNKNOWN, "no service mounts any of the marker directories")
    return res


def check_agent_tool_denied(topo, inv, spec):
    res = Result(inv)
    tool = inv.get("tool")
    field = inv.get("field", "deny")
    accept_allow = bool(inv.get("accept_absent_from_allow"))
    cells = [s for s in topo.services.values() if s.agent_config]
    if not cells:
        res.record(UNKNOWN, "no agent configs discovered from the compose mounts")
        return res
    for svc in cells:
        cfg = svc.agent_config
        if cfg.error:
            res.record(UNKNOWN, f"{svc.name}: config unreadable ({cfg.error})")
            res.ev(f"UNKNOWN {svc.name}: {cfg.path}: {cfg.error}")
            continue
        agents = cfg.agents
        if not agents:
            res.record(UNKNOWN, f"{svc.name}: config declares no agents.list")
            res.ev(f"UNKNOWN {svc.name}: no agents.list in {cfg.path}")
            continue
        for agent in agents:
            aid = agent.get("id", "<no id>")
            tools = agent.get("tools") or {}
            denied = [str(t) for t in (tools.get(field) or [])]
            allowed = [str(t) for t in (tools.get("allow") or [])]
            if tool in denied:
                res.ev(f"ok    {svc.name}/{aid}: tools.{field} contains {tool!r}")
            elif accept_allow and allowed and tool not in allowed:
                res.ev(
                    f"ok    {svc.name}/{aid}: {tool!r} absent from absolute tools.allow"
                )
            else:
                extra = (
                    f" (also absent from tools.allow, so unreachable in practice)"
                    if allowed and tool not in allowed
                    else ""
                )
                res.record(FAIL, f"{svc.name}/{aid}: tools.{field} lacks {tool!r}{extra}")
                res.ev(f"FAIL  {svc.name}/{aid}: tools.{field} = {denied}{extra}")
    return res


def check_no_trifecta(topo, inv, spec):
    res = Result(inv)
    legs = inv.get("legs") or {}
    untrusted_paths = _deref(legs.get("untrusted"), spec) or []
    cred_patterns = _vocab(spec, "credential_env_patterns")
    placeholders = [str(v) for v in _vocab(spec, "credential_placeholder_values")]
    count_proxied = bool(legs.get("count_proxied_egress_as_leg"))

    for svc in topo.services.values():
        held = []
        for marker in untrusted_paths:
            for mount in svc.mounts_ending(marker):
                held.append(f"{marker}({mount.mode})")
        has_cred, cred_why = svc.credential_evidence(cred_patterns, placeholders)
        direct = topo.external_legs(svc)
        proxied = topo.reachable_egress_proxies(svc)
        egress = bool(direct) or (count_proxied and bool(proxied))
        unresolved_mounts = [v for v in svc.volumes if v.source and M.UNSET in str(v.source)]

        legs_held = sum([bool(held), has_cred, egress])
        if legs_held < 2:
            continue
        detail = (
            f"untrusted={held or '-'} credential={cred_why or '-'} "
            f"egress={direct or ('via ' + ','.join(proxied) if proxied else '-')}"
        )
        if legs_held == 3:
            res.record(FAIL, f"{svc.name} holds all three legs: {detail}")
            res.ev(f"FAIL  {svc.name}: {detail}")
        elif unresolved_mounts and not held:
            res.record(
                UNKNOWN,
                f"{svc.name} holds 2 legs and has {len(unresolved_mounts)} unresolved "
                "mount(s), so the untrusted-content leg cannot be decided",
            )
            res.ev(f"UNKNOWN {svc.name}: {detail}; unresolved mounts")
        else:
            missing = (
                "no untrusted mount"
                if not held
                else "no credential"
                if not has_cred
                else "no non-internal leg"
            )
            res.ev(f"ok    {svc.name}: 2/3 legs, saved by: {missing} — {detail}")
            if proxied and not count_proxied and held and has_cred:
                res.ev(
                    f"      note {svc.name} does have allowlisted egress via "
                    f"{','.join(proxied)}; counted as not-a-leg by configuration"
                )
    if not res.evidence:
        res.ev("ok    no service holds two or more legs")
    return res


def check_dual_homed_allowlist(topo, inv, spec):
    res = Result(inv)
    expected = set(_deref(inv.get("expected"), spec) or [])
    actual = topo.dual_homed()
    if not topo.networks:
        res.record(UNKNOWN, "no networks in the model")
        return res

    # Clause 1: the containment side. A network is containment-critical if an
    # agent cell sits on it; such a cell must have no non-internal leg. Derived
    # rather than listed, so deleting `internal: true` from a network is caught
    # even though that also removes the network from the dual-homed set below —
    # which on its own would make this invariant quietly unfalsifiable.
    if inv.get("cells_must_be_internal_only", True):
        exempt = set(_deref(inv.get("cells_allowed_direct_egress"), spec) or [])
        cells = [s for s in topo.services.values() if s.agent_config]
        if not cells:
            res.record(UNKNOWN, "no agent cells discovered, so containment cannot be checked")
        for svc in cells:
            external = topo.external_legs(svc)
            if not external:
                res.ev(
                    f"ok    cell {svc.name}: only internal legs "
                    f"({','.join(topo.internal_legs(svc)) or 'none'})"
                )
            elif svc.name in exempt:
                res.ev(f"ok    cell {svc.name}: non-internal leg {external} allowed by configuration")
            else:
                res.record(
                    FAIL,
                    f"cell {svc.name} has a leg on non-internal network(s) "
                    f"{','.join(external)} — direct route off-box",
                )
                res.ev(f"FAIL  cell {svc.name}: non-internal leg(s) {','.join(external)}")

    # Clause 2: the bridge side.
    for name in sorted(actual):
        internal, external = actual[name]
        legs = f"internal={','.join(internal)} external={','.join(external)}"
        svc = topo.services[name]
        fwd = svc.forward_target
        if name in expected:
            kind = (
                f"single-destination forwarder -> {fwd[0]}:{fwd[1]}"
                if fwd
                else "egress allowlist proxy"
                if svc.is_egress_proxy
                else "expected"
            )
            res.ev(f"ok    {name}: {legs} [{kind}]")
        else:
            res.record(FAIL, f"{name} bridges {','.join(internal)} to {','.join(external)} and is not on the expected list")
            res.ev(f"FAIL  {name}: {legs} [UNEXPECTED]")
    for name in sorted(expected - set(actual)):
        if name not in topo.services:
            res.ev(f"note  expected bridge {name!r} is not a service in this model")
        else:
            res.ev(f"note  {name} is on the expected list but is no longer dual-homed")
    return res


def check_two_layer_path_deny(topo, inv, spec):
    """Both layers, across a SET of paths and a set of guard fields.

    Generalized 2026-08-08 from one path / one field. `briefs-flagged/` arrived
    needing exactly the same treatment as `briefs/`, and the version that took a
    single `forbidden_path` could only have expressed that as a second, nearly
    identical invariant — two specs to keep in sync, which is the shape that
    produces a stale one.

    The docker-layer / guard-layer attribution is preserved per path: knowing
    WHICH layer let something through is the difference between "the mount is
    wrong" and "defence in depth is gone but the primary control held".
    """
    res = Result(inv)
    dock = inv.get("docker") or {}
    guard = inv.get("guard") or {}

    paths = dock.get("forbidden_paths") or _as_list(dock.get("forbidden_path"))
    fields = guard.get("fields") or _as_list(guard.get("field")) or ["readDeny"]
    needles = guard.get("must_contain_all") or _as_list(guard.get("must_contain"))

    # ── layer 1: Docker mounts ───────────────────────────────────────────
    sname = dock.get("service")
    svc = topo.services.get(sname)
    if svc is None:
        res.record(UNKNOWN, f"docker layer: service {sname!r} not in the model")
        res.ev(f"UNKNOWN docker layer: no service {sname!r}")
    else:
        for path in paths:
            hits = svc.mounts_ending(path) + [
                m for m in svc.targets_ending(path) if m not in svc.mounts_ending(path)
            ]
            if hits:
                res.record(
                    FAIL,
                    f"docker layer: {sname} mounts {path} "
                    f"({', '.join(_mount_label(h) for h in hits)})",
                )
                res.ev(f"FAIL  docker layer: {sname} mounts {path}")
            else:
                res.ev(f"ok    docker layer: {sname} has no mount of {path} "
                       f"({len(svc.volumes)} mounts checked)")

    # ── layer 2: build-guard path policy ─────────────────────────────────
    if topo.guard_policy is None:
        res.record(UNKNOWN, f"guard layer: policy not parseable ({topo.guard_error})")
        res.ev(f"UNKNOWN guard layer: {topo.guard_error}")
        return res
    agent = guard.get("agent")
    entry = topo.guard_policy.get(agent)
    if entry is None:
        res.record(UNKNOWN, f"guard layer: no AGENT_POLICY entry for {agent!r}")
        res.ev(f"UNKNOWN guard layer: AGENT_POLICY has no {agent!r}")
        return res

    for field in fields:
        values = entry.get(field) or []
        allow = entry.get("read" if field == "readDeny" else "write")
        for needle in needles:
            implied = (
                allow is not None
                and not any(
                    str(needle).startswith(str(a).rstrip("/") + "/") or needle == a
                    for a in allow
                )
            )
            if needle in values:
                res.ev(f"ok    guard layer: {agent}.{field} contains {needle}")
                if implied:
                    res.ev(f"      note {agent}'s {field.replace('Deny','')} "
                           f"allowlist also excludes it")
            else:
                extra = f" (allowlist {allow} would already exclude it)" if implied else ""
                res.record(
                    FAIL,
                    f"guard layer: {agent}.{field} does not contain {needle}{extra}",
                )
                res.ev(f"FAIL  guard layer: {agent}.{field} = {values}{extra}")
    return res


def check_sole_writer(topo, inv, spec):
    """Exactly one service may hold these paths writable.

    The promotion destinations are the far side of the gate. If any cell can
    write `briefs/` or `briefs-flagged/` directly, the schema check is not on
    the path at all — a brief could simply appear there. `:ro` is not enough to
    fail this; the test is whether a WRITE handle exists anywhere but the sealer.
    """
    res = Result(inv)
    paths = inv.get("paths") or []
    owner = inv.get("sole_writer")
    for path in paths:
        writers = []
        for name, svc in topo.services.items():
            for m in svc.targets_ending(path):
                if not _mount_is_ro(m):
                    writers.append(name)
                    break
        if owner not in writers:
            res.record(UNKNOWN, f"{path}: expected writer {owner!r} holds no rw mount")
            res.ev(f"UNKNOWN {path}: {owner} has no rw mount of it")
        extra = sorted(set(writers) - {owner})
        if extra:
            res.record(FAIL, f"{path} is writable by {', '.join(extra)}, not only {owner}")
            res.ev(f"FAIL  {path}: rw in {', '.join(sorted(set(writers)))}")
        else:
            res.ev(f"ok    {path}: rw only in {owner}")
    return res


_PUBLICISH_RE = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$")


def check_no_proxy_scope(topo, inv, spec):
    res = Result(inv)
    required = _deref(inv.get("required"), spec) or []
    accepted = set(_deref(inv.get("accepted_dual_homed_peers"), spec) or [])
    localhost = {str(x) for x in _vocab(spec, "localhost_forms")}

    proxied = [s for s in topo.services.values() if s.proxy_env()]
    if not proxied:
        res.record(UNKNOWN, "no service declares HTTP(S)_PROXY, so there is nothing to scope")
        return res
    for svc in proxied:
        entries = svc.no_proxy_entries()
        if entries is None:
            res.record(FAIL, f"{svc.name} is proxied but sets no NO_PROXY")
            res.ev(f"FAIL  {svc.name}: proxy set ({sorted(svc.proxy_env())}) but no NO_PROXY")
            continue
        missing = [r for r in required if r not in entries]
        if missing:
            res.record(FAIL, f"{svc.name}: NO_PROXY is missing required entr(y/ies) {missing}")
            res.ev(f"FAIL  {svc.name}: NO_PROXY={entries} missing {missing}")
        for entry in entries:
            low = entry.lower()
            if low in localhost:
                continue
            if any(ch in entry for ch in "*/") or entry.startswith("."):
                res.record(
                    FAIL,
                    f"{svc.name}: NO_PROXY entry {entry!r} is a wildcard/suffix/CIDR form "
                    "and widens the unproxied set",
                )
                res.ev(f"FAIL  {svc.name}: NO_PROXY entry {entry!r} (wildcard/CIDR)")
                continue
            peer = topo.service_by_hostname(entry)
            if peer is None:
                kind = "public hostname" if _PUBLICISH_RE.match(entry) else "unknown name"
                res.record(
                    FAIL,
                    f"{svc.name}: NO_PROXY entry {entry!r} is not a service in this "
                    f"deployment ({kind}) — an unproxied path",
                )
                res.ev(f"FAIL  {svc.name}: NO_PROXY entry {entry!r} ({kind})")
                continue
            internal, external = topo.internal_legs(peer), topo.external_legs(peer)
            fwd = peer.forward_target
            if fwd:
                res.ev(
                    f"ok    {svc.name}: NO_PROXY {entry} = single-destination forwarder "
                    f"-> {fwd[0]}:{fwd[1]} (non-transitive)"
                )
            elif not external:
                res.ev(f"ok    {svc.name}: NO_PROXY {entry} = internal-only peer "
                       f"({','.join(internal) or 'no networks'})")
            elif entry in accepted:
                res.ev(
                    f"ok    {svc.name}: NO_PROXY {entry} = dual-homed peer, accepted by "
                    f"configuration (external legs: {','.join(external)})"
                )
            else:
                res.record(
                    FAIL,
                    f"{svc.name}: NO_PROXY entry {entry!r} is a dual-homed peer "
                    f"(external legs {external}) and is not on accepted_dual_homed_peers",
                )
                res.ev(f"FAIL  {svc.name}: NO_PROXY {entry} dual-homed, unaccepted")
        if not missing:
            res.ev(f"ok    {svc.name}: NO_PROXY={','.join(entries)} (required {required} present)")
    for svc in topo.services.values():
        if svc.agent_config and not svc.proxy_env():
            res.ev(f"note  {svc.name} is a cell with no proxy configured; NO_PROXY not applicable")
    return res


def _derive_baseline(cfg):
    """Re-derive the openclaw.json-backed baseline lines.

    Mirrors scripts/check-approvals.sh's fingerprint() exactly, including
    Python's str() of None/True/False — the point is to reproduce the
    derivation independently, not to reuse the thing under test.
    """
    lines = []
    plugins = cfg.get("plugins") or {}
    load_paths = ((plugins.get("load") or {}).get("paths")) or []
    lines.append("plugins.load.paths=%s" % ",".join(sorted(map(str, load_paths))))
    lines.append("plugins.allow=%s" % ",".join(sorted(map(str, plugins.get("allow") or []))))
    agents_cfg = cfg.get("agents") or {}
    for agent in sorted(agents_cfg.get("list") or [], key=lambda a: str(a.get("id"))):
        tools = agent.get("tools") or {}
        fs = tools.get("fs") or {}
        lines.append(
            "agent-tools:%s profile=%s allow=%s deny=%s workspaceOnly=%s"
            % (
                agent.get("id"),
                tools.get("profile"),
                ",".join(sorted(map(str, tools.get("allow") or []))),
                ",".join(sorted(map(str, tools.get("deny") or []))),
                fs.get("workspaceOnly"),
            )
        )
        lines.append("agent-model:%s %s" % (agent.get("id"), agent.get("model")))
    gtools = cfg.get("tools") or {}
    lines.append("tools.profile=%s" % gtools.get("profile"))
    lines.append(
        "tools.web.search.enabled=%s"
        % (((gtools.get("web") or {}).get("search") or {}).get("enabled"))
    )
    lines.append(
        "mcp.servers=%s"
        % ",".join(sorted(((cfg.get("mcp") or {}).get("servers") or {}).keys()))
    )
    return lines


def _line_key(line):
    """The identity of a baseline line, so a CHANGED line is not read as two."""
    if line.startswith(("agent-tools:", "agent-model:")):
        head = line.split(" ", 1)[0]
        return head
    return line.split("=", 1)[0]


def check_baseline_restatement(topo, inv, spec):
    res = Result(inv)
    root = spec["_repo_root"]
    baseline_path = os.path.join(root, inv["baseline"])
    if not os.path.exists(baseline_path):
        res.record(UNKNOWN, f"baseline not found: {inv['baseline']}")
        return res
    sname = inv.get("service")
    svc = topo.services.get(sname)
    if svc is None or svc.agent_config is None:
        res.record(UNKNOWN, f"no agent config discovered for service {sname!r}")
        return res
    if svc.agent_config.error:
        res.record(UNKNOWN, f"{svc.agent_config.path}: {svc.agent_config.error}")
        return res

    with open(baseline_path, "r", encoding="utf-8") as fh:
        actual_lines = [ln.rstrip("\n") for ln in fh if ln.strip()]
    expected = _derive_baseline(svc.agent_config.data)
    res.ev(f"note  derived from {_rel(svc.agent_config.path, root)}")

    actual_by_key = {}
    for line in actual_lines:
        actual_by_key.setdefault(_line_key(line), []).append(line)
    covered_keys = set()
    for line in expected:
        key = _line_key(line)
        covered_keys.add(key)
        got = actual_by_key.get(key)
        if not got:
            res.record(FAIL, f"baseline is missing a line for {key!r} (config says: {line})")
            res.ev(f"FAIL  missing from baseline: {line}")
        elif line in got:
            res.ev(f"ok    {line}")
        else:
            res.record(
                FAIL,
                f"drift on {key!r}:\n        baseline: {got[0]}\n        config:   {line}",
            )
            res.ev(f"FAIL  baseline: {got[0]}")
            res.ev(f"      config:   {line}")

    ignore = tuple(inv.get("ignore_prefixes") or ())
    skipped = [ln for ln in actual_lines if ln.startswith(ignore)]
    if skipped:
        res.ev(
            f"note  {len(skipped)} baseline line(s) restate live gateway state "
            f"(exec allowlist), not openclaw.json — out of scope for this invariant"
        )
    for line in actual_lines:
        key = _line_key(line)
        if key in covered_keys or line.startswith(ignore) or line.startswith("guard sha256"):
            continue
        if key.startswith(("agent-tools:", "agent-model:")):
            res.record(FAIL, f"baseline pins {key!r}, which no longer exists in the config")
            res.ev(f"FAIL  stale baseline line: {line}")
        else:
            res.ev(f"note  not derived from openclaw.json, unchecked here: {line}")

    guard_file = inv.get("guard_sha256_file")
    if guard_file:
        pinned = [ln for ln in actual_lines if ln.startswith("guard sha256=")]
        gpath = os.path.join(root, guard_file)
        if not pinned:
            res.ev("note  baseline pins no guard sha256")
        elif not os.path.exists(gpath):
            res.record(UNKNOWN, f"guard file not found for hashing: {guard_file}")
        else:
            digest = M.sha256_file(gpath)
            if pinned[0].split("=", 1)[1].strip() == digest:
                res.ev(f"ok    guard sha256={digest[:16]}… matches {guard_file}")
            else:
                res.record(
                    FAIL,
                    f"guard sha256 drift: baseline pins {pinned[0].split('=',1)[1][:16]}…, "
                    f"{guard_file} hashes to {digest[:16]}…",
                )
                res.ev(f"FAIL  guard sha256 mismatch for {guard_file}")
    return res


CHECKS = {
    "no_holder_of_set_with_model": check_no_holder_of_set_with_model,
    "agent_tool_denied": check_agent_tool_denied,
    "no_trifecta": check_no_trifecta,
    "dual_homed_allowlist": check_dual_homed_allowlist,
    "two_layer_path_deny": check_two_layer_path_deny,
    "sole_writer": check_sole_writer,
    "no_proxy_scope": check_no_proxy_scope,
    "baseline_restatement": check_baseline_restatement,
}


# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────

COLOR = {
    PASS: "\033[32m",
    FAIL: "\033[31m",
    UNKNOWN: "\033[33m",
}
RESET = "\033[0m"


def _paint(status, use_color):
    return f"{COLOR[status]}{status:<7}{RESET}" if use_color else f"{status:<7}"


def dump_model(topo, out):
    print("services", file=out)
    for name in sorted(topo.services):
        svc = topo.services[name]
        nets = ",".join(svc.network_names) or (svc.network_mode or "none")
        print(f"  {name}", file=out)
        print(f"    networks    : {nets}", file=out)
        if svc.network_mode:
            print(f"    network_mode: {svc.network_mode}", file=out)
        if svc.secrets:
            print(f"    secrets     : {', '.join(svc.secrets)}", file=out)
        if svc.ports:
            print(f"    ports       : {', '.join(svc.ports)}", file=out)
        if svc.agent_config:
            cfg = svc.agent_config
            ids = ",".join(str(a.get("id")) for a in cfg.agents) or "-"
            print(f"    agent config: {cfg.path} (agents: {ids})", file=out)
            for pname, prov in (cfg.providers or {}).items():
                print(f"    model       : {pname} -> {(prov or {}).get('baseUrl')}", file=out)
        if svc.is_egress_proxy:
            allowed, dead = svc.egress_allow()
            print(f"    egress allow: {len(allowed)} exact hosts", file=out)
            if dead:
                print(f"    egress DEAD : {sorted(dead)} (IP literals are always denied)", file=out)
        fwd = svc.forward_target
        if fwd:
            print(f"    forwards to : {fwd[0]}:{fwd[1]} (fixed, non-transitive)", file=out)
        for env_key in ("NO_PROXY", "HTTPS_PROXY"):
            if env_key in svc.env:
                print(f"    {env_key:<12}: {svc.env[env_key]}", file=out)
        for mount in svc.volumes:
            print(f"    mount       : {_mount_label(mount)}", file=out)
        for unk in svc.unknowns:
            print(f"    UNKNOWN     : {unk}", file=out)
    print("networks", file=out)
    for name in sorted(topo.networks):
        net = topo.networks[name]
        flags = []
        if net.internal:
            flags.append("internal")
        if not net.declared:
            flags.append("implicit")
        print(f"  {name:<14} {' '.join(flags) or '-'}", file=out)
    print("dual-homed (internal <-> non-internal)", file=out)
    for name, (i, e) in sorted(topo.dual_homed().items()):
        print(f"  {name:<20} {','.join(i)} <-> {','.join(e)}", file=out)
    if topo.guard_policy:
        print("build-guard AGENT_POLICY", file=out)
        for agent, entry in topo.guard_policy.items():
            print(f"  {agent}: read={entry['read']} readDeny={entry['readDeny']}", file=out)
            print(f"    {' ' * len(agent)}write={entry['write']} writeDeny={entry['writeDeny']}", file=out)
    elif topo.guard_error:
        print(f"build-guard AGENT_POLICY: UNAVAILABLE ({topo.guard_error})", file=out)
    if topo.notes:
        print("merge/model notes", file=out)
        for note in topo.notes:
            print(f"  {note}", file=out)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="enclave-check",
        description="Derive a trust topology from config files and prove or refute "
        "named security invariants. Read-only; never runs docker.",
    )
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument(
        "--repo-root",
        default=os.path.abspath(os.path.join(here, "..", "..")),
        help="root the invariant paths are relative to (default: the repo this lives in)",
    )
    ap.add_argument(
        "--invariants",
        default=os.path.join(here, "invariants.yaml"),
        help="invariant spec file (default: ./invariants.yaml)",
    )
    ap.add_argument(
        "-f", "--file", action="append", dest="compose",
        help="compose file, repeatable, in -f order; overrides sources.compose",
    )
    ap.add_argument("--env-file", help="override sources.env_file")
    ap.add_argument("--only", action="append", help="run only these invariant ids")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("-v", "--verbose", action="store_true", help="print evidence for PASSes too")
    ap.add_argument("--dump-model", action="store_true", help="print the derived topology and exit")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args(argv)

    try:
        spec = M.load_yaml_file(args.invariants)
    except (M.ModelError, OSError) as exc:
        print(f"enclave-check: cannot read invariants: {exc}", file=sys.stderr)
        return 3
    if not isinstance(spec, dict) or "invariants" not in spec:
        print("enclave-check: invariants file has no `invariants:` list", file=sys.stderr)
        return 3

    root = os.path.abspath(args.repo_root)
    spec["_repo_root"] = root
    sources = dict(spec.get("sources") or {})

    def resolve(path):
        return path if os.path.isabs(path) else os.path.join(root, path)

    compose = [resolve(p) for p in (args.compose or sources.get("compose") or [])]
    if not compose:
        print("enclave-check: no compose files configured", file=sys.stderr)
        return 3
    missing = [p for p in compose if not os.path.exists(p)]
    if missing:
        print(f"enclave-check: compose file(s) not found: {missing}", file=sys.stderr)
        return 3
    env_file = args.env_file or sources.get("env_file")
    env_file = resolve(env_file) if env_file else None
    sources_cfg = dict(sources)
    if sources.get("build_guard"):
        sources_cfg["build_guard"] = resolve(sources["build_guard"])

    try:
        topo = M.build_topology(compose, env_file=env_file, sources_cfg=sources_cfg)
    except M.ModelError as exc:
        print(f"enclave-check: cannot model the deployment: {exc}", file=sys.stderr)
        return 3

    use_color = sys.stdout.isatty() and not args.no_color and not args.json
    out = sys.stdout

    if args.dump_model:
        dump_model(topo, out)
        return 0

    wanted = set(args.only or [])
    results = []
    for inv in spec["invariants"]:
        if wanted and inv.get("id") not in wanted:
            continue
        fn = CHECKS.get(inv.get("type"))
        if fn is None:
            res = Result(inv)
            res.record(UNKNOWN, f"no check implements type {inv.get('type')!r}")
            results.append(res)
            continue
        try:
            results.append(fn(topo, inv, spec))
        except (M.ModelError, KeyError, TypeError, ValueError) as exc:
            res = Result(inv)
            res.record(UNKNOWN, f"check raised: {type(exc).__name__}: {exc}")
            results.append(res)
    if wanted:
        for missing_id in sorted(wanted - {r.id for r in results}):
            print(f"enclave-check: no invariant with id {missing_id!r}", file=sys.stderr)
            return 3

    counts = {PASS: 0, FAIL: 0, UNKNOWN: 0}
    for res in results:
        counts[res.status] += 1

    if args.json:
        print(json.dumps(
            {
                "sources": {
                    "compose": [_rel(p, root) for p in compose],
                    "env_file": _rel(env_file, root) if env_file else None,
                },
                "model": {
                    "services": len(topo.services),
                    "networks": len(topo.networks),
                    "internal_networks": sorted(
                        n for n, v in topo.networks.items() if v.internal
                    ),
                    "agent_cells": sorted(
                        s.name for s in topo.services.values() if s.agent_config
                    ),
                    "guard_policy_agents": sorted(topo.guard_policy or {}),
                    "guard_error": topo.guard_error,
                    "unresolved_variables": topo.unresolved,
                    "notes": topo.notes,
                },
                "summary": counts,
                "results": [r.as_dict() for r in results],
            },
            indent=2,
        ))
    else:
        internal = sorted(n for n, v in topo.networks.items() if v.internal)
        cells = sorted(s.name for s in topo.services.values() if s.agent_config)
        print("enclave-check", file=out)
        for path in compose:
            print(f"  compose : {_rel(path, root)}", file=out)
        if env_file:
            print(f"  env     : {_rel(env_file, root)}", file=out)
        print(
            f"  model   : {len(topo.services)} services, {len(topo.networks)} networks "
            f"({len(internal)} internal: {', '.join(internal)})",
            file=out,
        )
        print(f"  cells   : {', '.join(cells) or 'none discovered'}", file=out)
        if topo.guard_error:
            print(f"  guard   : UNAVAILABLE — {topo.guard_error}", file=out)
        else:
            print(f"  guard   : AGENT_POLICY for {', '.join(sorted(topo.guard_policy or {}))}", file=out)
        if topo.unresolved:
            print(f"  unset   : {', '.join(topo.unresolved)} (checks depending on these answer UNKNOWN)", file=out)
        for note in topo.notes:
            print(f"  note    : {note}", file=out)
        print(file=out)
        for res in results:
            print(f"{_paint(res.status, use_color)} {res.id}", file=out)
            if res.statement:
                for line in res.statement.splitlines():
                    print(f"        {line.strip()}", file=out)
            for reason in res.reasons:
                print(f"        -> {reason}", file=out)
            if args.verbose and res.why:
                for line in res.why.splitlines():
                    print(f"        | {line.strip()}", file=out)
            if args.verbose:
                for line in res.evidence:
                    print(f"          {line}", file=out)
            elif res.status != PASS:
                for line in res.evidence:
                    if line.startswith(("FAIL", "UNKNOWN")):
                        print(f"          {line}", file=out)
            print(file=out)
        print(
            f"{counts[PASS]} PASS  {counts[FAIL]} FAIL  {counts[UNKNOWN]} UNKNOWN"
            + ("   (UNKNOWN is a finding, not a pass)" if counts[UNKNOWN] else ""),
            file=out,
        )

    if counts[FAIL]:
        return 1
    if counts[UNKNOWN]:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
