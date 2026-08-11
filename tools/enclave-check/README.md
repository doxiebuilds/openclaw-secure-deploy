# enclave-check

A static checker that derives the **trust topology** of a multi-container agent
deployment from its config files, then proves or refutes named security
invariants against that model.

It replaces a class of manual verification. `docs/security_verification.md`
carries ~55 `docker exec` probes; roughly 30 are one-liners and about half of
those are decidable from the compose file alone ("is cell 3 on a non-internal
network", "does curator mount briefs/", "is the sealer's `network_mode` still
`none`", "does any container hold all three exchange directories"). Those
questions have static answers, and a static answer can run in CI, run before
`up`, and run on a machine where the stack is not running.

It is **read-only**: it never invokes docker, never opens a socket, and writes
nothing. It is also **not** a replacement for the runtime probes — see
[What it cannot tell you](#what-it-cannot-tell-you).

```
model.py          config files -> a topology graph
invariants.yaml   the invariants, declaratively
check.py          evaluate them, emit PASS / FAIL / UNKNOWN
```

## Running it

```sh
python3 tools/enclave-check/check.py                     # this repo, default compose
python3 tools/enclave-check/check.py -v                  # with evidence for passes too
python3 tools/enclave-check/check.py --dump-model        # just the derived topology
python3 tools/enclave-check/check.py --json              # machine-readable
python3 tools/enclave-check/check.py --only baseline-matches-config -v

# model an override stack exactly as `docker compose -f a -f b` would merge it
python3 tools/enclave-check/check.py \
  -f openclaw-docker-config/docker-compose.yml \
  -f openclaw-docker-config/docker-compose.cell3-bridge.yml
```

No dependencies beyond CPython 3.8+. No pip install, no venv.

**Exit status** — `0` all PASS · `1` any FAIL · `2` any UNKNOWN and no FAIL ·
`3` the tool could not run at all. `2` is deliberately not `0`.

## The three results

| | meaning |
|---|---|
| `PASS` | the model **proves** the invariant holds |
| `FAIL` | the model **refutes** it — a finding |
| `UNKNOWN` | the model could not decide — **also a finding** |

`UNKNOWN` is first-class and is never silently folded into `PASS`. An
unparseable `AGENT_POLICY`, an agent config the compose file mounts but which
does not exist on disk, an unresolved `${VAR}` in a mount that would change an
answer — each produces `UNKNOWN` with the reason attached. A checker whose
model has gone stale must say so rather than report all-clear; that failure
mode is exactly what this repo's own drift alert exists to catch
(`CRITICAL` from `check-approvals.sh` means "not checked", not "tampered").

## What it models, and the three places guessing would invert the answer

**Compose merge tags.** `-f a.yml -f b.yml` **merges**: sequences are appended,
mappings are merged key-by-key. Only `!override` replaces and only `!reset`
removes. `docker-compose.cell3-bridge.yml` relies on all three behaviours at
once — `environment: !reset []`, `networks: !override [default]` on `openclaw`,
and an untagged `networks: [default]` on `main-ui-forward` that *merges* to
three networks. A tool that assumed "override replaces" would report cell 3 as
still holding its `net_main` leg and cell 3's proxy variables as still set.
Merge decisions are printed as `note` lines so they can be checked by eye.

**Proxy matching.** `egress-proxy.py` matches `EGRESS_ALLOW` by **exact
lowercased host**. No suffix wildcards — `.github.com` is not a rule, it is a
hostname that will never match — and an IP literal is refused even when it is
listed. The model reproduces this, and `--dump-model` reports listed IP
literals as `egress DEAD` because they are dead weight in the allowlist.

**Forwarder transitivity.** `tcp-forward.py` dials exactly
`FORWARD_TO_HOST:FORWARD_TO_PORT` and never relays between its own legs. Each
instance is therefore a directed edge to **one** host:port and is
**non-transitive**. Modelling a dual-homed forwarder as a bridge would make
every `internal: true` network look routable, and `qwen-forward` — on all six
networks — would look like it joined every cell to every other.

Two smaller rules that are easy to get backwards:

- A service with **no `networks:` key is not isolated** — compose attaches it to
  `default`. Only `network_mode: none` is isolation. The model follows compose.
- `tools.profile` is a **ceiling, not the effective tool set**. The authority is
  `agents.list[].tools.allow`, which is absolute and replaces the profile. The
  model reads `allow`/`deny` per agent; `profile` is recorded but never treated
  as the answer.

Other inputs: `.env` and `${HOME}`/`~` expansion for bind sources, `:ro`/`:rw`
per mount, `secrets:` entries, `models.providers.*.baseUrl`, `mcp.servers`,
`plugins.allow` / `plugins.entries.*.enabled`, and `AGENT_POLICY` parsed out of
`plugins/build-guard/index.mjs` (it is hardcoded there and the plugin declares
an empty closed `configSchema`, so the source *is* the config). The
`AGENT_POLICY` parser fails loudly on any shape change rather than returning an
empty policy, because an empty policy reads as "nothing denied" and would turn
a FAIL into a PASS.

## Why the YAML loader is hand-written

Python ships no YAML parser and this tool takes **no pip dependency** — it has
to run in CI, in a pre-commit hook, and on a fresh checkout with nothing
installed. The three options were: shell out with a vendored fallback, use JSON
for the invariants, or write a loader.

A loader won because the compose files must be parsed **anyway** and JSON would
not have helped there: `docker compose config` requires docker, and the whole
point is to answer these questions without it. Given a loader exists, spending
it on the invariant file too costs nothing and keeps the spec readable —
comments and folded prose in `invariants.yaml` are how the *why* stays next to
the *what*.

`model.py`'s loader covers the subset these files use: block maps, block
sequences, flow collections, quoted/plain scalars, comments, block scalars
(`|`, `>`) and custom tags. It **rejects** what it does not implement —
anchors, aliases, tabs, multi-document streams — with a file:line error rather
than a quiet mis-parse. If you point it at a compose file using anchors, it
will tell you instead of lying to you.

## The invariants shipped in v1

| id | in one line |
|---|---|
| `no-model-holds-all-three` | no container holds `raw` + `normalized` + `briefs` **and a model** |
| `no-agent-edits-own-schedule` | `cron` is in `tools.deny` for every agent in every cell |
| `no-lethal-trifecta-path` | no service has untrusted content + a credential + a non-internal leg |
| `internal-networks-have-no-egress` | cells sit only on internal networks; only expected services bridge out |
| `curator-cannot-see-past-its-own-gate` | cell 2 cannot read *or* write `briefs/` **or** `briefs-flagged/`, at the Docker layer **and** the guard layer, reported per layer |
| `only-the-sealer-writes-the-destinations` | only `quarantine-sealer` holds a writable mount of either promotion destination |
| `no-proxy-names-only-qwen-forward` | neither `NO_PROXY` nor `no_proxy` contains an entry that restores unproxied internet |
| `baseline-matches-config` | `exec-allowlist.baseline` is re-derived from `openclaw.json`, not trusted |

Three of these encode a judgement that belongs to the deployment, not to the
tool, so it lives in `invariants.yaml` where it can be argued with:

- **`untrusted_mounts` includes `/exchange/briefs`.** The sealer validates a
  brief's *schema*, not its semantics, so a promoted brief is still
  model-written prose derived from hostile input. Drop it from the list if you
  disagree — that is a one-line edit to the spec, not a code change.
- **`count_proxied_egress_as_leg: false`.** Cell 1 reaches the internet only
  through a default-deny allowlist proxy, which the trifecta invariant as
  stated does not count as an egress leg. Proxied egress is still *reported* as
  evidence on every affected service. Set it to `true` and cell 1 FAILs — a
  defensible position, but a different invariant, so it is a knob and not a
  default.
- **`internal-networks-have-no-egress` has two clauses.** The bridge-list clause
  alone is unfalsifiable: deleting `internal: true` from a network *removes* its
  members from the dual-homed set, so a check that only counted bridges would
  report that weakening as an improvement. The first clause — every agent cell
  sits only on internal networks — is what actually catches it. Cells are found
  by their mounts, not by name.

## Adding an invariant

Most new invariants are a **YAML edit only**. Each entry names a `type`
implemented in `check.py`, and the shipped types are reusable:

| type | parameters |
|---|---|
| `no_holder_of_set_with_model` | `mount_markers` |
| `agent_tool_denied` | `tool`, `field`, `accept_absent_from_allow` |
| `no_trifecta` | `legs.{untrusted,credential,count_proxied_egress_as_leg}` |
| `dual_homed_allowlist` | `expected`, `cells_must_be_internal_only`, `cells_allowed_direct_egress` |
| `two_layer_path_deny` | `docker.{service,forbidden_path}`, `guard.{agent,field,must_contain}` |
| `no_proxy_scope` | `required`, `accepted_dual_homed_peers` |
| `baseline_restatement` | `baseline`, `service`, `guard_sha256_file`, `ignore_prefixes` |

So "no agent may use `code_execution`" is a copy of the `agent_tool_denied`
entry with `tool: code_execution`. "The executor must never mount the projects
root" is a `two_layer_path_deny` with only the `docker` half.

A genuinely new question needs a new type:

1. Write `check_<type>(topo, inv, spec) -> Result` in `check.py`, register it in
   `CHECKS`.
2. Return `res.record(UNKNOWN, why)` on **every** path where the model is
   silent. Never fall through to PASS. This is the whole discipline of the tool.
3. Call `res.ev(...)` for each service you considered, including the ones that
   were fine — evidence for a PASS is what makes the PASS reviewable, and
   `-v` prints it.
4. Prove it can fail. See below.

`topo` is a `model.Topology`: `topo.services`, `topo.networks`,
`topo.dual_homed()`, `topo.internal_legs(svc)`, `topo.endpoint_reachable(...)`,
`topo.guard_policy`, and per service `svc.mounts_ending(path)`,
`svc.credential_evidence(...)`, `svc.forward_target`, `svc.egress_allow()`,
`svc.agent_config`.

## Pointing it at another deployment

Everything environment-specific is in `invariants.yaml` under `sources:` and
`vocabulary:`; nothing is hardcoded in the Python. Agent cells are discovered by
following the mount that places `agent_config_file` at `agent_config_target`,
so cells are recognised by shape rather than by name.

```sh
python3 tools/enclave-check/check.py \
  --repo-root /path/to/other/repo \
  --invariants /path/to/other/invariants.yaml
```

Invariants 5 and 7 name specific services (`openclaw-curator`, `openclaw`) and
invariant 4 carries this deployment's expected bridge list — those are
parameters in the spec file, not assumptions in the code.

## Proving the checker can fail

A checker that cannot fail is worthless, and every invariant here currently
passes, so the negative controls are the only evidence the PASSes mean
anything. **They are automated — run them:**

```sh
python3 tools/enclave-check/negative-controls.py     # exit 0 = all falsified
```

Eleven mutations, one or more per invariant, each applied to a throwaway copy of
the tree. Any invariant that still PASSes under its mutation is reported as
UNFALSIFIABLE and the run exits 1.

### What running them actually found

Every one of these was invisible to reading the code, and three were real:

- **`no_proxy_entries()` read one spelling of two.** It was
  `env.get("NO_PROXY", env.get("no_proxy"))` — uppercase first, lowercase only
  as a fallback. compose sets *both* on every proxied cell and HTTP clients
  honour either, so a wildcard punched into the lowercase name alone was never
  examined while the uppercase one stayed clean. It now returns the union.
- **The dual-homed bridge check was unfalsifiable** (found earlier, fixed
  earlier): deleting `internal: true` *removed* that network's members from the
  set being counted, so the checker reported the weakening as an improvement. It
  now has a first clause derived from the model — every agent cell sits only on
  internal networks, with cells identified by their mounts rather than by name.
- **The control harness itself was reading the wrong files.** compose bind
  sources are absolute, so copying the tree did not redirect them: mutations to
  `openclaw.json` or the guard were graded against the *real* originals. Path
  checks matched on suffix and moved with the copy; file-reading checks did not.
  `run()` now repoints every bind source at the copy.

And two mutations that looked like findings were not, which is worth as much:

- **A model endpoint on the sealer alone does not fail
  `no-model-holds-all-three`, and should not.** The check asks whether the
  endpoint is *reachable*; a `network_mode: none` container cannot be told what
  to do by a model it has no route to. The mutation now adds the endpoint **and**
  a network, which is the configuration the invariant exists to catch.
- **A mutation whose anchor no longer matches is not a passing invariant.** Two
  controls silently degraded to no-ops when the source text moved. They now
  raise `MUTATION BROKEN` and fail the run, because a control that quietly stops
  testing anything is worse than no control.

The manual recipes below remain useful for one-off checks. All of these mutate a
**copy**; the repo is never touched.

```sh
tmp=$(mktemp -d)
cd "$(git rev-parse --show-toplevel)"

# (a) give cell 2 a briefs/ mount -> curator-cannot-see-past-its-own-gate FAILs (docker layer)
sed 's|\(exchange/normalized:/home/node/exchange/normalized:ro\)|\1\
      - ~/path/to/openclaw-secure-deploy/openclaw-enclave/exchange/briefs:/home/node/exchange/briefs:ro|' \
  openclaw-docker-config/docker-compose.yml > "$tmp/a.yml"
python3 tools/enclave-check/check.py -f "$tmp/a.yml"

# (b) take internal: true off net_scout -> no-lethal-trifecta-path and
#     internal-networks-have-no-egress both FAIL
python3 - "$tmp/b.yml" <<'PY'
import sys
src = open("openclaw-docker-config/docker-compose.yml").read()
open(sys.argv[1], "w").write(src.replace("  net_scout:\n    internal: true\n", "  net_scout:\n", 1))
PY
python3 tools/enclave-check/check.py -f "$tmp/b.yml"

# (c) UNKNOWN is reachable: rename AGENT_POLICY so the guard layer cannot be read
sed 's/const AGENT_POLICY = {/const AGENT_PATH_POLICY = {/' \
  openclaw-enclave/plugins/build-guard/index.mjs > "$tmp/guard.mjs"
sed "s|build_guard: openclaw-enclave/plugins/build-guard/index.mjs|build_guard: $tmp/guard.mjs|" \
  tools/enclave-check/invariants.yaml > "$tmp/inv.yaml"
python3 tools/enclave-check/check.py --invariants "$tmp/inv.yaml" \
  --only curator-cannot-see-past-its-own-gate -v      # -> UNKNOWN, exit 2, NOT a PASS
```

Expected: (a) exit 1, `curator-cannot-see-past-its-own-gate` FAIL naming the **docker**
layer while the guard layer still passes. (b) exit 1, two FAILs. (c) exit 2,
one UNKNOWN — the docker layer still reports `ok`, and the invariant as a whole
refuses to claim a PASS on one layer's evidence.

Running the bridge override is the fourth control, and the only one that uses
files already in the repo:

```sh
python3 tools/enclave-check/check.py \
  -f openclaw-docker-config/docker-compose.yml \
  -f openclaw-docker-config/docker-compose.cell3-bridge.yml
```

Cell 3 loses `net_main` and gains `default`; the two network invariants FAIL.
That is correct and expected — the override file's own header says it *"weakens
the stack on purpose"*. The FAILs are the tool agreeing with the documentation.

## What it cannot tell you

Static analysis of the configuration answers "what did we ask Docker for", not
"what is running". It cannot see:

- **Drift between the files and the live daemon.** A container started before an
  edit keeps its old networks and its old mounts. `docker inspect` is the
  authority on a running stack; this tool is the authority on the next `up`.
- **Whether a client honours `HTTPS_PROXY`.** The whole `NODE_USE_ENV_PROXY`
  saga in the compose comments is a runtime property. The negative test in
  `docs/security_verification.md` stays necessary.
- **What comes back through an allowed path.** `perplexity-mcp` fetches
  arbitrary pages on cell 1's behalf; `EGRESS_ALLOW` bounds where scout's own
  connections terminate, not where the content it ends up holding came from.
  The model reports the *edge*, never the trust of what crosses it.
- **Anything below the config layer** — image contents, kernel, TCC, filesystem
  permissions, or whether `~/.openclaw-secrets/*.json` is really mode 0600.
