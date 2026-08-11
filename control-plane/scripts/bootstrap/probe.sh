#!/usr/bin/env bash
# Phase 0 fleet protocol probe.
#
# Proves OpenClaw Gateway reachability and RPC coverage for the three cells
# (main / scout / curator) using in-container `openclaw gateway call`.
#
# Requirements:
#   - Docker running
#   - Containers: openclaw, openclaw-scout, openclaw-curator (healthy)
#   - Host UI forwards on 127.0.0.1:18789 / 18829 / 18869
#
# Does NOT print gateway tokens. Writes a redacted JSON report to fixtures/.
#
# Usage (from repo root or any cwd):
#   sh control-plane/scripts/bootstrap/probe.sh
#   sh control-plane/scripts/bootstrap/probe.sh --quick

set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
FLEET_JSON="$SCRIPT_DIR/fleet.json"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"
REDACT_PY="$SCRIPT_DIR/lib/redact.py"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_JSON="$FIXTURES_DIR/probe-results-$STAMP.json"
OUT_LATEST="$FIXTURES_DIR/probe-results-latest.json"

QUICK=0
case "${1:-}" in
  --quick) QUICK=1 ;;
  -h|--help)
    sed -n '1,25p' "$0"
    exit 0
    ;;
esac

mkdir -p "$FIXTURES_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: docker not on PATH" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 not on PATH" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: curl not on PATH" >&2
  exit 2
fi
if [ ! -f "$FLEET_JSON" ]; then
  echo "FATAL: missing $FLEET_JSON" >&2
  exit 2
fi

log() { printf 'bootstrap-probe: %s\n' "$*" >&2; }

# Methods to probe via in-container gateway call.
# Keep params minimal; empty object for most.
METHODS_CORE='health status agents.list sessions.list config.get cron.list cron.status exec.approval.list exec.approvals.get system-presence tasks.list'
METHODS_EXTRA='config.schema config.schema.lookup config.patch config.apply chat.history cron.runs'

call_method() {
  local container="$1" method="$2" params="$3"
  # shellcheck disable=SC2086
  docker exec "$container" openclaw gateway call "$method" --json --timeout 20000 --params "$params" 2>&1
}

summarize_json() {
  python3 - "$1" <<'PY'
import json, sys
raw = open(sys.argv[1]).read()
try:
    d = json.loads(raw)
except Exception as e:
    print(json.dumps({"parse_ok": False, "error": str(e), "preview": raw[:200]}))
    raise SystemExit(0)
out = {"parse_ok": True, "type": type(d).__name__}
if isinstance(d, dict):
    out["keys"] = list(d.keys())[:20]
    for k in ("ok", "defaultId", "defaultAgentId", "count", "totalCount", "hash", "valid", "exists", "runtimeVersion", "enabled"):
        if k in d:
            out[k] = d[k]
    if "agents" in d and isinstance(d["agents"], list):
        out["agentIds"] = [a.get("id") for a in d["agents"] if isinstance(a, dict)]
        out["agentCount"] = len(d["agents"])
    if "jobs" in d and isinstance(d["jobs"], list):
        out["jobKeys"] = [
            j.get("declarationKey") or j.get("name") or j.get("id")
            for j in d["jobs"] if isinstance(j, dict)
        ]
        out["jobCount"] = len(d["jobs"])
    if "sessions" in d and isinstance(d["sessions"], list):
        out["sessionCount"] = len(d["sessions"])
    if "tasks" in d and isinstance(d["tasks"], list):
        out["taskCount"] = len(d["tasks"])
    elif "tasks" in d and isinstance(d["tasks"], dict):
        out["tasksKeys"] = list(d["tasks"].keys())[:12]
elif isinstance(d, list):
    out["length"] = len(d)
print(json.dumps(out))
PY
}

log "repo=$REPO_ROOT"
log "fleet=$FLEET_JSON"

REPORT_TMP=$(mktemp)
trap 'rm -f "$REPORT_TMP" ${TMPFILES:-}' EXIT
TMPFILES=""

python3 - "$FLEET_JSON" "$REPORT_TMP" <<'PY'
import json, sys, time
fleet = json.load(open(sys.argv[1]))
report = {
    "phase": 0,
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "openclawVersionExpected": fleet.get("openclawVersionObserved"),
    "protocolVersion": fleet.get("protocolVersion"),
    "gateways": {},
    "hostHealthz": {},
    "summary": {},
}
json.dump(report, open(sys.argv[2], "w"))
PY

