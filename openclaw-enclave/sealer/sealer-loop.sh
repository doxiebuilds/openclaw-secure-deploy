#!/bin/sh
# sealer-loop.sh — the timer for the airlock. Re-runs quarantine-seal.sh forever.
#
# WHY THIS CONTAINER EXISTS
# quarantine-seal.sh is the gate for BOTH handoffs: raw/ -> normalized/ for
# fetched web content, and briefs-pending/ -> briefs/ for validated JSON briefs.
# Nothing a producer writes reaches a consumer until it has run. So the only
# thing that matters about its schedule is that it actually happens.
#
# It did not. It ran from a macOS LaunchAgent on a 600s interval and failed
# EVERY run with exit 126 "Operation not permitted": macOS TCC refuses
# LaunchAgent execution under TCC-protected paths such as ~/Documents, and the enclave
# lived under a TCC-protected path (e.g. ~/Documents). The evidence was seven identical lines in a log file
# nobody reads. No alert fired. No dashboard showed a gap, because a dashboard
# built on "briefs promoted per hour" cannot tell "zero promoted" apart from
# "nothing to promote". The airlock was not slow. It was OFF, and it looked
# fine.
#
# That is the failure mode this file is shaped around. Not "the gate was late"
# — "the gate was off and nothing said so". Hence, below: a heartbeat written
# BEFORE the work rather than after it, a hard exit on a missing mount so the
# breakage is a restart loop instead of a quiet no-op, and a refusal to die on
# a bad file so that one poisoned input cannot become the thing that stops the
# gate the way TCC did.
#
# WHY 300s
#   • It must stay well under the curator's 15-minute distill cadence. The
#     sealer sits between producer and consumer on every hop, so any interval
#     approaching the consumer's own cadence shows up as pipeline latency and
#     invites somebody to "fix" it by widening a mount instead.
#   • Since this script promotes briefs and no longer merely inspects them, the
#     interval is a LATENCY knob, not a security-exposure knob. Slowing it down
#     does not shorten any window of hostile exposure — an unsealed file simply
#     sits in the producer's directory, where no consumer can see it. It only
#     makes the pipeline sluggish. The pressure therefore runs toward shorter,
#     and 300s already costs nothing measurable.
#   • It must stay BELOW the healthcheck's `-mmin -15` window, with room. If the
#     poll interval ever approached 15 minutes the container would flap
#     unhealthy while working perfectly, and a healthcheck people learn to
#     ignore is exactly the log file this container was created to replace.

set -eu

SEAL=/enclave/scripts/quarantine-seal.sh
EXCHANGE="${EXCHANGE_ROOT:-/enclave/exchange}"

RAW="$EXCHANGE/raw"
NORMALIZED="$EXCHANGE/normalized"
BRIEFS="$EXCHANGE/briefs"
BRIEFS_PENDING="$EXCHANGE/briefs-pending"

# Liveness marker. /tmp is the only writable path in this container (32M tmpfs,
# rootfs is read_only), so the beat necessarily lives there and necessarily
# dies with the container — which is what we want. A beat that survived a
# restart would be a beat that can lie.
BEAT=/tmp/sealer.beat

POLL_SECONDS="${POLL_SECONDS:-300}"

