#!/bin/sh
# Integrity drift check — deterministic, no model involved.
#
# WHAT THIS PROTECTS (updated 2026-07-28)
# The authority moved. exec-approvals.json used to decide what the agent may
# run; it no longer does — build-guard/index.mjs does, and this check's most
# important job is now pinning that guard's sha256 and the config that loads
# it. A silently edited or unloaded guard looks identical to a working one from
# the outside, so both the guard hash and plugins.load.paths / plugins.allow
# are fingerprinted here.
#
# exec-approvals.json is still fingerprinted too, but only as a mirror: it is
# agent-writable (via the `write`/`edit` tools, which never touch the exec
# gate), and it now lists only the read-only wrapper scripts. If the agent adds
# a binary back to it, build-guard still refuses to run that binary — but the
# addition shows up here as drift, which is a useful tamper signal even though
# it grants nothing.
#
# This is NOT a containment control. The container is the sandbox. What this
# restores is the property that actually goes missing: knowing whether the
# fence you configured — above all, the guard — is still the fence in effect.
#
# It reports but never repairs. A check that fixes the artifact it audits can
# mask a real compromise, and auto-restoring socket.token (an HMAC secret)
# should require a human. Absence is therefore escalated, not healed.
#
# WHAT IS COMPARED
# A canonical fingerprint, not the raw file. The gateway rewrites
# `lastUsedAt` and `lastUsedCommand` constantly, so comparing bytes would
# fire every few minutes and train you to ignore it. Only the parts that
# grant authority are fingerprinted:
#   - defaults.security / defaults.ask
#   - every agent's security / ask
#   - every agent's allowlist patterns, sorted
# `security: full` would be a far bigger change than any added binary, so
# the modes are checked alongside the patterns rather than assumed.
#
# UPDATING THE BASELINE
# The baseline lives on the read-only templates mount, so it cannot be
# rewritten from inside the container — updating it is a host-side edit,
# which is the point. When you deliberately grant a binary, run this from the
# repo root on the host, then re-run the check:
#   docker exec openclaw sh /home/node/scripts/check-approvals.sh --print \
#     > openclaw-enclave/templates/exec-allowlist.baseline
# The fingerprint must be taken INSIDE the container: run directly on the host
# it would resolve host paths and produce a baseline that never matches.
# `--print` refuses to emit when an input is unreadable, so a broken state
# cannot be captured as the new expected state.
# Canonical procedure and recovery runbook: README.md (Quick start),
# SECURITY.md (Updates).

set -u
export TZ="America/New_York"

APPROVALS="${APPROVALS:-/home/node/.openclaw/exec-approvals.json}"
BASELINE="${BASELINE:-/home/node/templates/exec-allowlist.baseline}"
STATE_DIR="${STATE_DIR:-/home/node/.openclaw/workspace/memory}"
REPORT="${REPORT:-$STATE_DIR/APPROVALS-STATUS.md}"

# The guard plugin is now part of the enforcement surface: it is what blocks
# exec during scheduled runs. Both it and the config key naming it sit on
# read-only mounts, so neither should ever change without a host-side edit —
# which makes them exactly the kind of thing worth fingerprinting.
OPENCLAW_JSON="${OPENCLAW_JSON:-/home/node/.openclaw/openclaw.json}"
GUARD="${GUARD:-/home/node/plugins/build-guard/index.mjs}"

