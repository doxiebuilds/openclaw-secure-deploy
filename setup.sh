#!/usr/bin/env bash
# OpenClaw multi-cell enclave setup.
# Creates directories, materializes example configs, and prepares .env.
# Does not start Docker and never writes real secrets.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "Starting OpenClaw enclave setup..."
echo "--------------------------------------"

# 1. Enclave directories (workspaces, exchange airlock, projects mount point)
echo "Checking and creating enclave directories..."
mkdir -p \
  openclaw-enclave/workspace \
  openclaw-enclave/workspace-scout/.inbox-state \
  openclaw-enclave/workspace-curator \
  openclaw-enclave/openclaw-projects-folder/coding-projects \
  openclaw-enclave/openclaw-secure-config \
  openclaw-enclave/openclaw-secure-config-scout \
  openclaw-enclave/openclaw-secure-config-curator \
  openclaw-enclave/exchange/{raw,normalized,briefs,briefs-pending,briefs-flagged,requests,inbox,inbox/archive,reviews,ledger} \
  openclaw-enclave/backups

# Exchange + workspaces must be writable by the container user (node, uid 1000).
if command -v chmod >/dev/null 2>&1; then
  chmod -R u+rwX,go+rX openclaw-enclave/exchange openclaw-enclave/workspace \
    openclaw-enclave/workspace-scout openclaw-enclave/workspace-curator 2>/dev/null || true
fi
echo "[OK] Enclave directories are ready."

# 2. Path-only .env (never secrets)
echo "Checking openclaw-docker-config/.env..."
if [ ! -f "openclaw-docker-config/.env" ]; then
  if [ -f "openclaw-docker-config/.env.example" ]; then
    cp openclaw-docker-config/.env.example openclaw-docker-config/.env
    echo "[OK] .env created from .env.example (edit paths before first run)."
  else
    echo "[WARNING] openclaw-docker-config/.env.example missing."
  fi
else
  echo "[OK] .env already exists."
fi

# 3. Cell configs: example → runtime openclaw.json (gitignored)
materialize_config() {
  local dir="$1"
  local example="$dir/openclaw.example.json"
  local runtime="$dir/openclaw.json"
  if [ ! -f "$runtime" ]; then
    if [ -f "$example" ]; then
      cp "$example" "$runtime"
      echo "[OK] $runtime created from example."
    else
      echo "[WARNING] missing $example"
    fi
  else
    echo "[OK] $runtime already exists."
  fi
}

echo "Checking cell openclaw.json configs..."
materialize_config "openclaw-enclave/openclaw-secure-config"
materialize_config "openclaw-enclave/openclaw-secure-config-scout"
materialize_config "openclaw-enclave/openclaw-secure-config-curator"

# 4. Host secrets directory (outside repo) — empty scaffold only
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw-secrets}"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR" 2>/dev/null || true
echo "[OK] Secrets directory: $SECRETS_DIR"
echo "     Populate openclaw-secrets.json, scout-secrets.json, curator-secrets.json"
echo "     (or run openclaw-docker-config/launch-openclaw.sh on macOS to load Keychain)."

echo "--------------------------------------"
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Edit openclaw-docker-config/.env  (HOST_PROJECTS_ROOT, …)"
echo "  2. Edit each cell's openclaw.json  (Slack channel IDs if you use Slack)"
echo "  3. Place secrets under $SECRETS_DIR  (see .env.example comments)"
echo "  4. Start the stack:"
echo ""
echo "       cd openclaw-docker-config"
echo "       ./launch-openclaw.sh          # macOS Keychain path"
echo "       # or: docker compose up -d --build"
echo ""
echo "  5. Optional control plane:"
echo "       cd control-plane && npm install && npm run dev:api & npm run dev:web"
echo ""
echo "  6. Static security check (no Docker):"
echo "       python3 tools/enclave-check/check.py -v"
echo ""
