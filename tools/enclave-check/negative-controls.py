#!/usr/bin/env python3
"""Prove every invariant can FAIL. An invariant that cannot fail is not a check.

For each shipped invariant this applies a mutation to a COPY of the real config
that should break it, runs the checker, and reports what actually happened. The
real tree is never touched.

This exists because one of the original invariants was UNFALSIFIABLE and passed
for the wrong reason: the dual-homed-bridge check counted services bridging an
`internal: true` network to a non-internal one, so DELETING `internal: true`
removed that network's members from the set being counted and the checker
reported the weakening as an improvement. It was found by trying to break it,
not by reading it.

Usage:  python3 tools/enclave-check/negative-controls.py [--verbose]
Exit 0 when every invariant was falsified, 1 otherwise.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
COMPOSE = REPO / "openclaw-docker-config/docker-compose.yml"
GUARD = REPO / "openclaw-enclave/plugins/build-guard/index.mjs"
BASELINE = REPO / "openclaw-enclave/templates/exec-allowlist.baseline"
CURATOR_JSON = REPO / "openclaw-enclave/openclaw-secure-config-curator/openclaw.json"


# ── mutations ────────────────────────────────────────────────────────────────
# Each returns the mutated text, or raises if its anchor is gone — a mutation
# that silently no-ops would report the invariant as unfalsifiable when the real
# problem is that this file has drifted.

def _sub1(text, pattern, repl, what):
    out, n = re.subn(pattern, repl, text, count=1)
    if n != 1:
        raise RuntimeError(f"anchor not found for {what}: {pattern!r}")
    return out


def mut_sealer_gets_a_model(text):
    """Give the sealer a model endpoint AND a route to it.

    BOTH HALVES ARE REQUIRED, and finding that out is the point of running these.
    The env var alone leaves the invariant passing, and that is correct rather
    than a hole: the check asks whether the endpoint is REACHABLE, and a
    `network_mode: none` container cannot be told what to do by a model it has no
    route to. An OPENAI_API_BASE on the sealer as it stands is a dead string.

    So the dangerous configuration — the one the invariant exists to catch — is
    the endpoint plus a network, and that is what this builds. Appended INTO the
    existing environment block, in its list form; a second `environment:` key
    would be silently dropped by the loader and test nothing.
    """
    text = _sub1(
        text,
        r"(  quarantine-sealer:\n(?:.*\n)*?    environment:\n)",
        r"\1      - OPENAI_API_BASE=http://qwen-forward:1234/v1\n",
        "sealer model endpoint",
    )
    return _sub1(
        text,
        r'(  quarantine-sealer:\n(?:.*\n)*?)    network_mode: "none"\n',
        r"\1    networks:\n      - net_main\n",
        "sealer network_mode none",
    )


def mut_curator_can_cron(text):
    """Remove `cron` from the curator's tool deny list."""
    return _sub1(text, r'\n\s*"cron",', "", "curator cron deny")


def mut_scout_not_internal(text):
    """Drop `internal: true` from net_scout. Also the historic false-negative."""
    return _sub1(
        text,
        r"(  net_scout:\n(?:.*\n)*?)    internal: true\n",
        r"\1",
        "net_scout internal",
    )


def _curator_mount(text, leaf):
    """Add a `${prefix}/exchange/<leaf>` mount to openclaw-curator.

    The host prefix is CAPTURED from the neighbouring normalized/ line rather
    than written literally. run() repoints every bind source at the temp copy
    before mutating, so a hardcoded `~/path/to/openclaw-secure-deploy` anchor stops matching
    — which is exactly how these two silently degraded into MUTATION BROKEN and
    reported their invariant as unfalsifiable.
    """
    return _sub1(
        text,
        r"(  openclaw-curator:\n(?:.*\n)*?      - (\S+)/exchange/normalized:[^\n]*\n)",
        lambda m: f"{m.group(1)}      - {m.group(2)}/exchange/{leaf}:"
                  f"/home/node/exchange/{leaf}:ro\n",
        f"curator {leaf} mount",
    )


def mut_curator_mounts_briefs(text):
    return _curator_mount(text, "briefs")


def mut_curator_mounts_flagged(text):
    return _curator_mount(text, "briefs-flagged")


def mut_guard_drops_flagged_deny(text):
    """Remove briefs-flagged from the guard's readDeny only. The docker layer
    still holds, so this must fail on the GUARD layer specifically."""
    return _sub1(
        text,
        r"\n\s*`\$\{EXCHANGE\}/briefs-flagged`,(\n\s*\],\n\s*write:)",
        r"\1",
        "guard readDeny briefs-flagged",
    )


def mut_cell3_writes_briefs(text):
    """Make cell 3's briefs mount writable."""
    return _sub1(
        text,
        r"(exchange/briefs:/home/node/exchange/briefs):ro",
        r"\1",
        "cell 3 briefs :ro",
    )


def mut_no_proxy_wildcard(text):
    """A wildcard in NO_PROXY restores direct internet for anything honouring it."""
    return _sub1(text, r"(- NO_PROXY=)", r"\1*.com,", "NO_PROXY uppercase")


def mut_no_proxy_lowercase(text):
    """THE SUBTLE ONE, and the reason this control exists separately.

    compose sets BOTH spellings on every proxied cell (`- NO_PROXY=...` and
    `- no_proxy=...`) and clients honour either. A checker that reads only the
    uppercase name would report all-clear while a hole sits in the lowercase
    one. This mutation touches ONLY the lowercase spelling: if the invariant
    still passes, it is reading half the config.
    """
    return _sub1(text, r"(- no_proxy=)", r"\1*.com,", "no_proxy lowercase")


