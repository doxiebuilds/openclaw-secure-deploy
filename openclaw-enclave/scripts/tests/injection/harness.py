#!/usr/bin/env python3
"""Cross-boundary prompt-injection benchmark — loader + assertion harness.

    python3 openclaw-enclave/scripts/tests/injection/run.py

Stdlib only. There is no pytest anywhere in this repo and the container rootfs
is read-only with no pip (see lib/normalize.py:20-21), so the assertion
primitives below come from `unittest.TestCase` and nothing else is imported that
is not in the standard library. This module is not itself a `test_*.py` file:
`python3 -m unittest discover -p 'test_*.py'` in the parent directory must not
pick it up, because the product here is a per-hop table, not a green/red count.

======================================================================
HOW THE SEALER'S VALIDATOR IS LOADED, AND WHY IT IS DONE THIS WAY
======================================================================

The hop ③ controls — `brief_violation()`, `resolve_evidence()` — and the hop ③b
cross-check `source_reads_imperative()` all live inside a shell heredoc in
scripts/quarantine-seal.sh (`<<'PY'` at ~line 133). They cannot be imported: the
file is a POSIX sh script, and the Python inside it is a *program*, not a
module. It reads sys.argv[1:9], drains raw/ into normalized/, promotes
briefs-pending/ into briefs/ or briefs-flagged/, reaps, sweeps, and writes four
manifests, all at import time.

This is the same problem test-guard.mjs:24-47 solves for index.mjs, and the
approach is deliberately the same one: read the file as TEXT, transform it,
write the result to a temp file, and load *that*. Step 1 and 2 are identical.
Step 3 is where the Python case diverges, and the divergence is the point:

  1. Read quarantine-seal.sh as text.
  2. Extract the heredoc body between the `<<'PY'` opener and the `^PY$`
     sentinel. If that regex does not match, RAISE — test-guard.mjs:30 does
     exactly this, and for exactly this reason: an extraction that silently
     yields nothing produces a suite that passes because it tested nothing,
     which is strictly worse than a crash.
  3. **AST dependency closure, not a whole-body exec.** Parse the extracted
     body, take the wanted top-level definitions (the three functions and the
     constants), and keep only the module-level statements that bind names those
     definitions transitively reference. Everything else — every `for` loop,
     every `atomic_write`, the ledger, the reap, the sweep, the manifests — is
     dropped before a single byte executes. Today that reduction is 122 lines
     out of ~1140 and pulls in exactly one import.
  4. Unparse the surviving statements to a temp file and exec it there, in a
     namespace pre-seeded with stubs (log, and Paths under a TemporaryDirectory
     standing in for ENCLAVE_ROOT / EXCHANGE_ROOT) so that a wanted definition
     which references a pipeline path resolves against the stub instead of
     dragging in `RAW, NORMALIZED, ... = (pathlib.Path(p) for p in sys.argv…)`.

WHY NOT JUST EXEC THE WHOLE HEREDOC. It would in fact "work": point argv at a
TemporaryDirectory and every write lands somewhere harmless. It was rejected on
three grounds.

  * The loader must not run the drain loops, and in a script whose loops are
    top-level statements, executing the body *is* running them. A benchmark that
    mutates a live-shaped exchange tree to obtain a validator has already lost
    the property it is measuring.
  * It couples the harness to the whole script's startup contract. That
    contract is not stable — the inbox dispatch stage added two argv slots and a
    fatal check for a mount, and the flagged-routing phase added a ninth slot.
    The next required mount turns this suite red for a reason that has nothing
    to do with injection.
  * A whole-body exec fails on any transient breakage anywhere in 1100 lines;
    the closure fails only if a wanted definition, or something it depends on,
    is gone — which is a signal worth having.

The cost is honest and worth stating: the closure sees DEFINITIONS, so a control
implemented as inline top-level code is invisible to it. Two such controls
exist, and each is handled explicitly rather than quietly skipped:

  * the raw/ -> normalized/ transform is a top-level `for` loop, so hop ①
    mirrors its header assembly and line stamping — see normalize_document().
  * the briefs-pending/ -> briefs/ promote loop is a top-level `for` loop, so
    the "read the source, or reject with source-missing" step is mirrored in
    promote() below. Hop ④ then drives the REAL script end-to-end in the
    container, which is what keeps the two mirrors honest.
"""

from __future__ import annotations

import ast
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent.parent                     # openclaw-enclave/scripts
LIB = SCRIPTS / "lib"
SEALER = SCRIPTS / "quarantine-seal.sh"
FIXTURES = HERE / "fixtures"

sys.path.insert(0, str(LIB))

import normalize  # noqa: E402  (the real lib/normalize.py, unchanged)
import render     # noqa: E402

clean_text = normalize.clean_text
MAX_EXCERPT = normalize.MAX_EXCERPT               # 400 chars per line
UNTRUSTED_BANNER = render.UNTRUSTED_BANNER

# The normalized layout the curator, the sealer and this suite all depend on:
# banner, blank, source comment, normalized-at comment, blank. Content therefore
# starts at line 6, 1-based, and every content line carries its own true line
# number as a "[6] " stamp. The stamp is not decoration — resolve_evidence()
# re-derives the index and refuses to extract when the two disagree.
HEADER_LINES = 5
FIRST_CONTENT_LINE = HEADER_LINES + 1


