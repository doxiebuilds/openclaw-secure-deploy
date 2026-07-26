# Security

## Reporting Vulnerabilities

Found a security issue? **Don't open a public issue.** Email the maintainer with:
- What you found
- How to reproduce it
- Which component is affected
- The impact
- Any suggested fix

We'll acknowledge it and work on a fix.

---

## How Security Works

This deployment is built on a **zero-trust model** with multiple hardened layers to ensure OpenClaw cannot escape its sandbox or modify the host system.

### Container Isolation

- **Read-only root filesystem** — the container cannot modify system binaries, libraries, or installed packages at runtime.
- **Capabilities dropped** — all Linux capabilities (`CapDrop: ALL`) are removed at startup. The container runs with zero privileges.
- **No privilege escalation** — `no-new-privileges:true` ensures `sudo` and similar commands fail immediately.
- **Non-root user** — OpenClaw runs as the `node` user, never as root.

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
- **Loopback only** — port 18789 is bound to `127.0.0.1` only (localhost). Not accessible from the network.
- **External DNS** — uses Cloudflare and Google DNS. Cannot reach the host's DNS or internal network services.

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

### What OpenClaw Can Do (Safe)
✅ Execute code in isolated sandbox containers  
✅ Read/write to designated workspace directories  
✅ Access external services via network (DNS, HTTP)  
✅ Manage its own sandbox container lifecycle  

### What OpenClaw Cannot Do (Protected)
❌ Modify host filesystem outside enclave  
❌ Escalate privileges or gain root access  
❌ Execute arbitrary commands on the host  
❌ Access other containers or volumes  
❌ Modify network configuration  
❌ Access Docker daemon directly (all access mediated)  

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