fingerprint() {
  python3 - "$APPROVALS" "$OPENCLAW_JSON" "$GUARD" <<'PY'
import hashlib, json, sys

lines = []

# exec-approvals.json is a MIRROR, not the authority. An unreadable file is
# reported as one line among the others and must never short-circuit the rest:
# an early exit here used to skip the plugins and guard sections below — the
# assertions that actually matter — so a missing mirror silently disabled the
# whole check while still looking like a loud alert. (2026-07-29 incident.)
try:
    with open(sys.argv[1]) as fh:
        doc = json.load(fh)
except Exception as exc:                      # missing or corrupt is itself drift
    lines.append("approvals ERROR unreadable: %s" % exc)
else:
    defaults = doc.get("defaults") or {}
    lines.append("defaults security=%s ask=%s"
                 % (defaults.get("security"), defaults.get("ask")))

    for name, agent in sorted((doc.get("agents") or {}).items()):
        lines.append("agent:%s security=%s ask=%s"
                     % (name, agent.get("security"), agent.get("ask")))
        for entry in sorted(agent.get("allowlist") or [],
                            key=lambda e: e.get("pattern") or ""):
            lines.append("agent:%s pattern=%s" % (name, entry.get("pattern")))

# Guard plugin: the code that enforces "no exec in scheduled runs", plus the
# config entry that loads it. A silently disabled guard looks identical to a
# working one from the outside, so both are pinned.
try:
    with open(sys.argv[2]) as fh:
        cfg = json.load(fh)
    plugins = cfg.get("plugins") or {}
    load_paths = ((plugins.get("load") or {}).get("paths")) or []
    lines.append("plugins.load.paths=%s" % ",".join(sorted(map(str, load_paths))))
    lines.append("plugins.allow=%s" % ",".join(sorted(map(str, plugins.get("allow") or []))))

    # Per-agent tool policy (added 2026-07-31).
    #
    # WHY THIS IS PINNED. Splitting one agent into five put a real security
    # control into openclaw.json: each agent now carries an ABSOLUTE
    # tools.allow, and dropping a name from it (or adding one) silently changes
    # what that identity can do. The guard sha256 below covers build-guard's
    # path rules, but nothing covered this — so a policy that matters could
    # have changed and this check would still have reported all-clear.
    #
    # tools.allow is an absolute allowlist that REPLACES the profile default,
    # which is exactly why it must be pinned: the "coding" profile contains
    # code_execution and cron, so an allow list that quietly grows by one entry
    # can hand an agent an execution primitive that never touches the exec gate.
    agents_cfg = cfg.get("agents") or {}
    for agent in sorted(agents_cfg.get("list") or [],
                        key=lambda a: str(a.get("id"))):
        aid = agent.get("id")
        tools = agent.get("tools") or {}
        fs = tools.get("fs") or {}
        lines.append("agent-tools:%s profile=%s allow=%s deny=%s workspaceOnly=%s" % (
            aid,
            tools.get("profile"),
            ",".join(sorted(map(str, tools.get("allow") or []))),
            ",".join(sorted(map(str, tools.get("deny") or []))),
            fs.get("workspaceOnly"),
        ))
        lines.append("agent-model:%s %s" % (aid, agent.get("model")))
    # The global fallbacks the per-agent lists sit on top of.
    gtools = cfg.get("tools") or {}
    lines.append("tools.profile=%s" % gtools.get("profile"))
    lines.append("tools.web.search.enabled=%s" % (
        ((gtools.get("web") or {}).get("search") or {}).get("enabled")))
    lines.append("mcp.servers=%s" % ",".join(
        sorted(((cfg.get("mcp") or {}).get("servers") or {}).keys())))
except Exception as exc:
    lines.append("plugins ERROR unreadable: %s" % exc)

try:
    with open(sys.argv[3], "rb") as fh:
        lines.append("guard sha256=%s" % hashlib.sha256(fh.read()).hexdigest())
except Exception as exc:
    lines.append("guard ERROR unreadable: %s" % exc)

print("\n".join(lines))
PY
}

# `--print` emits the current fingerprint so a new baseline can be captured.
#
# It refuses to print when any input is unreadable. On 2026-07-29 the reflex
# response to the drift alert would have been "just regenerate the baseline",
# which would have permanently enshrined a destroyed exec-approvals.json as
# the expected state. A baseline may only be captured from a healthy read.
if [ "${1:-}" = "--print" ]; then
  out="$(fingerprint)"
  case "$out" in
    *"ERROR unreadable"*)
      echo "approvals: refusing to emit a baseline — an input is unreadable:" >&2
      printf '%s\n' "$out" >&2
      echo "approvals: fix the input first, then re-run." >&2
      echo "approvals: recovery runbook in README.md (Quick start)" >&2
      exit 1 ;;
  esac
  printf '%s\n' "$out"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  echo "approvals: FAIL — no baseline at $BASELINE" >&2
  echo "approvals: capture one from the host with:" >&2
  echo "  docker exec openclaw sh /home/node/scripts/check-approvals.sh --print \\" >&2
  echo "    > openclaw-enclave/templates/exec-allowlist.baseline" >&2
  exit 1