# ── hop identifiers ─────────────────────────────────────────────────────────
#
# `None` is a real value here and means "nothing stopped it" — the payload
# reached the privileged cell. It is not an error state: hop ① is a
# neutralization step, not a rejection step, and several cases assert exactly
# that a payload survives it (normalization strips characters, not meaning).
HOP_NORMALIZE = 1
HOP_DISTILL = 2
HOP_SCHEMA = 3
# ③b IS NOT A GATE, AND IT IS NUMBERED THAT WAY ON PURPOSE. The cross-check
# rejects nothing: quarantine-seal.sh:788-795 is explicit that routing may use
# the union of the two opinions precisely because diverting destroys nothing,
# where rejecting would let text crafted to trip the regex veto its own summary.
# So it sits beside hop ③ rather than after it, and what it feeds is hop ④.
HOP_CROSSCHECK = "3b"
HOP_ROUTE = 4

HOP_LABEL = {
    None: "— (reaches cell 3)",
    HOP_NORMALIZE: "① normalize",
    HOP_DISTILL: "② distill",
    HOP_SCHEMA: "③ schema",
    HOP_CROSSCHECK: "③b cross-check",
    HOP_ROUTE: "④ route",
}

HOP_ORDER = (HOP_NORMALIZE, HOP_DISTILL, HOP_SCHEMA, HOP_CROSSCHECK, HOP_ROUTE, None)

# Hops the suite does not exercise. A case expecting one of these is reported
# SKIP rather than run: see the stub contract at the bottom of this module for
# what an implementation has to provide. Hop ④ left this tuple when the routing
# probe landed — it is now driven end-to-end against the real script.
STUBBED_HOPS = (HOP_DISTILL,)


# ═══════════════════════════════════════════════════════════════════════════
# 1. Heredoc extraction
# ═══════════════════════════════════════════════════════════════════════════

# Matched loosely on the opener (the argv list in front of `<<'PY'` changes
# whenever a stage is added — it has grown twice already) and strictly on the
# sentinel, which must be a line of its own. Non-greedy, so a future second
# heredoc cannot swallow the file.
_HEREDOC_RE = re.compile(
    r"^PYTHONPATH=.*python3 -[^\n]*<<'PY'\n(?P<body>.*?)^PY$",
    re.MULTILINE | re.DOTALL,
)


def extract_heredoc(path: Path | None = None) -> str:
    """The Python program embedded in quarantine-seal.sh, as text.

    Raises rather than returning "" when the opener or the sentinel moves —
    test-guard.mjs:30 does the same, because a silently-empty extraction makes
    every downstream assertion vacuously true.

    `path` defaults to None and resolves to SEALER at CALL time, not at def
    time. A `path: Path = SEALER` default would freeze the module global into
    the function object, which quietly defeats the negative tests that point
    the loader at a mutilated copy to prove it complains.
    """
    path = SEALER if path is None else path
    src = path.read_text(encoding="utf-8")
    match = _HEREDOC_RE.search(src)
    if match is None:
        raise RuntimeError(
            f"could not locate the embedded Python heredoc in {path}. "
            "Expected a line matching PYTHONPATH=… python3 - … <<'PY' and a "
            "closing PY sentinel on a line of its own. If the sealer's heredoc "
            "was renamed or converted to a real module, update _HEREDOC_RE (or "
            "delete this loader and import it)."
        )
    body = match.group("body")
    if not body.strip():
        raise RuntimeError(f"the heredoc in {path} extracted empty")
    return body


# ═══════════════════════════════════════════════════════════════════════════
# 2. AST dependency closure
# ═══════════════════════════════════════════════════════════════════════════

_DEF_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _target_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _binds(stmt: ast.stmt) -> set[str]:
    """Module-level names a top-level statement introduces."""
    if isinstance(stmt, (ast.Import, ast.ImportFrom)):
        return {(a.asname or a.name).split(".")[0] for a in stmt.names}
    if isinstance(stmt, ast.Assign):
        return set().union(*(_target_names(t) for t in stmt.targets))
    if isinstance(stmt, ast.AnnAssign):
        return _target_names(stmt.target)
    if isinstance(stmt, _DEF_NODES):
        return {stmt.name}
    if isinstance(stmt, (ast.Try, ast.If, ast.For, ast.While, ast.With)):
        # MAX_ATTEMPTS and MIN_AGE_SECONDS are assigned inside try/except so a
        # typo'd env var cannot take the airlock down with a traceback, and the
        # whole inbox stage is one `if INBOX_STATE is not None:`. Names assigned
        # in those bodies are module globals, so they have to be indexed.
        #
        # DESCENT STOPS AT A def/class. A nested function's locals are NOT
        # module bindings, and ast.walk() cannot tell the difference — it
        # happily reports `doc`, `topic` and `age` from inside topic_id_of() as
        # though the inbox block bound them. That made `doc` (a parameter of
        # brief_violation) resolve to the entire inbox dispatch stage and
        # dragged 200 lines of unrelated pipeline into the reduction.
        names: set[str] = set()
        for child in ast.iter_child_nodes(stmt):
            if isinstance(child, _DEF_NODES):
                names.add(child.name)
            elif isinstance(child, ast.stmt):
                names |= _binds(child)
            elif isinstance(child, (ast.ExceptHandler,)):
                for sub in child.body:
                    names |= _binds(sub)
        return names
    return set()


