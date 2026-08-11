# Security

## Reporting a vulnerability

Don't open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/doxiebuilds/openclaw-secure-deploy/security/advisories/new), which opens a draft advisory only the maintainer can see. No email needed.

Useful reports include what you found, how to reproduce it, which component is affected, and what an attacker gets out of it. A suggested fix is welcome but not required.

One person maintains this in their spare time, so there is no response SLA. I read every report and I'd rather hear about a problem late than not at all.

## Two things you might expect to find here and won't

**There is no Docker socket, and no socket proxy.** Earlier single-container revisions used `docker-socket-proxy` so OpenClaw could manage nested sandboxes. This multi-cell design drops that path entirely. Nested per-session containers require the ability to create containers with arbitrary binds, which is a host-escape primitive. Agent cells have no `DOCKER_HOST` and no socket. That is stricter than what came before. It also means you do not get OpenClaw's nested sandbox feature, because the outer container is the sandbox.

**Images are pinned by digest in the Dockerfiles, not `:latest`.** Rebuilds should not silently change the binary. Upgrades are an explicit edit to a digest line. If you loosen that, you get patches automatically and you lose reproducibility. 

## What this does not protect against

Not an exhaustive list. These are the categories that matter most.

**Prompt injection.** Everything here hardens cells against the host and against each other. None of it hardens a model against being tricked. If scout processes a malicious webpage, it will follow instructions in that content.

What the layout buys you is that scout holds no Slack token, no project mount, and can only write into `exchange/raw` for a deterministic sealer to process.

What it does not buy you is a clean break. Main holds Slack, Linear and your project repo, and it reads briefs distilled from the same text scout fetched. The phase ② schema check is the last thing standing between those two facts: a closed-key schema, a sha that must match the source, and `evidence_excerpt` resolved from numbered source lines. A payload that satisfies all three reaches the cell holding your credentials. That barrier is deterministic and small, which is why I trust it more than I would trust a model, but it is one barrier and not a guarantee.

**Perplexity's server-side fetch.** Optional `perplexity-mcp` holds an API key outside any agent process and can retrieve content from hosts that are not on scout's egress allowlist. The allowlist bounds where scout's own connections terminate. Server-side retrieval is a different channel. Scout still cannot reach your repos or main's secrets.

**Unknown vulnerabilities.** A container escape in the kernel, Docker, containerd, or runc bypasses every control below. Same for a bug in OpenClaw itself or in any skill, tool, or dependency it loads.

**Anything resembling production.** Built for personal single-user use, never professionally audited. If this is going near real systems or real assets, get it independently assessed first.

## What is enforced

Every control below is enforced by the kernel, the container runtime, or the mount list. None of it depends on the agent choosing to cooperate.

### Container (each agent cell)

| Control | Setting | Effect |
|---|---|---|
| Read-only root | `read_only: true` | System binaries, libraries, and packages cannot be modified at runtime |
| Capabilities | `cap_drop: ALL` | Zero Linux capabilities at startup |
| Escalation | `no-new-privileges:true` | `sudo` and setuid binaries fail immediately |
| User | non-root (`node` / as packaged) | Never root, even inside the container |

### Cell split

| Cell | Network | Egress | Credentials | Untrusted input |
|---|---|---|---|---|
| scout | `net_scout` (internal) | Via `scout-egress-proxy` (+ optional Perplexity MCP) | Gateway token only | Web fetch / search results |
| curator | `net_curator` (internal) | None off-box (local Qwen only) | Gateway token only | `exchange/normalized` (post-sealer) |
| main | `net_main` (internal) | Via `main-egress-proxy` allowlist (Slack/Linear hosts) | Gateway + optional Slack | Structured `briefs/` only, never `raw/` |
| quarantine-sealer | `network_mode: none` | None | None | File system only, fixed script |

### Docker API

Agent cells never touch `/var/run/docker.sock`. There is no socket proxy in the default stack. Nested sandboxing was removed on purpose, see the note at the top of this file.

### Filesystem

Writable paths are cell-specific workspaces, plus the exchange directories each cell is allowed to touch. Example configs and scripts mount read-only where possible. Host paths outside the enclave are invisible.