# Materialize gateway lines (POSIX-friendly; no process substitution).
GW_LINES=$(mktemp)
TMPFILES="${TMPFILES:-} $GW_LINES"
python3 -c 'import json; [print(json.dumps(g)) for g in json.load(open("'"$FLEET_JSON"'"))["gateways"]]' >"$GW_LINES"

# Host healthz
while IFS= read -r line; do
  [ -n "$line" ] || continue
  id=$(printf '%s' "$line" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
  base=$(printf '%s' "$line" | python3 -c 'import sys,json; print(json.load(sys.stdin)["hostHttpBase"])')
  path=$(printf '%s' "$line" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("healthzPath","/healthz"))')
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${base}${path}" || echo fail)
  log "healthz $id -> $code"
  python3 - "$REPORT_TMP" "$id" "$code" <<'PY'
import json, sys
path, gid, code = sys.argv[1], sys.argv[2], sys.argv[3]
r = json.load(open(path))
r["hostHealthz"][gid] = {"httpStatus": code, "ok": code == "200"}
json.dump(r, open(path, "w"))
PY
done <"$GW_LINES"

# Per-gateway container probes
while IFS= read -r line; do
  [ -n "$line" ] || continue
  gid=$(printf '%s' "$line" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
  container=$(printf '%s' "$line" | python3 -c 'import sys,json; print(json.load(sys.stdin)["container"])')
  expected=$(printf '%s' "$line" | python3 -c 'import sys,json; print(",".join(json.load(sys.stdin).get("expectedAgents") or []))')

  log "probing gateway=$gid container=$container"
  if ! docker inspect "$container" >/dev/null 2>&1; then
    log "MISSING container $container"
    python3 - "$REPORT_TMP" "$gid" "$container" <<'PY'
import json, sys
path, gid, container = sys.argv[1], sys.argv[2], sys.argv[3]
r = json.load(open(path))
r["gateways"][gid] = {"container": container, "containerPresent": False, "methods": {}}
json.dump(r, open(path, "w"))
PY
    continue
  fi

  running=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)
  version=$(docker exec "$container" openclaw --version 2>/dev/null | head -1 | tr -d '\r' || echo unknown)

  python3 - "$REPORT_TMP" "$gid" "$container" "$running" "$version" "$expected" <<'PY'
import json, sys
path, gid, container, running, version, expected = sys.argv[1:7]
r = json.load(open(path))
r["gateways"][gid] = {
    "container": container,
    "containerPresent": True,
    "running": running == "true",
    "cliVersion": version,
    "expectedAgents": [x for x in expected.split(",") if x],
    "methods": {},
}
json.dump(r, open(path, "w"))
PY

  probe_one() {
    local method="$1" params="$2"
    local tmp
    tmp=$(mktemp)
    TMPFILES="${TMPFILES:-} $tmp"
    set +e
    call_method "$container" "$method" "$params" >"$tmp" 2>&1
    local rc=$?
    set -e
    local summary
    summary=$(summarize_json "$tmp" || true)
    python3 - "$REPORT_TMP" "$gid" "$method" "$rc" "$summary" <<'PY'
import json, sys
path, gid, method, rc, summary = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
r = json.load(open(path))
try:
    s = json.loads(summary)
except Exception:
    s = {"parse_ok": False, "error": "bad summary", "preview": summary[:200]}
entry = {
    "exitCode": rc,
    "ok": rc == 0 and s.get("parse_ok") is True,
    "summary": s,
}
# phase mapping hint
phase_for = {
    "health": "1",
    "status": "1-2",
    "agents.list": "2",
    "sessions.list": "2-3",
    "chat.history": "3",
    "config.get": "7",
    "config.schema": "7",
    "config.schema.lookup": "7",
    "config.patch": "7",
    "config.apply": "7",
    "cron.list": "6",
    "cron.status": "6",
    "cron.runs": "6",
    "exec.approval.list": "4",
    "exec.approvals.get": "4",
    "system-presence": "1",
    "tasks.list": "2-3",
}
entry["targetPhase"] = phase_for.get(method, "?")
r["gateways"][gid]["methods"][method] = entry
json.dump(r, open(path, "w"))
PY
    local okmark="FAIL"
    if [ "$rc" -eq 0 ]; then okmark="OK"; fi
    log "  $method -> $okmark (rc=$rc)"
  }

  for method in $METHODS_CORE; do
    probe_one "$method" '{}'
  done

  if [ "$QUICK" -eq 0 ]; then
    # config.schema (large) + schema.lookup
    probe_one "config.schema" '{}'
    probe_one "config.schema.lookup" '{"path":"gateway.port"}'
    # chat.history for first session if any
    sess_tmp=$(mktemp)
    TMPFILES="${TMPFILES:-} $sess_tmp"
    if call_method "$container" "sessions.list" '{}' >"$sess_tmp" 2>&1; then
      key=$(python3 -c 'import json;d=json.load(open("'"$sess_tmp"'"));ss=d.get("sessions")or[];print((ss[0].get("key") or ss[0].get("sessionKey") or "") if ss else "")' 2>/dev/null || true)
      if [ -n "${key:-}" ]; then
        # Escape for JSON string
        params=$(python3 -c 'import json,sys; print(json.dumps({"sessionKey":sys.argv[1],"limit":2}))' "$key")
        probe_one "chat.history" "$params"
      else
        log "  chat.history skipped (no sessions)"
      fi
    fi
    probe_one "cron.runs" '{}'
    # Do NOT call mutating config.patch/apply in Phase 0. Record CLI presence only.
    python3 - "$REPORT_TMP" "$gid" <<'PY'
import json, sys
path, gid = sys.argv[1], sys.argv[2]
r = json.load(open(path))
r["gateways"][gid]["methods"]["config.patch"] = {
    "exitCode": None,
    "ok": None,
    "skipped": True,
    "reason": "Mutating RPC not exercised in Phase 0 (RO bind mount; host-mediated apply planned).",
    "targetPhase": "7",
    "advertised": True,
}
r["gateways"][gid]["methods"]["config.apply"] = {
    "exitCode": None,
    "ok": None,
    "skipped": True,
    "reason": "Mutating RPC not exercised in Phase 0 (RO bind mount; host-mediated apply planned).",
    "targetPhase": "7",
    "advertised": True,
}
json.dump(r, open(path, "w"))
PY
  fi

  # Config mount RO check via docker inspect
  ro=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/home/node/.openclaw/openclaw.json"}}{{.Mode}}{{end}}{{end}}' 2>/dev/null || true)
  python3 - "$REPORT_TMP" "$gid" "$ro" <<'PY'
import json, sys
path, gid, ro = sys.argv[1], sys.argv[2], sys.argv[3]
r = json.load(open(path))
r["gateways"][gid]["openclawJsonMountMode"] = ro or "unknown"
r["gateways"][gid]["openclawJsonReadOnly"] = "ro" in (ro or "").split(",")
json.dump(r, open(path, "w"))
PY

done <"$GW_LINES"

# Summary
python3 - "$REPORT_TMP" "$OUT_JSON" "$OUT_LATEST" "$REDACT_PY" <<'PY'
import json, sys, importlib.util
from pathlib import Path

report_path, out_json, out_latest, redact_py = sys.argv[1:5]
r = json.load(open(report_path))

# load redact
spec = importlib.util.spec_from_file_location("redact", redact_py)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ok_methods = 0
fail_methods = 0
skipped = 0
for gid, g in r.get("gateways", {}).items():
    for m, entry in (g.get("methods") or {}).items():
        if entry.get("skipped"):
            skipped += 1
        elif entry.get("ok"):
            ok_methods += 1
        else:
            fail_methods += 1

health_ok = all(v.get("ok") for v in r.get("hostHealthz", {}).values()) if r.get("hostHealthz") else False
containers_ok = all(g.get("running") for g in r.get("gateways", {}).values()) if r.get("gateways") else False

r["summary"] = {
    "hostHealthzAllOk": health_ok,
    "containersAllRunning": containers_ok,
    "methodOk": ok_methods,
    "methodFail": fail_methods,
    "methodSkipped": skipped,
    "overallOk": health_ok and containers_ok and fail_methods == 0,
    "criticalFindings": [
        "Host raw WebSocket connect with gateway token alone does NOT grant operator scopes; device pairing/device identity is required for host CP clients (see PHASE0_PROTOCOL.md).",
        "Automations CLI is openclaw cron (not openclaw automations) on 2026.7.1.",
        "openclaw.json is bind-mounted read-only into containers; config apply must be host-mediated.",
        "Do not run control-plane connectors inside agent cells (no cross-cell host.docker.internal path assumed).",
    ],
}

redacted = mod.redact_obj(r)
Path(out_json).write_text(json.dumps(redacted, indent=2) + "\n")
Path(out_latest).write_text(json.dumps(redacted, indent=2) + "\n")
print(json.dumps(r["summary"], indent=2))
print(f"wrote {out_json}")
print(f"wrote {out_latest}")
sys.exit(0 if r["summary"]["overallOk"] else 1)
PY