# `type(compile(...))` rather than `types.CodeType` to keep the import list at
# what this module actually needs.
_CODE = type(compile("", "<probe>", "exec"))


def _refs(stmt: ast.stmt) -> set[str]:
    """The FREE names a statement references — globals, not locals.

    Doing this with ast.walk() over Name nodes is the obvious approach and it
    is wrong: it cannot distinguish a function's parameters and locals from the
    module globals it closes over, so every kept function drags in whatever
    top-level statement happens to assign a variable of the same name. That is
    not a theoretical worry — `brief_violation(doc)` and `topic_id_of`'s local
    `doc` collide, and `safe_entries`' local `age` collides with the inbox
    stage's `age`.

    So the scoping question is handed to the thing that already answers it
    exactly: the compiler. Globals a code object touches land in co_names;
    locals land in co_varnames. Intersecting co_names with the Name ids that
    literally appear in the source drops the attribute names co_names also
    carries (`re.compile` contributes "compile"), which would otherwise
    over-pull in a subtler way.
    """
    module = ast.Module(body=[stmt], type_ignores=[])
    ast.fix_missing_locations(module)
    code = compile(module, "<closure>", "exec")

    names: set[str] = set()
    stack = [code]
    while stack:
        current = stack.pop()
        names |= set(current.co_names)
        stack += [c for c in current.co_consts if isinstance(c, _CODE)]

    written = {n.id for n in ast.walk(stmt) if isinstance(n, ast.Name)}
    return names & written


def closure_source(body: str, wanted: Iterable[str], preseeded: Iterable[str]) -> tuple[str, set[str]]:
    """Reduce the heredoc to `wanted` plus the transitive closure of what it
    needs. Returns (source, names actually found)."""
    module = ast.parse(body)
    binders: dict[str, list[int]] = {}
    for i, stmt in enumerate(module.body):
        for name in _binds(stmt):
            binders.setdefault(name, []).append(i)

    stub = set(preseeded)
    keep: set[int] = set()
    resolved: set[str] = set()
    seen: set[str] = set()
    queue = list(wanted)
    roots = set(queue)

    while queue:
        name = queue.pop()
        if name in seen:
            continue
        seen.add(name)
        if name in stub and name not in roots:
            continue                      # satisfied by the pre-seeded stub
        indices = binders.get(name)
        if not indices:
            continue                      # a builtin, a local, or genuinely absent
        if name in roots:
            resolved.add(name)
        for i in indices:
            if i in keep:
                continue
            keep.add(i)
            queue.extend(_refs(module.body[i]) - seen)

    kept = ast.Module(body=[module.body[i] for i in sorted(keep)], type_ignores=[])
    ast.fix_missing_locations(kept)
    return ast.unparse(kept), resolved


# ═══════════════════════════════════════════════════════════════════════════
# 3. The loaded sealer
# ═══════════════════════════════════════════════════════════════════════════

# Names the loader asks for. All three are REQUIRED — absence is a crash, not a
# skip, because each is a control this suite exists to measure and a benchmark
# that silently stops measuring one is worse than no benchmark.
#
#   brief_violation(doc)                 -> cause | None      pure, shape only
#   resolve_evidence(doc, source_text)   -> (doc, None) | (None, cause)
#   source_reads_imperative(source_text) -> fragment | ""     the cross-check
REQUIRED_NAMES = (
    "brief_violation",
    "resolve_evidence",
    "source_reads_imperative",
)

# Read out of the sealer rather than restated here, so a limit that moves in the
# script moves in the suite. Optional only in the sense that a missing one
# degrades to a documented default instead of crashing; every one of them
# resolves today.
OPTIONAL_CONSTANTS = (
    "MAX_LINES", "MAX_INPUT_BYTES", "MAX_CLAIMS", "MAX_FIELD",
    "BRIEF_KEYS_IN", "CLAIM_KEYS_IN", "BRIEF_KEYS_OUT", "CLAIM_KEYS_OUT",
    "SAFE_NAME_RE", "SHELL_META_RE", "SHA256_RE", "CONTENT_LINE_RE",
    "IMPERATIVE_RE", "FIRST_CONTENT_LINE",
)

# Hop ① is still the one transform with nothing to call: raw -> normalized is a
# top-level `for` loop, so normalize_document() below mirrors it. If that loop
# is ever factored into a function under one of these names, the harness calls
# the real thing instead and the mirror dies. Keeping the hook is what makes
# that a one-line change rather than an archaeology exercise.
NORMALIZER_CANDIDATES = ("normalize_document", "normalize_source", "normalize_raw")