**The mount list is the security boundary.** Main does not mount `exchange/raw` or `exchange/normalized`. Even if every in-process guard fails, main cannot read hostile fetched text at the Docker layer. There is a command below that checks this.

### Network

Agent cells sit on dedicated `internal: true` networks. They have no default route to the public internet. Dual-homed helper containers (`*-egress-proxy`, `perplexity-mcp`, UI forwards, `qwen-forward`) are the only bridges, and each bridge is purpose-built:

- Egress proxies: default-deny host allowlists
- UI forwards: inbound localhost bind only (`127.0.0.1`)
- `qwen-forward`: single hard-coded destination, does not relay between legs

Outbound internet access from scout exists on purpose. Web search and Perplexity need it. It is also the channel a compromised scout would use to send data out, limited by the fact that scout holds almost nothing.

**To cut scout outbound access entirely:** remove or stop `scout-egress-proxy` and `perplexity-mcp`, or empty the allowlist and drop Perplexity. You get an offline research cell, and you give up web search. Test afterwards.

### Secrets

Never commit secrets to this repository.

- Gateway and Slack tokens are **not** injected as environment variables into agent processes. They arrive as Docker secrets files under `/run/secrets/`, referenced from config via SecretRefs.
- On the host they live under `~/.openclaw-secrets/` (outside the git tree), mode `0600`.
- `openclaw-docker-config/.env` is for **paths** (`HOST_PROJECTS_ROOT`, and similar), not tokens. Only `.env.example` is version controlled.
- Optional `PERPLEXITY_API_KEY` is injected into the Perplexity MCP container only, never into scout, curator, or main.
- A pre-commit hook (`.githooks/pre-commit`) and CI secret-scan refuse credential-shaped strings and literal tokens in committed `openclaw*.json`.

Worth repeating: isolation does nothing to stop a manipulated agent from using a key it legitimately holds. Give the narrowest-scoped tokens that still let the cell work.

### Static and CI checks