log() { printf '%s sealer: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# ── Preflight ───────────────────────────────────────────────────────────────
#
# A missing script or a missing exchange directory is a CONFIGURATION error,
# and configuration errors cannot self-heal: no number of retries will make an
# absent bind mount appear. Retrying one would produce precisely the LaunchAgent
# outcome — a process that is up, looks alive, logs the same line forever, and
# seals nothing.
#
# So this exits non-zero. Under `restart: unless-stopped` that becomes a
# visible restart loop, which is loud, obvious in `docker ps`, and correct. A
# container thrashing on startup gets investigated; a container quietly
# processing an empty directory does not.
#
# Note the deliberate asymmetry with a bad FILE, handled far below: a bad file
# is transient and specific, so it is logged and retried on the next tick. Only
# structural breakage is fatal here.
[ -x "$SEAL" ] || [ -f "$SEAL" ] || {
  log "FATAL: $SEAL is missing; the scripts/ mount did not land"
  log "check the read-only /enclave/scripts entry under volumes: in docker-compose.yml"
  exit 1
}

for dir in "$RAW" "$NORMALIZED" "$BRIEFS" "$BRIEFS_PENDING"; do
  [ -d "$dir" ] || {
    log "FATAL: $dir is missing; refusing to run a gate over a directory that is not there"
    log "check the volumes: entries for the exchange dirs in docker-compose.yml"
    exit 1
  }
done

# ── Shutdown ────────────────────────────────────────────────────────────────
#
# POSIX sh does not interrupt a running foreground command to service a trap:
# it defers the handler until that command returns. That gives us exactly the
# ordering we want for free. During `sleep` — where this process spends almost
# all of its life — the signal cuts the sleep short and we exit immediately.
# During a seal pass, the pass runs to completion first, so a `docker compose
# down` cannot land between quarantine-seal.sh's atomic write and its rename
# and strand a half-promoted brief.
trap 'log "signal received; stopping"; exit 0' TERM INT

log "starting; sealing $EXCHANGE every ${POLL_SECONDS}s (min file age ${SEAL_MIN_AGE_SECONDS:-0}s)"

while :; do
  # (a) HEARTBEAT FIRST, before any work. The compose healthcheck is
  #     `find /tmp/sealer.beat -mmin -15 | grep -q .` — it tests for SILENCE,
  #     not for death, because this container exists on account of a gate that
  #     was dead and looked healthy. Stamping the beat at the TOP of the loop
  #     means a pass that explodes mid-way still proves the loop is turning,
  #     and the seal failure is reported on its own terms (in the log, below)
  #     rather than being conflated with the loop having stopped. Stamping it
  #     at the bottom would invert that: a wedged pass would read as a dead
  #     container, and a dead container would read as a wedged pass.
  #
  #     Left unguarded on purpose. If /tmp is not writable the tmpfs is
  #     missing, the healthcheck can never see a fresh beat again, and this
  #     process is invisible from the outside — set -eu killing us here is the
  #     honest outcome. We do not run blind.
  : > "$BEAT"

  # (b) Sweep orphaned atomic-write temps out of both consumer-visible dirs.
  #
  #     quarantine-seal.sh's atomic_write() creates `.<name>.<pid>.tmp`, writes
  #     it, then os.replace()s it into position. A SIGKILL between those two
  #     steps strands the temp file. The seal script will never revisit it —
  #     its SAFE_NAME_RE requires a leading alphanumeric, so a dotted name is
  #     invisible to it forever — but these directories are not private:
  #     curator mounts normalized/ and cell 3 mounts briefs/. A truncated
  #     fragment sitting there is content that nothing ever vetted, in the one
  #     place downstream readers are told they may trust what they find.
  #
  #     +60 minutes cannot race a live write: a real atomic_write lives for
  #     milliseconds, so anything an hour old is by definition debris from a
  #     process that no longer exists.
  #
  #     -exec ... \; deliberately, NOT -delete and NOT -exec ... {} +. This is
  #     busybox find, whose support for both varies by build; the portable form
  #     is worth more than the fork it costs once every five minutes.
  for dir in "$NORMALIZED" "$BRIEFS"; do
    find "$dir" -maxdepth 1 -type f -name '.*.tmp' -mmin +60 \
      -exec rm -f {} \; 2>/dev/null || true
  done

  # (c) Run the seal, and never let it be fatal.
  #
  #     quarantine-seal.sh runs under `set -eu` itself, so a single uncaught
  #     error — an unreadable file, a rename onto a path that vanished, a
  #     transient ENOSPC on the exchange volume — aborts the whole remaining
  #     batch and returns non-zero. That is fine and recoverable: the correct
  #     response is the next tick.
  #
  #     What is NOT fine is propagating it. Dying here hands the container to
  #     `restart: unless-stopped`, which turns one bad file into a crash loop
  #     that re-hits the same bad file every few seconds and never gets far
  #     enough to process the good ones queued behind it. The gate would once
  #     again be off — this time with a busy log to hide it in. So: capture the
  #     status, say so plainly, keep the loop turning.
  rc=0
  sh "$SEAL" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "quarantine-seal.sh exited $rc; leaving inputs in place, retrying in ${POLL_SECONDS}s"
  fi

  # (d) Wait. This is where the process lives; see the trap above.
  sleep "$POLL_SECONDS"
done
