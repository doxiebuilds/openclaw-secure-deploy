set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

TARGETS="docs openclaw-enclave openclaw-docker-config tools"

# Only scan paths that exist, so the hook works in a partial checkout.
SCAN=""
for t in $TARGETS; do
  [ -e "$t" ] && SCAN="$SCAN $t"
done
[ -n "$SCAN" ] || exit 0

# This file necessarily contains the pattern it searches for, so it excludes
# itself by name. `tools/` stays in scope so a dangerous recipe added to some
# other script here is still caught.
# shellcheck disable=SC2086
HITS="$(grep -rn \
  --include='*.md' --include='*.sh' --include='*.yml' --include='*.yaml' \
  --include='*.json' --include='*.mjs' \
  --exclude='lint-dangerous-recipes.sh' \
  -E 'OPENCLAW_STATE_DIR=' $SCAN 2>/dev/null)"

# The YAML mapping form. A Compose `environment:` block can set the variable
# without an `=` anywhere:
#
#     environment:
#       OPENCLAW_STATE_DIR: /home/node/.openclaw
#
# That reaches the container exactly like the assignment form and passed this
# lint unseen until 2026-07-31. (The list form, `- OPENCLAW_STATE_DIR=/path`,
# was already caught above.)
#
# Scoped to YAML and anchored to a mapping key — leading whitespace, an
# optional list dash, the name, then a colon — so prose in the docs that names
# the variable while telling you never to set it does not trip its own lint.
# shellcheck disable=SC2086
YAML_HITS="$(grep -rn \
  --include='*.yml' --include='*.yaml' \
  --exclude='lint-dangerous-recipes.sh' \
  -E '^[[:space:]]*-?[[:space:]]*OPENCLAW_STATE_DIR[[:space:]]*:' $SCAN 2>/dev/null)"

if [ -n "$YAML_HITS" ]; then
  HITS="$(printf '%s\n%s' "$HITS" "$YAML_HITS" | sed '/^$/d')"
fi

[ -z "$HITS" ] && exit 0

echo "BLOCKED: a command sets OPENCLAW_STATE_DIR." >&2
echo "" >&2
printf '%s\n' "$HITS" >&2
echo "" >&2
echo "Setting OPENCLAW_STATE_DIR against a live config directory makes OpenClaw" >&2
echo "MOVE ~/.openclaw/exec-approvals.json into that directory and rename the" >&2
echo "original to .migrated. This destroyed the live file on 2026-07-29." >&2
echo "" >&2
echo "To validate a config edit, use instead:" >&2
echo "  docker exec -e OPENCLAW_CONFIG_PATH=/tmp/candidate.json openclaw \\" >&2
echo "    openclaw config validate --json" >&2
echo "" >&2
echo "See docs/launch_and_update.md. Override once with: git commit --no-verify" >&2
exit 1