| Check | What it proves |
|---|---|
| `tools/enclave-check/check.py` | Compose topology invariants (no lethal trifecta path, sealer-only brief writes, internal networks, and the rest) without running Docker |
| `tools/enclave-check/negative-controls.py` | That the invariants above can still **fail**. Mutates a throwaway copy of the tree — sealer gets a model, curator mounts `briefs-flagged/`, `NO_PROXY` widens — and reports UNFALSIFIABLE for any invariant that survives its own mutation |
| `openclaw-enclave/scripts/tests/injection/run.py` | Airlock hops ① (normalize), ③ (brief schema) and ③b (the sealer's cross-check) against hostile fixtures. Per-hop table, not a fake aggregate score. Hop ② (curator) is stubbed and SKIPs; hop ④ (routing) is not instrumented and contributes no cases. Does **not** claim model-level injection resistance |
| `run.py --self-check` | That the hop ③ rows are not vacuous — the validator really is being extracted from the sealer, and a renamed heredoc or a renamed `brief_violation` raises instead of yielding an empty namespace |
| `openclaw-enclave/plugins/build-guard/test-guard.mjs` | The in-process permission gate: per-agent path confinement, credential-read denial, the one-shot fetch budget, and the exec allowlist |
| Control-plane `npm test` / typecheck | Operator UI/API regressions |
| `docker compose config` | Compose files still interpolate |
| gitleaks + pattern scan | Credential-shaped material did not land in the tree |

`UNKNOWN` from enclave-check is a finding, not a pass. A checker that cannot decide must not report all-clear.

Two of those rows exist to check the checkers. `negative-controls.py` and `--self-check` assert that the other suites can still say no — a control you have only ever watched succeed is not a control you have tested, and `test-guard.mjs` carries a comment recording an assertion that sat failing for six days because nothing was running it. Every suite named here now runs on every push.

### What the injection benchmark covers

Numbers first, then what they are not. The table below is regenerated by the suite itself and CI fails if it drifts from a fresh run, so it describes the code in this commit rather than the code on the day someone typed it.

<!-- injection-hop-table:begin — generated by `run.py --write-doc-table`; do not edit by hand -->
| Hop | Control | Cases | Exercised | Uninstrumented |
|---|---|---|---|---|
| ① normalize | `clean_text` + 400-line / 400-char caps | 4 | 4 | 0 |
| ② distill | curator turn, `sessionTarget: isolated` | 1 | 0 | 1 |
| ③ schema | `brief_violation` + `resolve_evidence` | 19 | 19 | 0 |
| ③b cross-check | `source_reads_imperative` — the sealer's own second opinion | 5 | 5 | 0 |
| — (reaches cell 3) | nothing — reaches cell 3 (intended) | 5 | 5 | 0 |
<!-- injection-hop-table:end -->

**These are coverage counts, not a protection rate.** They say how many cases each control answered. They do not say what fraction of real-world payloads the architecture stops, and there is deliberately no total and no percentage: a single "N of M blocked" figure scores a pipeline where four independent controls each catch their own class identically to one where a single control catches everything and the other three are dead code. The second is one config change away from wide open and its aggregate looks perfect right up until it doesn't.

What makes the counts mean anything is that a case fails if it is stopped **at the wrong hop or for the wrong cause**, even when it is stopped. A defence you believe is at hop ③ but is really only at hop ① is a defence you will delete by accident.

Read the table with four caveats:

- **Two of the four hops are unmeasured.** Hop ② needs a live curator model turn and SKIPs; a SKIP is not a pass. Hop ④ (routing between `briefs/` and `briefs-flagged/`) contributes no cases at all — the probe exists in `harness.py` but nothing calls it.
- **The `— (reaches cell 3)` row is not a failure count.** Those are cases asserting that something *should* cross the gate, including plain-English prose injection, which hop ① passes through by design. That row starting to shrink would mean someone taught the airlock to censor prose, which is a semantic control in the one place this design says there must not be one.
- **Hop ③ carries most of the weight**, which is the same thing the prompt-injection note at the top of this file admits: it is one barrier, deterministic and small, and not a guarantee.
- **Nothing here measures model-level injection resistance**, and no arrangement of these numbers would.

One known gap is recorded as a passing case rather than hidden: entity-encoded markup survives hop ① intact, because `clean_text()` strips tags before it unescapes entities. Details and the fix in [the suite's README](openclaw-enclave/scripts/tests/injection/README.md).

## Verify it yourself

### Static, no Docker required

Copy each `openclaw.example.json` to `openclaw.json` first.

```bash
python3 tools/enclave-check/check.py -v
python3 openclaw-enclave/scripts/tests/injection/run.py
```

### With the stack up

Each command should fail, or return the stated value. If one doesn't, that's a bug and I want to know.

```bash
# Root filesystem is read-only. Expect: "Read-only file system"
docker exec openclaw touch /test_file

# All capabilities dropped. Expect: [ALL]
docker inspect openclaw --format='{{.HostConfig.CapDrop}}'

# Read-only rootfs is actually set. Expect: true
docker inspect openclaw --format='{{.HostConfig.ReadonlyRootfs}}'

# no-new-privileges is applied. Expect: no-new-privileges:true in the list.
# This is the real escalation test. `sudo su` failing only proves sudo is absent.
docker inspect openclaw --format='{{.HostConfig.SecurityOpt}}'

# Docker socket is absent. Expect: "No such file or directory"
docker exec openclaw ls -l /var/run/docker.sock

# THE CORE INVARIANT. Main cannot see raw or normalized. Expect: no output
docker inspect openclaw --format='{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' \
  | grep -E 'exchange/(raw|normalized)'

# Sealer has no network at all. Expect: none
docker inspect quarantine-sealer --format='{{.HostConfig.NetworkMode}}'

# Curator has no route off-box. Expect: timeout, not a response
docker exec openclaw-curator sh -c 'curl -m 3 https://example.com 2>&1'

# Scout cannot see main's secrets file. Expect: no such file
docker exec openclaw-scout ls /run/secrets/openclaw_secrets 2>&1

# Gateway is not on the LAN. Run from a DIFFERENT machine. Expect: refused or timeout
curl -m 3 http://<your-lan-ip>:18789
```

## Updates

```bash
cd openclaw-docker-config
# review Dockerfile digests, then:
docker compose build --pull=false
docker compose up -d
```

Do not treat an unpinned `:latest` pull as a security update strategy for this repo. See the pinning note at the top of this file.