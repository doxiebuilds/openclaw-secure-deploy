#!/bin/sh
# register-curator-cron.sh — the curator's distill job, from a reviewable file.
#
# WHY THIS EXISTS. Until 2026-08-08 the brief schema the curator obeys lived in
# exactly one place: the `payload_message` column of a row in the gateway's cron
# store, `openclaw-secure-config-curator/state/openclaw.sqlite`. It was in no
# file, so it could not be reviewed, diffed, or grepped — and it had silently
# drifted out of sync with the validator that grades its output. The prompt
# forbade parentheses in `evidence_excerpt`; `EXCERPT_META_RE` in
# quarantine-seal.sh permits them. That is why every brief on disk has had its
# punctuation stripped, and why the "verbatim quote" contract the sealer's
# comments describe was fiction.
#
# The prompt now lives in curator-prompts/distill-normalized.txt. This script is
# the only sanctioned way to get it into the store.
#
# THIS RUNS ON THE HOST, AND THAT IS THE POINT. It reaches the gateway through
# `docker exec`, which is a host capability. The `cron` TOOL stays denied in
# openclaw-secure-config-curator/openclaw.json, so cell 2 still cannot enumerate
# or edit its own schedule — the invariant is "no agent edits its own alarm
# clock", and a host operator with a docker socket was never inside it.
#
# NEVER set OPENCLAW_STATE_DIR here or anywhere near this. It has destroyed live
# state in this repo before; .githooks/pre-commit lints for it in both = and :
# forms for that reason.
#
# Usage:
#   sh register-curator-cron.sh --check    compare live store to the file, change nothing
#   sh register-curator-cron.sh --apply    register or update the job from the file
#
# --check is the default. Exit 0 = in sync, 1 = drift, 2 = usage/environment error.

set -eu

CONTAINER="${CURATOR_CONTAINER:-openclaw-curator}"
DECLARATION_KEY="curator:distill-normalized"
JOB_NAME="distill-normalized"
AGENT_ID="curator"
EVERY="15m"
SESSION_TARGET="isolated"
WAKE_MODE="now"
DESCRIPTION="Distill exchange/normalized into schema-valid briefs. No-op when nothing pending."

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENCLAVE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PROMPT_FILE="$ENCLAVE_ROOT/curator-prompts/distill-normalized.txt"
STATE_DB="$ENCLAVE_ROOT/openclaw-secure-config-curator/state/openclaw.sqlite"

MODE="check"
case "${1:---check}" in
  --check) MODE="check" ;;
  --apply) MODE="apply" ;;
  -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
  *) echo "usage: $0 [--check|--apply]" >&2; exit 2 ;;
esac

[ -f "$PROMPT_FILE" ] || { echo "FATAL: no prompt file at $PROMPT_FILE" >&2; exit 2; }
[ -f "$STATE_DB" ]    || { echo "FATAL: no cron store at $STATE_DB" >&2; exit 2; }
command -v docker   >/dev/null 2>&1 || { echo "FATAL: docker not on PATH" >&2; exit 2; }
command -v sqlite3  >/dev/null 2>&1 || { echo "FATAL: sqlite3 not on PATH" >&2; exit 2; }

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || {
  echo "FATAL: container '$CONTAINER' is not running" >&2; exit 2; }

# The file carries a trailing newline because POSIX text files do; the stored
# payload does not. Strip exactly that, so --check compares like with like and
# --apply does not register a message that differs from the file by one byte.
MESSAGE=$(cat "$PROMPT_FILE")

# ── compare ────────────────────────────────────────────────────────────────
# Read-only against the live database. The gateway holds this file open with
# WAL, so -readonly is both correct and the only safe way to look.
live_message() {
  sqlite3 -readonly "$STATE_DB" \
    "select payload_message from cron_jobs where declaration_key='$DECLARATION_KEY';" 2>/dev/null
}

LIVE=$(live_message || true)

if [ -z "$LIVE" ]; then
  echo "DRIFT: no job with declaration_key '$DECLARATION_KEY' in the store"
  [ "$MODE" = "check" ] && exit 1
else
  # Both sides through the same command substitution, which strips trailing
  # newlines from each — so this compares the payloads, not their line endings.
  if [ "$LIVE" = "$MESSAGE" ]; then
    echo "OK: live payload matches $PROMPT_FILE"
    [ "$MODE" = "check" ] && exit 0
  else
    echo "DRIFT: live payload differs from $PROMPT_FILE"
    if command -v diff >/dev/null 2>&1; then
      printf '%s\n' "$LIVE"    > /tmp/.curator-cron-live.$$
      printf '%s\n' "$MESSAGE" > /tmp/.curator-cron-file.$$
      diff -u /tmp/.curator-cron-live.$$ /tmp/.curator-cron-file.$$ \
        --label "live (cron store)" --label "file ($PROMPT_FILE)" || true
      rm -f /tmp/.curator-cron-live.$$ /tmp/.curator-cron-file.$$
    fi
    [ "$MODE" = "check" ] && exit 1
  fi
fi

# ── apply ──────────────────────────────────────────────────────────────────
# `--declaration-key` is the idempotent identity: adding twice with the same key
# updates the existing row rather than creating a second job. That is what makes
# this script safe to re-run, and it is why the key is hard-coded above rather
# than derived from the filename.
echo "applying: $DECLARATION_KEY -> $CONTAINER"
# --no-deliver IS LOAD-BEARING, NOT TIDINESS. Without it the CLI stores
# delivery.mode="announce", and the job then tries to fallback-deliver its final
# text to a chat. Cell 2 has no channels of any kind — curator-ui-forward is its
# entire inbound surface and it is inbound only — so an announce mode is at best
# a no-op and at worst an error path on every one of the 96 runs a day. The
# original hand-registered job carried mode="none"; omitting this flag silently
# changed it on the first --apply, which is how it was found.
docker exec -i "$CONTAINER" openclaw cron add \
  --name "$JOB_NAME" \
  --agent "$AGENT_ID" \
  --every "$EVERY" \
  --session "$SESSION_TARGET" \
  --wake "$WAKE_MODE" \
  --no-deliver \
  --declaration-key "$DECLARATION_KEY" \
  --description "$DESCRIPTION" \
  --message "$MESSAGE"

# ── verify ─────────────────────────────────────────────────────────────────
# Re-read from the store rather than trusting the CLI's exit code. The failure
# this guards against is a silent no-op: a job that reports success and leaves
# the old payload in place looks identical to one that worked.
AFTER=$(live_message || true)
if [ "$AFTER" = "$MESSAGE" ]; then
  echo "VERIFIED: store now matches $PROMPT_FILE"
else
  echo "FAILED: store still does not match the file after apply" >&2
  exit 1
fi

# One row, not two. If --declaration-key ever stops being idempotent this is
# where it shows up, and a duplicate job means the curator wakes twice as often.
COUNT=$(sqlite3 -readonly "$STATE_DB" \
  "select count(*) from cron_jobs where declaration_key='$DECLARATION_KEY';")
if [ "$COUNT" != "1" ]; then
  echo "FAILED: expected exactly 1 job for '$DECLARATION_KEY', found $COUNT" >&2
  exit 1
fi
echo "VERIFIED: exactly one job registered"