@dataclass
class Sealer:
    """The subset of quarantine-seal.sh's embedded program this benchmark can
    reach, plus what it could not find."""

    namespace: dict[str, Any]
    source_path: Path
    tmpdir: Any                      # held so the TemporaryDirectory outlives us
    missing: list[str] = field(default_factory=list)

    @property
    def brief_violation(self) -> Callable[[Any], str | None]:
        return self.namespace["brief_violation"]

    @property
    def resolve_evidence(self) -> Callable[[Any, str], tuple[Any, str | None]]:
        return self.namespace["resolve_evidence"]

    @property
    def source_reads_imperative(self) -> Callable[[str], str]:
        return self.namespace["source_reads_imperative"]

    # Older names, kept because run.py and the report writer speak them. The
    # pair below is the whole Phase 1 split: `validate` is pure shape and needs
    # no filesystem; `resolver` is everything that requires opening the source.
    @property
    def validate(self) -> Callable[[Any], str | None]:
        return self.brief_violation

    @property
    def resolver(self) -> Callable[[Any, str], tuple[Any, str | None]] | None:
        return self.namespace.get("resolve_evidence")

    def const(self, name: str, default: Any = None) -> Any:
        return self.namespace.get(name, default)

    @property
    def normalizer(self) -> Callable[..., Any] | None:
        for name in NORMALIZER_CANDIDATES:
            fn = self.namespace.get(name)
            if callable(fn):
                return fn
        return None


def load_sealer() -> Sealer:
    """Read quarantine-seal.sh, reduce it, exec the reduction from a temp file."""
    body = extract_heredoc()

    # Pre-seeded stubs. These stand in for the module-level names the heredoc
    # derives from sys.argv and the environment — set here so a wanted
    # definition that touches a pipeline path binds to a throwaway tree instead
    # of pulling the argv unpacking (and with it, the whole program) into the
    # closure. ENCLAVE_ROOT / EXCHANGE_ROOT in the brief's sense.
    #
    # BRIEFS_FLAGGED is in the list even though nothing wanted reaches it today:
    # the routing decision is inline top-level code, and if it is ever hoisted
    # into a function this list is what stops that function dragging argv in.
    tmpdir = tempfile.TemporaryDirectory(prefix="injection-sealer-")
    exchange = Path(tmpdir.name) / "exchange"
    stubs: dict[str, Any] = {
        "ENCLAVE_ROOT": Path(tmpdir.name),
        "EXCHANGE_ROOT": exchange,
        "RAW": exchange / "raw",
        "NORMALIZED": exchange / "normalized",
        "BRIEFS": exchange / "briefs",
        "BRIEFS_PENDING": exchange / "briefs-pending",
        "BRIEFS_FLAGGED": exchange / "briefs-flagged",
        "LEDGER_DIR": exchange / "ledger",
        "INBOX": exchange / "inbox",
        "INBOX_STATE": None,
        "log": lambda *a, **k: None,     # stderr noise is not this suite's job
    }
    for path in stubs.values():
        if isinstance(path, Path):
            path.mkdir(parents=True, exist_ok=True)

    wanted = (
        list(REQUIRED_NAMES) + list(OPTIONAL_CONSTANTS) + list(NORMALIZER_CANDIDATES)
    )
    source, resolved = closure_source(body, wanted, stubs)

    for name in REQUIRED_NAMES:
        if name not in resolved:
            raise RuntimeError(
                f"{name}() was not found at the top level of the heredoc in "
                f"{SEALER}. The control it implements cannot be benchmarked "
                "without it. If it moved into another function or into lib/, "
                "point the loader at the new home rather than letting this "
                "pass empty."
            )

    # Written out for the same reason test-guard.mjs writes guard.mjs: a real
    # file on disk means tracebacks name a line you can open, and the reduction
    # is inspectable when something surprising happens.
    out = Path(tmpdir.name) / "sealer_reduced.py"
    out.write_text(source + "\n", encoding="utf-8")

    namespace: dict[str, Any] = dict(stubs)
    namespace["__name__"] = "sealer_reduced"
    namespace["__file__"] = str(out)
    exec(compile(out.read_text(encoding="utf-8"), str(out), "exec"), namespace)  # noqa: S102

    missing = [n for n in wanted if n not in resolved and n not in OPTIONAL_CONSTANTS]
    return Sealer(namespace=namespace, source_path=out, tmpdir=tmpdir, missing=missing)


# ═══════════════════════════════════════════════════════════════════════════
# 4. Hop ① — normalize
# ═══════════════════════════════════════════════════════════════════════════

