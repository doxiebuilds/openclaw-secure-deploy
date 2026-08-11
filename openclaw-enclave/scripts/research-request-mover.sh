#!/bin/sh
# research-request-mover.sh — the return channel, human-gated.
#
# WHY A HUMAN IS IN THIS PATH
# A one-way read is not a boundary if there is a path back. The two directions
# carry different dangers:
#
#   scout -> main    carries INSTRUCTIONS  (injection / sabotage)
#   main  -> scout   carries DATA          (exfiltration)
#
# The second reopens the trifecta across the cell boundary: `main` holds the
# repo and the credentials, `scout` holds the egress, and a request queue is the
# wire between them.
#
# BANDWIDTH LIMITS DO NOT CLOSE IT. A capped, schema-validated 200-character
# query still fits an API key. Anything that lets `main` write attacker-chosen
# bytes into something `scout` reads is an exfiltration channel regardless of
# how narrow the pipe is. Only a fixed vocabulary (useless for research) or a
# human in the path actually closes a covert channel — so the schema check
# below is hygiene, and YOUR approval is the control.
#
# Modes:
#   list                 show pending requests and the state of the inbox (default)
#   approve <id>         validate, then copy into scout's inbox
#   reject  <id>         discard
#   archive [<id>]       move answered requests out of the inbox
#
# Neither agent can run this: `main` cannot exec it (build-guard permits only
# the three agent-facing wrappers, and this is not one), and `scout` has no exec
# at all. It is a host-side operator tool.
#
# WHY `archive` IS HERE AND NOT IN THE SEALER. Nothing downstream of your
# approval can write `inbox/` — scout mounts it :ro, the sealer mounts it :ro,
# and that is the boundary this whole file exists to hold. So the queue had no
# way to shrink: from 2026-08-02 to 2026-08-05 an answered request simply stayed,
# and `inbox/` grew without bound.
#
# That was nearly harmless, because the sealer's ledger records which requests
# are `done` and phase ③ only ever dispatches ones in state `queued`. Nearly:
# the ledger loader is deliberately fail-open — an unreadable ledger is logged
# and the run continues with an empty one, on the principle that its failure mode
# should be "does too much work" rather than "drops the gate". For briefs that
# costs a re-distill. For the inbox it costs a REAL FETCH per stale request, one
# per 300s pass, because every file still sitting there looks queued again.
# Verified 2026-08-05: a request whose answer was already in normalized/ was
# re-dispatched from a fresh ledger.
#
# So the retained file, the fail-open ledger and the one-fetch budget compose
# into something worse than any of them alone, and the fix is to stop retaining.
# It is a human verb rather than an automatic sweep for the same reason approve
# is: it deletes from the one directory whose contents mean "a human said yes".

set -eu

ENCLAVE="${ENCLAVE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
EXCHANGE="${EXCHANGE_ROOT:-$ENCLAVE/exchange}"
REQUESTS="$EXCHANGE/requests"
INBOX="$EXCHANGE/inbox"
# Written by quarantine-seal.sh phase ③ and by nothing else. This script only
# ever READS it: a producer that could edit its own dispatch record could mark a
# request undispatched and have it fetched again, which is the same argument that
# keeps the ledger out of every cell's mounts.
LEDGER="$EXCHANGE/ledger/seal-ledger.json"
# Inside inbox/ deliberately — same convention as briefs/archive, and the sealer
# skips it for free because safe_entries() yields regular files only, so a
# directory here can never be mistaken for a request.
ARCHIVE="$INBOX/archive"

MODE="${1:-list}"
REQ_ID="${2:-}"

log() { printf 'research-request-mover: %s\n' "$*" >&2; }

mkdir -p "$REQUESTS" "$INBOX"