def mut_baseline_guard_hash(text):
    return _sub1(text, r"(guard sha256=)[0-9a-f]{64}", r"\g<1>" + "0" * 64, "baseline hash")


CONTROLS = [
    ("no-model-holds-all-three", COMPOSE, mut_sealer_gets_a_model,
     "give quarantine-sealer a model endpoint"),
    ("no-agent-edits-own-schedule", CURATOR_JSON, mut_curator_can_cron,
     "remove `cron` from curator tools.deny"),
    ("no-lethal-trifecta-path", COMPOSE, mut_scout_not_internal,
     "drop `internal: true` from net_scout"),
    ("internal-networks-have-no-egress", COMPOSE, mut_scout_not_internal,
     "drop `internal: true` from net_scout"),
    ("curator-cannot-see-past-its-own-gate", COMPOSE, mut_curator_mounts_briefs,
     "mount briefs/ into openclaw-curator"),
    ("curator-cannot-see-past-its-own-gate", COMPOSE, mut_curator_mounts_flagged,
     "mount briefs-flagged/ into openclaw-curator"),
    ("curator-cannot-see-past-its-own-gate", GUARD, mut_guard_drops_flagged_deny,
     "remove briefs-flagged from guard readDeny (guard layer only)"),
    ("only-the-sealer-writes-the-destinations", COMPOSE, mut_cell3_writes_briefs,
     "make cell 3's briefs/ mount writable"),
    ("no-proxy-names-only-qwen-forward", COMPOSE, mut_no_proxy_wildcard,
     "add *.com to NO_PROXY"),
    ("no-proxy-names-only-qwen-forward", COMPOSE, mut_no_proxy_lowercase,
     "add *.com to lowercase no_proxy only"),
    ("baseline-matches-config", BASELINE, mut_baseline_guard_hash,
     "zero the pinned guard sha256"),
]


def run_checker(root: Path) -> dict[str, str]:
    proc = subprocess.run(
        [sys.executable, str(HERE / "check.py"),
         "-f", str(root / "openclaw-docker-config/docker-compose.yml"),
         "--env-file", str(root / "openclaw-docker-config/.env"),
         "--invariants", str(HERE / "invariants.yaml"),
         "--repo-root", str(root), "--no-color"],
        capture_output=True, text=True,
    )
    verdicts = {}
    for line in proc.stdout.splitlines():
        m = re.match(r"^(PASS|FAIL|UNKNOWN)\s+(\S+)", line)
        if m:
            verdicts[m.group(2)] = m.group(1)
    return verdicts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    baseline_verdicts = run_checker(REPO)
    print("baseline (unmutated tree):")
    for k, v in baseline_verdicts.items():
        print(f"  {v:<8} {k}")
    not_passing = [k for k, v in baseline_verdicts.items() if v != "PASS"]
    if not_passing:
        print(f"\nrefusing to run controls: {not_passing} are not PASS on the real tree.")
        return 1

    print(f"\n{'invariant':<42} {'mutation':<48} {'expect':<7} actual")
    print("-" * 112)
    rows, bad = [], []
    for inv_id, target, mutate, label in CONTROLS:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            shutil.copytree(REPO, root, symlinks=True, ignore=shutil.ignore_patterns(
                ".git", "backups", "__pycache__", "*.sqlite*", "node_modules"))
            # REPOINT THE MOUNT SOURCES AT THE COPY. compose bind sources are
            # absolute (`~/path/to/openclaw-secure-deploy/...`), so copying the tree is not
            # enough on its own: every check that READS a file through a mount —
            # the agent configs, the guard policy — would follow the path back
            # out to the real repo and grade the unmutated original. The
            # docker-layer checks match on path suffix and were unaffected,
            # which is exactly why this was invisible: half the checks moved
            # with the copy and half did not.
            compose_copy = root / "openclaw-docker-config/docker-compose.yml"
            compose_copy.write_text(
                compose_copy.read_text(encoding="utf-8").replace(
                    "~/path/to/openclaw-secure-deploy", str(root)
                ),
                encoding="utf-8",
            )
            rel = target.relative_to(REPO)
            path = root / rel
            try:
                path.write_text(mutate(path.read_text(encoding="utf-8")), encoding="utf-8")
            except RuntimeError as exc:
                print(f"{inv_id:<42} {label:<48} {'FAIL':<7} MUTATION BROKEN: {exc}")
                bad.append((inv_id, label, f"mutation anchor missing: {exc}"))
                continue
            got = run_checker(root).get(inv_id, "(absent)")
        ok = got in ("FAIL", "UNKNOWN")
        print(f"{inv_id:<42} {label:<48} {'FAIL':<7} {got}{'' if ok else '   <-- UNFALSIFIABLE'}")
        rows.append((inv_id, label, got))
        if not ok:
            bad.append((inv_id, label, got))

    print()
    if bad:
        print(f"{len(bad)} control(s) did not falsify their invariant:")
        for inv_id, label, got in bad:
            print(f"  - {inv_id}: {label} -> {got}")
        print("\nAn invariant that cannot fail is not a check. Fix the invariant,")
        print("not the control — see the dual-homed case in the module docstring.")
        return 1
    print(f"all {len(rows)} controls falsified their invariant")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
