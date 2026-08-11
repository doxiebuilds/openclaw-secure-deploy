#!/usr/bin/env bash
# launch-openclaw.sh — materialize secrets from the macOS Keychain, then start
# the stack. This is the ONLY supported way to bring OpenClaw up; a bare
# `docker compose up` leaves every SecretRef unresolved.
#
# ─── WHY A FILE AND NOT `environment:` ───────────────────────────────────────
# Values passed to the gateway via compose `environment:` are readable three
# ways: `docker inspect openclaw`, /proc/1/environ, and — the one that actually
# matters here — they are inherited by every process the agent spawns. This
# gateway may shell out to scripts/*.sh, so an
# env var is handed to code we did not write. A file at
# /run/secrets is read by the gateway at SecretRef-resolution time and by
# nothing else.
#
# ─── WHY NOT THE `exec` SECRET PROVIDER ──────────────────────────────────────
# OpenClaw's exec provider would shell out to a resolver — but it runs INSIDE
# the container, which has no `security` binary and no path to the host
# Keychain. `file` is the only transport that can carry a Keychain value in.
#
# ─── THE FILE MUST SURVIVE STARTUP. DO NOT DELETE IT AFTER `up -d`. ──────────
# OpenClaw's file provider passes no cache on the gateway's main resolution
# path, so it re-reads from disk every time a SecretRef is resolved — on config
# reload, on channel restart, and on every `docker exec openclaw openclaw ...`
# invocation. Rotate this file; never remove it while the container runs.
#
# ─── WHY PERPLEXITY IS HANDLED DIFFERENTLY ───────────────────────────────────
# PERPLEXITY_API_KEY is exported into this script's environment and reaches the
# perplexity-mcp container through compose interpolation — it is never written
# to disk at all. That container has no agent, no exec, no volumes and spawns
# no children, so the env-var risks above do not apply to it. Critically, the
# key is NOT placed in the gateway's secrets file: the whole point of running a
# separate search container is that the agent's own container never holds the
# credential, so no read tool and no prompt injection can reach it.
#
# ─── ON "SECURELY WIPING" THE TEMP FILE ──────────────────────────────────────
# We `rm -f` it and stop there. Overwriting it first would be theatre: APFS is
# copy-on-write and the SSD does wear levelling, so rewriting a file's logical
# blocks does not touch the physical NAND cells holding the old data. This is
# why macOS removed `srm` and documents `rm -P` as ineffective on SSDs.
# FileVault is the real at-rest control — check it with `fdesetup status`.

set -euo pipefail
umask 077

# xtrace would echo every secret to stderr. Refuse rather than leak.
case $- in
  *x*) printf 'launch-openclaw: refusing to run with xtrace enabled.\n' >&2; exit 1 ;;
esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_DIR="${OPENCLAW_SECRETS_DIR:-$HOME/.openclaw-secrets}"
SECRETS_FILE="$SECRETS_DIR/openclaw-secrets.json"
KC_ACCOUNT="${OPENCLAW_KEYCHAIN_ACCOUNT:-$USER}"

die() { printf 'launch-openclaw: %s\n' "$*" >&2; exit 1; }

# Declared BEFORE the trap: with `set -u`, a handler referencing an unbound
# variable would itself fail during an early abort.
tmp=""
# Idempotent, and the trap is never cleared. After a successful `mv -f` the
# temp file no longer exists, so this is a no-op — which is strictly safer than
# `trap - EXIT`, since that reopens a window if anything after the mv fails.
cleanup() { [ -n "${tmp:-}" ] && rm -f -- "$tmp"; return 0; }
# EXIT alone is not reliably run on SIGINT across shells; name the signals.
# Verified 2026-07-29: temp file present mid-run, removed after both SIGTERM and
# SIGINT, and removed when jq exits non-zero.
#
# Two limits, both inherent to shell and neither worth working around:
#   • SIGKILL cannot be trapped, so `kill -9` mid-run leaves the temp file.
#   • bash defers trap handling until the running foreground command returns, so
#     if a signal arrives while jq is blocked, cleanup happens when jq exits.
# In both cases the leftover is mode 0600 inside a 0700 directory, so it is not
# readable by anyone else; `rm -f ~/.openclaw-secrets/.openclaw-secrets.*` if it
# ever bothers you.
trap cleanup EXIT INT TERM HUP