validate() {
  # Closed schema. `query` is prose for a search engine: no URLs, no paths, no
  # shell metacharacters, no encoded blobs, length-capped. None of that stops a
  # determined encoding inside natural language — see the header — it stops the
  # clumsy cases and gives you something short enough to actually read.
  python3 - "$1" <<'PY'
import json, re, sys, pathlib
p = pathlib.Path(sys.argv[1])
if p.is_symlink() or not p.is_file():
    print("not-a-regular-file", file=sys.stderr); sys.exit(1)
if p.stat().st_size > 8192:
    print("too-large", file=sys.stderr); sys.exit(1)
try:
    d = json.loads(p.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"invalid-json:{exc}", file=sys.stderr); sys.exit(1)
if not isinstance(d, dict):
    print("not-an-object", file=sys.stderr); sys.exit(1)
unknown = set(d) - {"query", "topic_id"}
if unknown:
    print(f"unknown-key:{','.join(sorted(unknown))}", file=sys.stderr); sys.exit(1)
q = d.get("query")
if not isinstance(q, str) or not (1 <= len(q) <= 300):
    print("bad-query", file=sys.stderr); sys.exit(1)
for pat, name in (
    (r"[;&|`$(){}<>\n\\]", "shell-metacharacter"),
    (r"[a-z][a-z0-9+.-]*://|\bwww\.", "url"),
    (r"(^|\s)/[A-Za-z0-9._/-]{4,}", "filesystem-path"),
    (r"[A-Za-z0-9+/]{40,}={0,2}", "encoded-blob"),
    (r"(sk-|xoxb-|xapp-|lin_api_|pplx-|ghp_|github_pat_)", "credential-prefix"),
):
    if re.search(pat, q, re.I):
        print(f"query:{name}", file=sys.stderr); sys.exit(1)
t = d.get("topic_id")
if not isinstance(t, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", t or ""):
    print("bad-topic_id", file=sys.stderr); sys.exit(1)
print(q)
PY
}

case "$MODE" in
  list)
    n=0
    for f in "$REQUESTS"/*.json; do
      [ -e "$f" ] || continue
      n=$((n + 1))
      id="$(basename "$f" .json)"
      if q="$(validate "$f" 2>/dev/null)"; then
        printf '  %-40s VALID   %s\n' "$id" "$q"
      else
        why="$(validate "$f" 2>&1 >/dev/null || true)"
        printf '  %-40s BLOCKED %s\n' "$id" "$why"
      fi
    done
    [ "$n" -eq 0 ] && log "no pending requests"
    log "review each one, then: $0 approve <id>   (or reject <id>)"

    # THE SECOND HALF OF THE ANSWER. `list` used to show only requests/ — what
    # you had not decided on yet — which quietly implied that anything past your
    # approval was somebody else's problem. It was not: approved requests
    # accumulate in inbox/ forever and nothing but this script can remove them,
    # so "what is outstanding" was unanswerable without reading the ledger by
    # hand. States come from the sealer; a request it has never seen shows as
    # `-`, which for a file older than one 300s pass means the dispatch stage is
    # not running.
    python3 - "$LEDGER" "$INBOX" <<'PY' || true
import json, pathlib, sys

ledger_path, inbox = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
requests = sorted(p for p in inbox.glob("*.json") if p.is_file())
if not requests:
    sys.exit(0)

entries = {}
try:
    doc = json.loads(ledger_path.read_text(encoding="utf-8"))
    if isinstance(doc, dict) and isinstance(doc.get("inbox"), dict):
        entries = doc["inbox"]
except FileNotFoundError:
    print("research-request-mover: (no ledger yet; states unknown)", file=sys.stderr)
except (OSError, ValueError) as exc:
    print(f"research-request-mover: (ledger unreadable: {exc})", file=sys.stderr)

print("", file=sys.stderr)
print(f"  inbox — {len(requests)} approved request(s):", file=sys.stderr)
stale = 0
for path in requests:
    rec = entries.get(path.name)
    state = rec.get("state") if isinstance(rec, dict) else None
    when = (rec or {}).get("completed_at") or (rec or {}).get("dispatched_at") or ""
    if state in ("done", "abandoned"):
        stale += 1
    print(f"    {path.stem:<40} {state or '-':<10} {when[:19]}", file=sys.stderr)
if stale:
    print(
        f"\nresearch-request-mover: {stale} answered request(s) still in the inbox; "
        "clear them with: archive",
        file=sys.stderr,
    )
PY
    ;;

  approve)
    [ -n "$REQ_ID" ] || { log "usage: $0 approve <id>"; exit 2; }
    # Never build a path by concatenating unchecked input.
    case "$REQ_ID" in
      *[!A-Za-z0-9._-]*) log "refusing unsafe id: $REQ_ID"; exit 1 ;;
    esac
    src="$REQUESTS/$REQ_ID.json"
    [ -f "$src" ] || { log "no such request: $REQ_ID"; exit 1; }
    if ! q="$(validate "$src")"; then
      log "REFUSED — request failed schema validation; not moving it."
      exit 1
    fi
    log "approving: $q"
    tmp="$INBOX/.$REQ_ID.$$.tmp"
    cp "$src" "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$INBOX/$REQ_ID.json"
    rm -f "$src"
    log "moved to inbox. scout will pick it up on its next run."
    ;;

  reject)
    [ -n "$REQ_ID" ] || { log "usage: $0 reject <id>"; exit 2; }
    case "$REQ_ID" in
      *[!A-Za-z0-9._-]*) log "refusing unsafe id: $REQ_ID"; exit 1 ;;
    esac
    rm -f "$REQUESTS/$REQ_ID.json"
    log "rejected and discarded: $REQ_ID"
    ;;

  archive)
    # Optional id: with one, archive exactly that request; without, everything
    # eligible. Same path rule as approve/reject — never build a path out of
    # unchecked input.
    if [ -n "$REQ_ID" ]; then
      case "$REQ_ID" in
        *[!A-Za-z0-9._-]*) log "refusing unsafe id: $REQ_ID"; exit 1 ;;
      esac
    fi

    # FAILS CLOSED, UNLIKE THE SEALER'S OWN LOADER. quarantine-seal.sh tolerates a
    # missing ledger and continues, because the worst it can do there is repeat
    # work. Here the ledger is the ONLY evidence that a request was answered, and
    # the action is a delete from the human-approval directory. Without it every
    # request would look equally archivable, including one dispatched ninety
    # seconds ago whose fetch is still in flight.
    [ -f "$LEDGER" ] || {
      log "no ledger at $LEDGER — cannot tell which requests were answered."
      log "is quarantine-sealer running? refusing to archive anything."
      exit 1
    }

    mkdir -p "$ARCHIVE"

    # The ledger decides; the shell only moves. Eligible names go to stdout, one
    # per line; anything skipped is explained on stderr.
    eligible="$(python3 - "$LEDGER" "$INBOX" "$REQ_ID" <<'PY'
import json, pathlib, sys

ledger_path, inbox, only = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]
try:
    doc = json.loads(ledger_path.read_text(encoding="utf-8"))
except (OSError, ValueError) as exc:
    print(f"research-request-mover: ledger unreadable ({exc})", file=sys.stderr)
    sys.exit(1)

entries = doc.get("inbox") if isinstance(doc, dict) else None
if not isinstance(entries, dict):
    print("research-request-mover: ledger holds no inbox record", file=sys.stderr)
    sys.exit(1)

# `abandoned` is archivable alongside `done` on purpose. It means the dispatch
# timed out with no output, and it is NEVER re-published — so leaving it in the
# inbox preserves nothing except the ambiguity this verb exists to remove. If you
# still want that lookup, re-approve it; that is the documented path and it is a
# human decision, which is the whole point.
ARCHIVABLE = ("done", "abandoned")
found = False
for path in sorted(p for p in inbox.glob("*.json") if p.is_file()):
    if only and path.stem != only:
        continue
    found = True
    rec = entries.get(path.name)
    state = rec.get("state") if isinstance(rec, dict) else None
    if state in ARCHIVABLE:
        print(path.name)
    elif state is None:
        print(
            f"research-request-mover: SKIP {path.stem} — not in the ledger. "
            "Either the sealer has not seen it yet, or phase ③ is not running.",
            file=sys.stderr,
        )
    else:
        print(
            f"research-request-mover: SKIP {path.stem} — state '{state}', still outstanding.",
            file=sys.stderr,
        )
if only and not found:
    print(f"research-request-mover: no such approved request: {only}", file=sys.stderr)
    sys.exit(1)
PY
)" || exit 1

    if [ -z "$eligible" ]; then
      log "nothing to archive."
      exit 0
    fi

    # No `mv -f`: a name collision in archive/ means the same topic_id was
    # approved twice, and silently overwriting the older record would destroy the
    # evidence of the first run. Suffix it instead.
    n=0
    printf '%s\n' "$eligible" | while IFS= read -r name; do
      [ -n "$name" ] || continue
      dest="$ARCHIVE/$name"
      if [ -e "$dest" ]; then
        dest="$ARCHIVE/${name%.json}.$(date -u +%Y%m%dT%H%M%SZ).json"
      fi
      mv "$INBOX/$name" "$dest"
      log "archived ${name%.json}"
      n=$((n + 1))
    done
    log "done. the ledger keeps the record; archive/ keeps the request."
    ;;

  *)
    log "usage: $0 [list|approve <id>|reject <id>|archive [<id>]]"
    exit 2
    ;;
esac
