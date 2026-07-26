# Security

## Reporting Vulnerabilities

Found a security issue? **Don't open a public issue.** Use GitHub's [private vulnerability reporting](https://github.com/doxiebuilds/openclaw-secure-deploy/security/advisories/new) instead — it opens a draft security advisory that only the maintainer can see, no email required. Include:
- What you found
- How to reproduce it
- Which component is affected
- The impact
- Any suggested fix

We'll acknowledge it and work on a fix.

---

## How Security Works

This deployment is built on a **zero-trust model** with multiple hardened layers to make sure OpenClaw can't escape its sandbox or modify the host system. This file describes the mechanism — for what it doesn't cover, see [What This Doesn't Protect Against](#what-this-doesnt-protect-against) below and the [README disclaimer](README.md#%EF%B8%8F-disclaimer).

### Container Isolation

- **Read-only root filesystem** — the container cannot modify system binaries, libraries, or installed packages at runtime.
- **Capabilities dropped** — all Linux capabilities (`CapDrop: ALL`) are removed at startup. The container runs with zero privileges.
- **No privilege escalation** — `no-new-privileges:true` ensures `sudo` and similar commands fail immediately.
- **Non-root user** — OpenClaw runs as the `node` user, never as root.
- **Exception: the socket proxy runs privileged.** `docker-socket-proxy` itself runs with `privileged: true`, a broader grant than anything above. It isn't reachable from the host or LAN (see Network Isolation), and its allowed operations are tightly restricted (below) — but if that specific container were ever compromised, `privileged: true` gives it more reach than the rest of this section implies.

### Docker API Mediation

- **Socket proxy** — the container never touches `/var/run/docker.sock` directly. All Docker API calls pass through `docker-socket-proxy`.
- **Blocked operations** — the proxy explicitly forbids exec, volumes, networks, system, auth, and swarm operations.
- **Allowed operations** — only container start/stop and image inspection are permitted.

This prevents OpenClaw from executing commands on the host or accessing other containers.

### Filesystem Isolation

- **Config is read-only** — `openclaw.json` and scripts cannot be modified.
- **Workspace is writable** — only `openclaw-enclave/workspace` is mounted read-write.
- **Projects are accessible** — the projects folder has controlled read-write access.
- **No host access** — the container cannot see or reach paths outside the enclave.

### Network Isolation

- **Internal network** — the container runs on an isolated `openclaw-internal` network, separate from the host.
- **Loopback only** — port 18789 is bound to `127.0.0.1` only (localhost). It's not supposed to be reachable from the LAN. If you want to confirm rather than take that on faith, scan the port from another device on your network.
- **External DNS** — uses Cloudflare and Google DNS. Cannot reach the host's DNS or internal network services.
- **Outbound access is intentionally open** — the container can reach the internet (web search, API calls, etc). That's required for OpenClaw to function, but it's also the channel a compromised or manipulated agent would use to send data out. See below.
- **Want to cut off internet access entirely?** Mark the `default` network in `docker-compose.yml` as `internal: true` (same as `openclaw-internal` already is), or remove that network attachment altogether. That gets you a fully offline agent, at the cost of web search and any non-local LLM provider — you'd be limited to a fully local model (e.g. LMStudio) with no outbound calls at all. Test carefully after making this change, since other parts of OpenClaw may assume outbound connectivity is available.

---

## What This Doesn't Protect Against

This list is not exhaustive — the three points below are examples of what's out of scope, not the full set.

Everything above hardens the *container* against the host. None of it hardens the *agent* against being tricked.

- **Prompt injection.** If OpenClaw processes a malicious webpage, email, or file, none of this isolation stops it from following instructions embedded in that content. A successfully injected agent can still misuse whatever credentials it holds (API keys, Slack tokens) or damage anything inside its writable `workspace` — outbound network access and workspace write access both have to stay open for the agent to work at all.
- **Unknown vulnerabilities.** This doesn't defend against undiscovered bugs in OpenClaw itself, the host OS, Docker/containerd/runc, or any dependency. A container-escape vulnerability at the kernel or runtime level would bypass everything above.
- **Production use.** This was built for personal, single-user use, not audited as a product. It isn't a substitute for a professional security review — if you're running this near production systems or real assets, get it independently assessed.

---

## Security Verification

For detailed verification steps and audit commands, see [docs/security_verification.md](docs/security_verification.md).

Run these commands to verify the container's security posture:

```bash
# Verify read-only filesystem
docker exec openclaw touch /test_file

# Verify privilege escalation is blocked
docker exec openclaw sudo su

# Verify all capabilities are dropped
docker inspect openclaw --format='{{.HostConfig.CapDrop}}'

# Verify docker socket is not accessible
docker exec openclaw ls -l /var/run/docker.sock
```

---

## Security Considerations

### What OpenClaw Can Do

✅ Execute code in isolated sandbox containers
✅ Read/write to designated workspace directories
⚠️ Access external services via network (DNS, HTTP) — required for it to function, and also the exfiltration path if it's ever compromised or manipulated (see [What This Doesn't Protect Against](#what-this-doesnt-protect-against))
✅ Manage its own sandbox container lifecycle

### What OpenClaw Cannot Do (assuming the isolation holds)

❌ Modify host filesystem outside enclave  
❌ Escalate privileges or gain root access  
❌ Execute arbitrary commands on the host  
❌ Access other containers or volumes  
❌ Modify network configuration  
❌ Access Docker daemon directly (all access mediated)  

These assume the container boundary itself isn't broken by an unknown vulnerability, and say nothing about what the agent can be tricked into doing with the access it's supposed to have. See [What This Doesn't Protect Against](#what-this-doesnt-protect-against).

---

## Secrets

**Never commit secrets to this repository.**

- `.env` contains your actual credentials and is gitignored — it will never be pushed.
- Only `.env.example` with placeholder values is version-controlled.
- Before running, fill in your `.env` file with real tokens and API keys.
- Rotate tokens regularly and keep `.env` access restricted to your system.

---

## Keeping Security Updated

The base images are regularly patched for security vulnerabilities:

- `ghcr.io/openclaw/openclaw:latest` — updated for security patches
- `tecnativa/docker-socket-proxy:latest` — official maintained image

Pull the latest images and rebuild:

```bash
docker compose pull
docker compose up -d --build
```

---

## More Information

For detailed security verification steps, see [docs/security_verification.md](docs/security_verification.md).

For how the zero-trust model works, see the [README.md security details](README.md#security-details).

For what this project doesn't cover, see the [README disclaimer](README.md#%EF%B8%8F-disclaimer).