# Reads one Keychain item to stdout. Exit codes are mapped to instructions
# rather than passed through, because `security`'s own messages do not say what
# to do about them.
read_keychain() {
  local svc="$1" out rc
  set +e
  out="$(/usr/bin/security find-generic-password -s "$svc" -a "$KC_ACCOUNT" -w 2>&1)"
  rc=$?
  set -e
  case "$rc" in
    0)
      [ -n "$out" ] || die "Keychain item '$svc' exists but is empty."
      printf '%s' "$out"
      ;;
    44)
      die "Keychain item not found: service='$svc' account='$KC_ACCOUNT'.
    Seed it with:
      security add-generic-password -U -a \"\$USER\" -s $svc -T /usr/bin/security -w"
      ;;
    51)
      die "Keychain is locked, or interaction is not allowed (service='$svc').
    Unlock it with:
      security unlock-keychain ~/Library/Keychains/login.keychain-db"
      ;;
    *)
      die "security(1) failed for '$svc' (exit $rc): $out"
      ;;
  esac
}

command -v jq     >/dev/null 2>&1 || die "jq is required to build the secrets file (brew install jq)."
command -v docker >/dev/null 2>&1 || die "docker is required."

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

GW="$(read_keychain openclaw-gateway-auth-token)"
SB="$(read_keychain openclaw-slack-bot-token)"
SA="$(read_keychain openclaw-slack-app-token)"

# ─── One secrets file per cell (2026-07-31) ──────────────────────────────────
# scout and curator get ONLY their own gateway token. Not the Slack tokens, not
# the Linear OAuth, not a frontier-model key. A cell cannot leak a credential it
# was never given, and that is a stronger statement than a read rule about a
# credential it holds.
#
# These are gateway auth tokens with no external meaning — they authenticate a
# caller to that cell's local API and nothing else — but they are minted and
# stored the same way as everything else so there is exactly one system of
# record for secrets on this machine.
SCOUT_GW="$(read_keychain openclaw-scout-auth-token)"
CURATOR_GW="$(read_keychain openclaw-curator-auth-token)"

# Perplexity is optional: the stack must still come up before you have minted
# the key. compose interpolates an empty string, perplexity-mcp fails its own
# healthcheck, and the gateway simply has no perplexity tools.
PPLX=""
if /usr/bin/security find-generic-password -s openclaw-perplexity-api-key \
     -a "$KC_ACCOUNT" -w >/dev/null 2>&1; then
  PPLX="$(read_keychain openclaw-perplexity-api-key)"
else
  printf 'launch-openclaw: note — no openclaw-perplexity-api-key in Keychain; starting without Perplexity search.\n' >&2
fi

# mktemp already creates 0600, and `umask 077` backs that up, so the file is
# never briefly group- or world-readable. Values go to jq through the
# ENVIRONMENT, never argv — argv is world-visible via `ps -ww`.
tmp="$(mktemp "$SECRETS_DIR/.openclaw-secrets.XXXXXX")"
OC_GW="$GW" OC_SB="$SB" OC_SA="$SA" jq -n '{
  gateway: { authToken: env.OC_GW },
  slack:   { botToken:  env.OC_SB, appToken: env.OC_SA }
}' > "$tmp"
unset GW SB SA

jq -e . "$tmp" >/dev/null 2>&1 || die "generated secrets file is not valid JSON."
chmod 600 "$tmp"
mv -f "$tmp" "$SECRETS_FILE"

# The two isolated cells. Same discipline — mktemp 0600, values through the
# environment rather than argv, atomic rename — but each file carries a single
# token and nothing else.
write_cell_secrets() {
  _name="$1"; _token="$2"
  _dest="$SECRETS_DIR/$_name-secrets.json"
  tmp="$(mktemp "$SECRETS_DIR/.$_name-secrets.XXXXXX")"
  OC_CELL_GW="$_token" jq -n '{ gateway: { authToken: env.OC_CELL_GW } }' > "$tmp"
  jq -e . "$tmp" >/dev/null 2>&1 || die "generated $_name secrets file is not valid JSON."
  chmod 600 "$tmp"
  mv -f "$tmp" "$_dest"
  _mode="$(stat -f '%Lp' "$_dest")"
  [ "$_mode" = "600" ] || die "$_dest has mode $_mode; must be 600."
}
write_cell_secrets scout   "$SCOUT_GW"
write_cell_secrets curator "$CURATOR_GW"
unset SCOUT_GW CURATOR_GW

# OpenClaw's file provider REFUSES a secrets file with any group/world bit, or
# one not owned by the reading uid (assertSecurePermissions, @openclaw/fs-safe).
# Fail here, where the message is actionable, rather than at gateway startup.
mode="$(stat -f '%Lp' "$SECRETS_FILE")"
[ "$mode" = "600" ] || die "$SECRETS_FILE has mode $mode; must be 600."

