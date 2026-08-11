#!/usr/bin/env bash
# Phase 10 smoke: API must already be running on CONTROL_PLANE_PORT (default 8787).
set -euo pipefail
PORT="${CONTROL_PLANE_PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"

echo "smoke: health"
curl -sf "$BASE/api/health" >/dev/null

echo "smoke: login"
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH="Authorization: Bearer $TOKEN"

echo "smoke: dashboard"
curl -sf -H "$AUTH" "$BASE/api/dashboard" >/dev/null

echo "smoke: approvals"
curl -sf -H "$AUTH" "$BASE/api/approvals" >/dev/null

echo "smoke: cron jobs"
curl -sf -H "$AUTH" "$BASE/api/cron/jobs" >/dev/null

echo "smoke: config main"
curl -sf -H "$AUTH" "$BASE/api/config/main" >/dev/null

echo "smoke: exchange"
curl -sf -H "$AUTH" "$BASE/api/exchange" >/dev/null

echo "smoke: security posture"
curl -sf -H "$AUTH" "$BASE/api/security/posture" >/dev/null

echo "smoke: audit"
curl -sf -H "$AUTH" "$BASE/api/audit?limit=5" >/dev/null

echo "smoke: OK"