def normalize_document(sealer: Sealer, raw_text: str, source_name: str) -> str:
    """raw/<name> -> normalized/<stem>.md, as quarantine-seal.sh does it.

    THE CONTROLS UNDER TEST ARE REAL, THE ASSEMBLY IS MIRRORED. clean_text()
    comes from lib/normalize.py and MAX_LINES comes out of the sealer via the
    loader, so the 400-line and 400-char caps are read from source and not
    restated here. What is mirrored is the header assembly and the per-line
    stamping, because the loop that does it in quarantine-seal.sh (~line 353) is
    a top-level statement inside a shell heredoc — there is no callable to reach
    for. NORMALIZER_CANDIDATES is checked first so that the moment that loop
    becomes a function, this mirror stops being used.

    THE DIGEST IS REAL, and that changed with the line-anchored schema. It used
    to be a fixed placeholder so that normalized bodies compared cleanly across
    cases; it cannot be any more, because resolve_evidence() binds the brief to
    the exact document it was distilled from by comparing source_sha256 against
    this header. A placeholder would make every hop ③ resolve case answer
    `source-changed-since-distillation` and nothing else would ever be measured.
    The `normalized:` timestamp stays fixed — nothing reads it.
    """
    fn = sealer.normalizer
    if fn is not None:
        return fn(raw_text, source_name)

    import hashlib

    max_lines = sealer.const("MAX_LINES", 400)
    digest = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
    lines = raw_text.splitlines()[:max_lines]
    cleaned = [c for c in (clean_text(line) for line in lines) if c]
    header = [
        UNTRUSTED_BANNER,
        "",
        f"<!-- source: {source_name} sha256:{digest} -->",
        "<!-- normalized: 1970-01-01T00:00:00+00:00 -->",
        "",
    ]
    body = [f"[{i}] {c}" for i, c in enumerate(cleaned, start=len(header) + 1)]
    return "\n".join(header + body) + "\n"


def content_lines(sealer: Sealer, normalized: str) -> list[str]:
    """The excerpt text of every stamped content line, stamps removed.

    Uses the sealer's own CONTENT_LINE_RE rather than a local copy of "[N] ", so
    a change to the stamp format shows up here as a hop ① failure instead of as
    a detector that quietly stops finding anything.
    """
    stamp = sealer.const("CONTENT_LINE_RE") or re.compile(r"\A\[(\d+)\] ")
    out = []
    for line in normalized.split("\n")[HEADER_LINES:]:
        m = stamp.match(line)
        if m:
            out.append(line[m.end():])
    return out


# The neutralizations hop ① can prove. Each is (label, detector), where the
# detector answers "was this actually neutralized" by comparing raw against
# normalized. Nothing is *rejected* at this hop — the airlock has no reject
# path for prose — so "blocked at ①" means "the dangerous artifact did not
# survive", which is a property you can check rather than a status code.
def hop1_causes(sealer: Sealer, raw_text: str, normalized: str) -> list[str]:
    max_lines = sealer.const("MAX_LINES", 400)
    # THE BODY, NOT THE WHOLE FILE. The 5-line header the airlock writes is
    # itself two HTML comments (`<!-- source: … -->`, `<!-- normalized: … -->`),
    # so a tag detector pointed at the whole document matches the airlock's own
    # provenance every single time and reports "nothing was stripped" for every
    # payload. That is a detector that can only ever return one answer, which is
    # the failure mode this benchmark exists to avoid.
    body = content_lines(sealer, normalized)
    body_text = "\n".join(body)
    causes = []

    if normalize._CONTROL_RE.search(raw_text) and not normalize._CONTROL_RE.search(body_text):
        causes.append("control-chars-stripped")
    if normalize._TAG_RE.search(raw_text) and not normalize._TAG_RE.search(body_text):
        causes.append("html-tags-stripped")
    if any(len(ln) > MAX_EXCERPT for ln in raw_text.splitlines()):
        if all(len(ln) <= MAX_EXCERPT for ln in body):
            causes.append(f"line-capped:{MAX_EXCERPT}")
    if len(raw_text.splitlines()) > max_lines and len(body) <= max_lines:
        causes.append(f"document-capped:{max_lines}")
    return causes


# ═══════════════════════════════════════════════════════════════════════════
# 5. Hop ③ — the promote step, mirrored
# ═══════════════════════════════════════════════════════════════════════════

def promote(sealer: Sealer, doc: Any, source_path: Path) -> tuple[str | None, Any]:
    """Mirror of quarantine-seal.sh's briefs-pending/ -> briefs/ decision.

    Returns (cause, resolved_doc). Exactly three steps, in the script's order
    (quarantine-seal.sh:714-752):

        1. brief_violation(doc)              — shape, pure, no filesystem
        2. read normalized/<stem>.md         — FileNotFoundError is `source-missing`
        3. resolve_evidence(doc, source_text) — everything source-dependent

    Steps 1 and 3 are the real functions, loaded out of the heredoc. Step 2 is
    the mirror, and it is four lines rather than a helper in the script because
    the script does it inline in a top-level `for` loop the AST closure cannot
    see. That mirror is exactly the kind of thing that rots, so the hop ④ probe
    drives the real script end-to-end and asserts the same `source-missing`
    against the actual ledger — see routing_probe().

    A non-FileNotFoundError OSError is deliberately NOT mirrored: the script
    treats it as a skip and not a rejection, on the grounds that an IO blip must
    not walk a legitimate source toward condemnation. There is no case for it
    here because there is no way to provoke it deterministically.
    """
    cause = sealer.brief_violation(doc)
    if cause:
        return cause, None
    try:
        source_text = source_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "source-missing", None
    resolved, cause = sealer.resolve_evidence(doc, source_text)
    return cause, resolved