# ─── The exchange must exist before `up` ─────────────────────────────────────
# These are bind mounts. If a source directory is missing, Docker CREATES it as
# root-owned, and the container (uid 1000) then cannot write it — which shows up
# much later as a confusing permission error inside an agent turn rather than
# here. Create them with the right owner while we are still the human.
# briefs-pending is curator's write target and the sealer's input: curator no
# longer mounts briefs/ at all, so if this directory is the one Docker creates
# root-owned, curator cannot write a single brief and the pipeline stops dead at
# the last hop — with the confusing symptom that everything upstream looks fine.
#
# ledger/ is the sealer's own — its processing record and per-file retry
# counter, mounted by no cell. It is in this list for the same root-owned-bind
# reason as the rest, but it is worth stating separately BECAUSE ITS FAILURE IS
# QUIET. Every other directory here stops the pipeline when the sealer cannot
# write it, and you find out. A root-owned ledger/ does not: briefs still flow,
# `docker ps` stays green, the heartbeat keeps ticking — the sealer simply loses
# its retry accounting, so the failure count never persists, no file ever
# reaches the cap, and every failing input is retried forever. That infinite
# loop is the exact thing the ledger exists to prevent, so a ledger Docker
# created is worse than useless: it removes a safety property while looking like
# it is there. Create it here, owned by us, while we are still the human.
EXCHANGE="$REPO_DIR/../openclaw-enclave/exchange"
for d in raw normalized briefs briefs-pending reviews requests inbox ledger; do
  mkdir -p "$EXCHANGE/$d"
  chmod 700 "$EXCHANGE/$d"
done
for d in workspace-scout workspace-curator; do
  mkdir -p "$REPO_DIR/../openclaw-enclave/$d"
done

# Optional projects worktrees dir (unused in the three-cell public cut unless you re-add coding tooling).
# same reason. HOST_PROJECTS_ROOT comes from .env; read it without sourcing the
# file, so a stray command in .env cannot execute here.
_projects_root="$(sed -n 's/^HOST_PROJECTS_ROOT=//p' "$REPO_DIR/.env" | head -1)"
case "$_projects_root" in
  "~/"*) _projects_root="$HOME/${_projects_root#\~/}" ;;
esac
if [ -n "$_projects_root" ] && [ -d "$_projects_root" ]; then
  mkdir -p "$_projects_root/.worktrees"
else
  printf 'launch-openclaw: note — could not resolve HOST_PROJECTS_ROOT; create .worktrees under HOST_PROJECTS_ROOT if your workflow needs it.\n' >&2
fi

# Consumed by docker-compose.yml interpolation for the perplexity-mcp service
# ONLY. Never added to the gateway service's environment.
export PERPLEXITY_API_KEY="$PPLX"
unset PPLX

cd "$REPO_DIR"

# ─── --no-cell3-proxy: put cell 3 back on the NAT'd bridge ───────────────────
# Handled here rather than by the caller because `-f` must precede the `up`
# subcommand, so it cannot be passed through "$@". Everything after the flag is
# forwarded to compose unchanged (--build, --force-recreate, service names).
#
# The egress proxy is ON BY DEFAULT since 2026-08-01, when the spike passed
# (Slack socket mode and the Linear MCP endpoint both traverse it; evidence in
# SECURITY.md, "Network"). It is the default rather than an opt-in flag
# because the failure mode of forgetting a flag is silent loss of the control,
# whereas the failure mode of the proxy itself is loud — net_main is
# `internal: true`, so a blocked host means "Slack never connects", never a
# quiet bypass.
#
# This flag is the escape hatch for when an upgrade moves a hostname off the
# allowlist. It WEAKENS the stack: cell 3 regains a default route and full
# internet. Prefer reading `docker logs main-egress-proxy | grep DENY` and
# adding the host to EGRESS_ALLOW.
COMPOSE_FILES=(-f docker-compose.yml)
if [ "${1:-}" = "--no-cell3-proxy" ]; then
  COMPOSE_FILES+=(-f docker-compose.cell3-bridge.yml)
  shift
  printf 'launch-openclaw: WARNING — cell 3 egress proxy DISABLED. This container\n' >&2
  printf 'launch-openclaw: regains a default route and unrestricted internet access.\n' >&2
  printf 'launch-openclaw: Re-enable by launching without --no-cell3-proxy.\n' >&2
fi

exec docker compose "${COMPOSE_FILES[@]}" up -d "$@"