fi

CURRENT="$(fingerprint)"
EXPECTED="$(cat "$BASELINE")"
NOW="$(date -u +%FT%TZ)"

mkdir -p "$STATE_DIR"

if [ "$CURRENT" = "$EXPECTED" ]; then
  {
    echo "# Exec approvals — OK"
    echo ""
    echo "checked: $NOW"
    echo "The exec allowlist matches its baseline."
    echo ""
    echo '```'
    echo "$CURRENT"
    echo '```'
  } > "$REPORT"
  echo "approvals: OK — matches baseline" >&2
  exit 0
fi

# Drift. Report it, and fail the job so the cron failure path surfaces it.
#
# Two severities, because they mean different things. CONTENT drift means
# "someone changed the fence". An unreadable input means "the fence is not
# being checked at all" — strictly worse, and the case that reads most like a
# false alarm because the missing sections render as bare `-` lines.
case "$CURRENT" in
  *"ERROR unreadable"*) SEVERITY="CRITICAL" ;;
  *)                    SEVERITY="DRIFT" ;;
esac

{
  if [ "$SEVERITY" = "CRITICAL" ]; then
    echo "# Exec approvals — CRITICAL: an integrity input is missing or unreadable"
    echo ""
    echo "checked: $NOW"
    echo ""
    echo "One of the inputs to the integrity fingerprint could not be read, so"
    echo "the checks it gates were NOT performed. This is not the same as a"
    echo "content change: the fence may be intact, but this run cannot say so."
    echo ""
    echo "A renamed file is the most common cause — OpenClaw's state migration"
    echo "renames exec-approvals.json to <name>.migrated when OPENCLAW_STATE_DIR"
    echo "is set. Check for siblings before assuming deletion or tampering."
  else
    echo "# Exec approvals — DRIFT DETECTED"
    echo ""
    echo "checked: $NOW"
    echo ""
    echo "The integrity fingerprint no longer matches the baseline in the"
    echo "read-only templates mount. Either someone changed the exec allowlist,"
    echo "the guard, or plugins.load.paths deliberately and did not update the"
    echo "baseline, or something changed them that should not have."
  fi
  echo ""
  echo "## Expected (baseline)"
  echo '```'
  echo "$EXPECTED"
  echo '```'
  echo ""
  echo "## Actual (now)"
  echo '```'
  echo "$CURRENT"
  echo '```'

  if [ "$SEVERITY" = "CRITICAL" ]; then
    echo ""
    echo "## Recovery"
    echo ""
    echo "Files present alongside the expected approvals path:"
    echo '```'
    ls -l "$APPROVALS"* 2>&1 || true
    echo '```'
    echo ""
    echo "If a \`.migrated\` sibling is listed above, the file was renamed, not"
    echo "lost. Restore it from the HOST (never inside the container), where"
    echo "\$CONFIG_DIR is the host directory mounted at /home/node/.openclaw:"
    echo ""
    echo '```bash'
    echo "cd \$CONFIG_DIR"
    echo "cp -p exec-approvals.json.migrated .exec-approvals.restore.tmp"
    echo "mv .exec-approvals.restore.tmp exec-approvals.json   # rename is atomic"
    echo '```'
    echo ""
    echo "If no sibling exists, restore the newest snapshot from"
    echo "openclaw-enclave/backups/ instead. Do NOT regenerate the baseline to"
    echo "make this alert go away — that enshrines the loss."
    echo ""
    echo "Full runbook: README.md (Quick start)"
  fi
} > "$REPORT"

echo "approvals: $SEVERITY — see $REPORT" >&2

# Echo the differing lines to stderr too, so they land in the cron run log
# and the failure alert rather than only in a report file nobody opens.
printf '%s\n' "$CURRENT"  > /tmp/approvals.current
printf '%s\n' "$EXPECTED" > /tmp/approvals.expected
python3 - <<'PY' >&2
cur = set(open("/tmp/approvals.current").read().splitlines())
exp = set(open("/tmp/approvals.expected").read().splitlines())
for line in sorted(cur - exp):
    print("  + %s" % line)
for line in sorted(exp - cur):
    print("  - %s" % line)
PY
rm -f /tmp/approvals.current /tmp/approvals.expected
exit 1