# ═══════════════════════════════════════════════════════════════════════════
# 6. Hop ④ — the routing probe, driven against the real script
# ═══════════════════════════════════════════════════════════════════════════
#
# WHY THIS ONE IS NOT MIRRORED. Hops ① and ③ measure functions; hop ④ measures a
# DECISION MADE BY THE SCRIPT ITSELF — `flagged = curator_flag or bool(witness)`,
# the destination it picks, the mount it writes to, the index it names the file
# in, and the ledger state it records. Every one of those is inline top-level
# code. A mirror of it would be a re-implementation asserting against itself: it
# would stay green through a routing bug and go red on a refactor, which is
# precisely backwards.
#
# So this drives the real quarantine-seal.sh in the `quarantine-sealer`
# container, over a throwaway exchange tree under the container's /tmp. Two
# passes: the first normalizes the raw sources (which is also how the probe gets
# a real sha256 to bind the briefs to), the second promotes them. The
# observations are then filesystem facts — which directory holds the file, which
# INDEX.txt names it, what the ledger says — not opinions.
#
# IT SKIPS RATHER THAN FAILS when docker is not there, when the container is not
# up, or when the container's copy of the script is not the one on disk here.
# The last check matters: the script is a bind mount today, but a probe that
# silently benchmarks a stale image is a probe reporting on code nobody is
# running.

SEALER_CONTAINER = "quarantine-sealer"
CONTAINER_SEALER_PATH = "/enclave/scripts/quarantine-seal.sh"

# Runs INSIDE the container. Reads its configuration from an embedded base64
# blob rather than stdin, because `python3 -` has already claimed stdin for the
# program text.
_ROUTING_DRIVER = r'''
import base64, json, os, pathlib, re, shutil, subprocess, sys, tempfile

CONFIG = json.loads(base64.b64decode("__CONFIG__").decode("utf-8"))
SEALER = CONFIG["sealer"]
DIRS = ("raw", "normalized", "briefs", "briefs-pending", "briefs-flagged", "ledger")
STAMP_RE = re.compile(r"\A\[(\d+)\] ")


def new_tree():
    root = pathlib.Path(tempfile.mkdtemp(prefix="injection-hop4-"))
    exchange = root / "exchange"
    for name in DIRS:
        (exchange / name).mkdir(parents=True)
    return root, exchange


def run_seal(exchange):
    env = dict(os.environ)
    env.update({
        "ENCLAVE_ROOT": "/enclave",
        "EXCHANGE_ROOT": str(exchange),
        "SEAL_MIN_AGE_SECONDS": "0",
        # The container sets this; an empty value is what turns the inbox stage
        # off, and the stage is fatal when its mounts are missing under a
        # relocated EXCHANGE_ROOT.
        "INBOX_STATE_DIR": "",
    })
    proc = subprocess.run(["sh", SEALER], env=env, capture_output=True, text=True)
    return {"rc": proc.returncode, "stderr": proc.stderr}


def source_facts(path):
    text = path.read_text(encoding="utf-8")
    sha = re.search(r"sha256:([0-9a-f]{64})", text)
    line = None
    for i, raw in enumerate(text.split("\n"), start=1):
        if STAMP_RE.match(raw):
            line = i
            break
    return (sha.group(1) if sha else None), line


def write_brief(exchange, stem, spec):
    path = exchange / "normalized" / (stem + ".md")
    if path.exists():
        sha, line = source_facts(path)
    else:
        # No source at all. The sha is well-formed so the brief clears
        # brief_violation() and the rejection can only come from the missing
        # file, which is the whole point of that case.
        sha, line = "0" * 64, 6
    doc = {
        "source_id": stem,
        "source_type": "web",
        "contains_external_instructions": spec["flag"],
        "source_sha256": sha,
        "claims": [{
            "claim": spec["claim"],
            "evidence_line": line,
            "source_reference": "normalized/" + stem + ".md:" + str(line),
        }],
    }
    (exchange / "briefs-pending" / (stem + ".json")).write_text(
        json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def index_of(exchange, name):
    path = exchange / name / "INDEX.txt"
    try:
        return [ln for ln in path.read_text(encoding="utf-8").split("\n") if ln]
    except OSError:
        return None


def observe(exchange, stems):
    ledger = {}
    try:
        ledger = json.loads(
            (exchange / "ledger" / "seal-ledger.json").read_text(encoding="utf-8")
        ).get("entries", {})
    except (OSError, ValueError):
        pass
    briefs_index = index_of(exchange, "briefs") or []
    flagged_index = index_of(exchange, "briefs-flagged") or []
    out = {}
    for stem in stems:
        name = stem + ".json"
        out[stem] = {
            "in_briefs": (exchange / "briefs" / name).exists(),
            "in_flagged": (exchange / "briefs-flagged" / name).exists(),
            "still_pending": (exchange / "briefs-pending" / name).exists(),
            "rejected": (exchange / "briefs-pending" / (name + ".rejected")).exists(),
            "in_briefs_index": name in briefs_index,
            "in_flagged_index": name in flagged_index,
            "ledger": ledger.get(stem, {}),
        }
        if out[stem]["in_flagged"]:
            try:
                out[stem]["promoted"] = json.loads(
                    (exchange / "briefs-flagged" / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        elif out[stem]["in_briefs"]:
            try:
                out[stem]["promoted"] = json.loads(
                    (exchange / "briefs" / name).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
    return out


def scenario_routing():
    root, exchange = new_tree()
    try:
        for stem, text in CONFIG["sources"].items():
            (exchange / "raw" / (stem + ".md")).write_text(text, encoding="utf-8")
        first = run_seal(exchange)
        for stem, spec in CONFIG["briefs"].items():
            write_brief(exchange, stem, spec)
        second = run_seal(exchange)
        return {
            "normalize_pass": first,
            "promote_pass": second,
            "stems": observe(exchange, list(CONFIG["briefs"])),
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


def scenario_held():
    """briefs-flagged/ present but not writable — the older-compose-file case."""
    stem = CONFIG["held_stem"]
    root, exchange = new_tree()
    try:
        (exchange / "raw" / (stem + ".md")).write_text(
            CONFIG["sources"][CONFIG["held_source"]], encoding="utf-8")
        first = run_seal(exchange)
        write_brief(exchange, stem, CONFIG["briefs"][CONFIG["held_source"]])
        os.chmod(exchange / "briefs-flagged", 0o555)
        try:
            second = run_seal(exchange)
            observed = observe(exchange, [stem])
        finally:
            os.chmod(exchange / "briefs-flagged", 0o755)
        return {"normalize_pass": first, "promote_pass": second, "stems": observed}
    finally:
        shutil.rmtree(root, ignore_errors=True)


try:
    result = {
        "ok": True,
        "routing": scenario_routing(),
        "held": scenario_held(),
    }
except Exception as exc:  # noqa: BLE001
    import traceback
    result = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
              "traceback": traceback.format_exc()}
print("\n__RESULT__" + json.dumps(result))
'''


