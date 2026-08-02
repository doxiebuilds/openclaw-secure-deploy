# Security

## Reporting a vulnerability

Don't open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/doxiebuilds/openclaw-secure-deploy/security/advisories/new), which opens a draft advisory only the maintainer can see. No email needed.

Useful reports include what you found, how to reproduce it, which component is affected, and what an attacker gets out of it. A suggested fix is welcome but not required.

One person maintains this in their spare time, so there is no response SLA. I read every report and I'd rather hear about a problem late than not at all.

## Two things worth knowing before you read the rest

Both of these weaken the claims further down. They go first so nobody has to find them.

**The socket proxy runs privileged.** Everything in this repo drops privileges except `docker-socket-proxy`, which runs with `privileged: true`. That is a broader grant than any other container here. Two things narrow it: the proxy isn't reachable from the host or the LAN, and its allowed API surface is restricted to container start/stop and image inspection. But if that specific container were compromised, it has more reach than the "zero privileges" language elsewhere implies. It is the softest part of this design and I haven't found a way to remove it while keeping OpenClaw able to manage its own sandboxes.

**Images are pinned to `:latest`.** `ghcr.io/openclaw/openclaw:latest` and `tecnativa/docker-socket-proxy:latest` are both unpinned. That means you get security patches automatically, and it also means you cannot reproduce a known-good build, cannot verify what you're actually running, and inherit whatever ships upstream. If you're running this anywhere that matters, pin both to a digest.

## What this does not protect against

Not an exhaustive list. These are the categories that matter most.

**Prompt injection.** Everything here hardens the container against the host. None of it hardens the agent against being tricked. If OpenClaw processes a malicious webpage, email, or file, it will follow instructions embedded in that content, and it can then misuse any credential it holds (API keys, Slack tokens) or wreck anything in its writable `workspace`. Both outbound network access and workspace write access have to stay open for the agent to do useful work, so this gap is structural rather than an oversight.

**Unknown vulnerabilities.** A container escape in the kernel, Docker, containerd, or runc bypasses every control below. Same for a bug in OpenClaw itself or in any skill, tool, or dependency it loads.

**Anything resembling production.** Built for personal single-user use, never professionally audited. If this is going near real systems or real assets, get it independently assessed first.

## What is enforced

Every control below is enforced by the kernel or the container runtime. None of it depends on the agent choosing to cooperate.

### Container

| Control | Setting | Effect |
|---|---|---|
| Read-only root | `read_only: true` | System binaries, libraries, and packages cannot be modified at runtime |
| Capabilities | `cap_drop: ALL` | Zero Linux capabilities at startup |
| Escalation | `no-new-privileges:true` | `sudo` and setuid binaries fail immediately |
| User | runs as `node` | Never root, even inside the container |

Exception: the socket proxy, covered above.

### Docker API

The container never touches `/var/run/docker.sock`. Every call goes through `docker-socket-proxy`.

Denied at the proxy: `EXEC`, `VOLUMES`, `NETWORKS`, `SYSTEM`, `AUTH`, `SWARM`.
Allowed: container start/stop, image inspection. Nothing else.

That combination is what stops OpenClaw from running commands on the host or reaching other containers, while still letting it manage its own sandbox lifecycle.

### Filesystem

Writable: `openclaw-enclave/workspace`, and the projects folder with controlled read-write access.
Read-only: `openclaw.json`, all scripts, everything else in the enclave.
Invisible: any host path outside the enclave.

### Network

The container sits on an isolated `openclaw-internal` network. The gateway on port `18789` is bound to `127.0.0.1`, so it should not answer from anywhere but the local machine. Don't take that on faith, scan it from another device (command below).

DNS resolves through Cloudflare and Google rather than the host resolver, so the container cannot reach internal network services by name. Note that this also sends every lookup to a third party.

Outbound internet access is open on purpose. Web search and any hosted model provider need it. It is also the channel a compromised agent would use to send data out, which is the tradeoff being made rather than a detail that got missed.

**To cut outbound access entirely:** mark the `default` network in `docker-compose.yml` as `internal: true`, matching what `openclaw-internal` already does, or remove that network attachment. You get a fully offline agent, and you give up web search and every non-local provider, leaving you on a local model such as LM Studio. Test afterwards, because parts of OpenClaw assume connectivity exists.

## Verify it yourself

Each command below should fail, or return the stated value. If one doesn't, that's a bug and I want to know.

```bash
# Root filesystem is read-only.  Expect: "Read-only file system"
docker exec openclaw touch /test_file

# Privilege escalation is blocked.  Expect: command not found, or permission denied
docker exec openclaw sudo su

# All capabilities dropped.  Expect: [ALL]
docker inspect openclaw --format='{{.HostConfig.CapDrop}}'

# Read-only rootfs is actually set.  Expect: true
docker inspect openclaw --format='{{.HostConfig.ReadonlyRootfs}}'

# no-new-privileges is applied.  Expect: no-new-privileges:true in the list
docker inspect openclaw --format='{{.HostConfig.SecurityOpt}}'

# Docker socket is absent.  Expect: "No such file or directory"
docker exec openclaw ls -l /var/run/docker.sock

# Gateway is not on the LAN.  Run from a DIFFERENT machine.  Expect: connection refused or timeout
curl -m 3 http://<your-lan-ip>:18789
```

Longer walkthrough in [docs/security_verification.md](docs/security_verification.md).

## Secrets

Never commit secrets to this repository.

`.env` holds your real credentials and is gitignored, so it will not be pushed. Only `.env.example`, with placeholders, is version controlled. Fill in `.env` before your first run, rotate tokens on whatever schedule you'd use for any other credential, and keep file permissions tight.

Worth repeating: the isolation here does nothing to stop a manipulated agent from using these keys as intended. Give it the narrowest-scoped tokens that still let it work.

## Updates

```bash
docker compose pull
docker compose up -d --build
```

This pulls whatever `:latest` currently points at for both images. See the pinning note at the top of this file before relying on that.