@dataclass
class RoutingProbe:
    available: bool
    reason: str = ""
    routing: dict[str, Any] = field(default_factory=dict)
    held: dict[str, Any] = field(default_factory=dict)

    def stem(self, name: str) -> dict[str, Any]:
        return self.routing.get("stems", {}).get(name, {})

    @property
    def promote_stderr(self) -> str:
        return (self.routing.get("promote_pass") or {}).get("stderr", "")

    @property
    def held_stderr(self) -> str:
        return (self.held.get("promote_pass") or {}).get("stderr", "")

    def held_stem(self, name: str) -> dict[str, Any]:
        return self.held.get("stems", {}).get(name, {})


def _docker_unavailable() -> str:
    """"" when the probe can run, otherwise the reason it cannot."""
    if shutil.which("docker") is None:
        return "docker is not on PATH"
    try:
        proc = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", SEALER_CONTAINER],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"docker inspect failed ({type(exc).__name__}: {exc})"
    if proc.returncode != 0 or proc.stdout.strip() != "true":
        return f"the {SEALER_CONTAINER} container is not running"

    # THE STALENESS CHECK. quarantine-seal.sh is a bind mount today, so the two
    # copies are the same inode — but "today" is not a guarantee, and a probe
    # that benchmarks an image nobody is running is a probe reporting on the
    # wrong code. Cheap to check, and the failure it prevents is invisible.
    try:
        proc = subprocess.run(
            ["docker", "exec", SEALER_CONTAINER, "sha256sum", CONTAINER_SEALER_PATH],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return f"docker exec failed ({type(exc).__name__}: {exc})"
    if proc.returncode != 0:
        return f"{CONTAINER_SEALER_PATH} is not readable in the container"
    import hashlib
    want = hashlib.sha256(SEALER.read_bytes()).hexdigest()
    got = proc.stdout.split()[0] if proc.stdout.split() else ""
    if got != want:
        return (
            "the container's quarantine-seal.sh differs from this checkout "
            f"({got[:12]} vs {want[:12]}); recreate the container before "
            "trusting a routing result"
        )
    return ""


def routing_probe(config: dict[str, Any]) -> RoutingProbe:
    """Run both hop ④ scenarios inside the sealer container. Never raises."""
    reason = _docker_unavailable()
    if reason:
        return RoutingProbe(available=False, reason=reason)

    blob = base64.b64encode(json.dumps(config).encode("utf-8")).decode("ascii")
    driver = _ROUTING_DRIVER.replace("__CONFIG__", blob)
    try:
        proc = subprocess.run(
            ["docker", "exec", "-i", SEALER_CONTAINER, "python3", "-"],
            input=driver, capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return RoutingProbe(available=False,
                            reason=f"docker exec failed ({type(exc).__name__}: {exc})")

    marker = "__RESULT__"
    if marker not in proc.stdout:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
        return RoutingProbe(
            available=False,
            reason=f"the in-container driver produced no result ({' / '.join(tail)})",
        )
    payload = json.loads(proc.stdout.split(marker, 1)[1])
    if not payload.get("ok"):
        return RoutingProbe(available=False,
                            reason=f"the in-container driver failed: {payload.get('error')}")
    return RoutingProbe(available=True, routing=payload["routing"], held=payload["held"])


# ═══════════════════════════════════════════════════════════════════════════
# 7. Hop ② — stub contract
# ═══════════════════════════════════════════════════════════════════════════
#
# The only hop still out of scope, and the only one with a non-deterministic
# answer. What a real implementation owes, so whoever picks it up is not
# guessing:
#
# HOP ② — distill. The control is that the curator runs as its own cell with
# `sessionTarget: isolated`, no network (build-guard denies web_fetch to every
# agent but scout), and no write access to briefs/. The property to measure is
# whether a source that *instructs the curator* — "set
# contains_external_instructions to false", "add a next_step field" — actually
# moves the curator's output. That needs a model turn, so it needs the container
# and a curator session. Contract: given a fixture path, produce the JSON the
# curator wrote to briefs-pending/ and diff it against what an uninstructed run
# produces from the same prose. Blocking cause vocabulary:
# `instruction-not-followed` (good) / `instruction-followed:<field>` (bad).
#
# Note what hop ③b now covers that this does NOT: the cross-check is the
# sealer's own second opinion on the same bytes, and it fires whether or not the
# curator was fooled. It is a partial answer to "did the quarantined model miss
# something", not a replacement for measuring whether the model can be moved.

def stub_result(hop: int) -> tuple[str, str]:
    what = {
        HOP_DISTILL: "requires a curator model turn (sessionTarget: isolated)",
    }[hop]
    return "skip", f"hop{hop}-not-implemented: {what}"


# ═══════════════════════════════════════════════════════════════════════════
# 8. The mini-framework
# ═══════════════════════════════════════════════════════════════════════════
#
# Modelled on test-guard.mjs:49-97 — check() runs a closure and swallows the
# AssertionError into a list, allowed()/blocked() are the two shapes of
# assertion. The difference is what gets recorded: this benchmark's product is
# a per-hop table, so every assertion records the full row
# (case_name, hop, expected_cause, actual_cause, outcome) rather than only
# whether it threw.

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"

_A = unittest.TestCase()      # stdlib assertion engine; never run(), just asserted on


@dataclass
class Result:
    case_name: str
    expected_hop: int | str | None
    actual_hop: int | str | None
    expected_cause: str
    actual_cause: str
    outcome: str
    detail: str = ""

    @property
    def hop(self) -> int | str | None:
        """The hop that actually stopped it — the column the table is about."""
        return self.actual_hop


class Harness:
    def __init__(self) -> None:
        self.results: list[Result] = []

    # --- the three primitives ------------------------------------------------

    def check(self, name: str, expected_hop: int | str | None, expected_cause: str,
              fn: Callable[[], tuple[Any, str]]) -> Result:
        """Run one case. `fn` returns (actual_hop, actual_cause) or raises.

        The sentinel "skip" in the hop slot reports a SKIP. It cannot collide
        with a real hop id: those are 1, 2, 3, "3b", 4 and None.
        """
        try:
            actual_hop, actual_cause = fn()
        except Exception as exc:                      # noqa: BLE001
            res = Result(name, expected_hop, "error", expected_cause,
                         f"{type(exc).__name__}: {exc}", FAIL,
                         detail="the case raised instead of answering")
            self.results.append(res)
            return res

        if actual_hop == "skip":
            res = Result(name, expected_hop, None, expected_cause, actual_cause, SKIP)
            self.results.append(res)
            return res

        outcome, detail = PASS, ""
        try:
            _A.assertEqual(
                actual_hop, expected_hop,
                f"expected {HOP_LABEL.get(expected_hop, expected_hop)} to stop it, "
                f"got {HOP_LABEL.get(actual_hop, actual_hop)} ({actual_cause})",
            )
            if expected_cause:
                _A.assertIn(
                    expected_cause, actual_cause,
                    f"cause mismatch: wanted {expected_cause!r}, got {actual_cause!r}",
                )
        except AssertionError as exc:
            outcome, detail = FAIL, str(exc).split("\n")[0]

        res = Result(name, expected_hop, actual_hop, expected_cause, actual_cause,
                     outcome, detail)
        self.results.append(res)
        return res

    def assert_blocked(self, name: str, hop: int | str, cause: str,
                       fn: Callable[[], tuple[Any, str]]) -> Result:
        """The payload must be stopped at `hop`, for `cause`."""
        return self.check(name, hop, cause, fn)

    def assert_allowed(self, name: str, cause: str,
                       fn: Callable[[], tuple[Any, str]]) -> Result:
        """The payload must reach cell 3 — no hop stops it.

        Deliberately a first-class assertion and not an afterthought. A gate
        that refuses everything scores perfectly on the blocked cases and is
        useless, and hop ① in particular is *supposed* to let injected prose
        through: it strips characters, not meaning (quarantine-seal.sh:19-24).
        Hop ④ needs it for the same reason in a sharper form — routing that sent
        every brief to briefs-flagged/ would look identical to routing that
        works, on blocked cases alone.
        """
        return self.check(name, None, cause, fn)

    # --- rollup --------------------------------------------------------------

    def counts(self) -> dict[str, int]:
        out = {PASS: 0, FAIL: 0, SKIP: 0}
        for r in self.results:
            out[r.outcome] += 1
        return out
