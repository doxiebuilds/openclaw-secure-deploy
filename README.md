# OpenClaw Secure Deployment

A zero-trust Docker setup for running [OpenClaw](https://github.com/openclaw) in an isolated sandbox. The idea is simple: an autonomous agent can do its thing, and even if it goes off the rails, it can't touch the host system.
 
This is a personal project, built to learn how to use OpenClaw in a reasonably safe environment.
 
Everything runs inside a locked-down Docker container. It can't escape, can't modify host files, can't escalate privileges.

---

## 🤝 Contributing

Issues and pull requests are limited to collaborators. If you're not one, use Discussions to share feedback, suggestions, or bugs — I'll fold in what makes sense.

---

## ⚠️ Disclaimer
 
This hasn't been through a professional security audit — I built it solo for personal use. It is expected to cut down the blast radius of a compromised or misbehaving agent, but it's not bulletproof — think defense in depth, not a guarantee.
 
**It doesn't protect against prompt injection.** The isolation locks down what the *container* can do to your host, not what the agent can be tricked into doing. If it processes a malicious webpage, email, or file, it can still misuse the credentials it holds (API keys, Slack tokens) or damage anything inside its writable `workspace` — outbound network access is intentionally open for things like web search.
 
**On LAN exposure:** as configured, the gateway (port `18789`) is bound to `127.0.0.1` only, and the internal Docker network is not supposed to be reachable from the host or LAN. So out of the box, nothing is supposed to be exposed to your local network. That changes if you rebind the port (e.g. to `0.0.0.0`) or expose it some other way — check your config if you're doing anything nonstandard and perform appropriate testing to confirm LAN exposure.
 
**Not a silver bullet.** It can't defend against unknown vulnerabilities in OpenClaw itself, the OS, Docker, or its dependencies, and it's not a substitute for a real security audit. If you're putting this near production systems or real assets, get it independently assessed and perform appropriate testing.
 
**Versioning.** These protections are tied to the OpenClaw and Docker versions this repo was built against. Future versions may change what's needed or introduce native mechanisms that overlap or conflict with this config — check compatibility against what you're actually running.
 
**AI model.** This personal project cannot protect against broad unexpected behavior tied to the LLM models, skills, tools, and other components being used, which could result in security gaps.
 
The contributor(s) of this repository take no liability for direct or indirect losses from using this project, or from an AI agent misinterpreting or misusing it — data loss, service disruption, configuration corruption, security exposure, credential leakage, whatever. If you use it, you accept the risk that comes with running an autonomous agent.
 
Review the config and code yourself before trusting it with real credentials. Don't run it against anything you can't afford to lose. Use at your own risk, and independent review is welcome — see [SECURITY.md](SECURITY.md) to report issues. Not affiliated with or endorsed by the OpenClaw maintainers.

---

## How the zero-trust model works
 
A few layers of isolation stack together here:
 
1. A dedicated `openclaw-enclave` directory gets created on the host.
2. The OpenClaw container runs with a read-only root filesystem (`read_only: true`).
3. All Linux capabilities are dropped (`CapDrop: ALL`), and privilege escalation is blocked (`no-new-privileges:true`).
4. The container never touches the Docker socket directly — a `docker-socket-proxy` mediates every request instead.
5. That proxy blocks the dangerous stuff (exec, volume/network manipulation) while still letting OpenClaw manage its own sandbox containers.
6. Only one folder, `workspace`, is mounted read-write. Everything else is off-limits.

Put together, these controls are designed so the container can't modify the host or reach sensitive host config through normal operation — not just discouraged from it, enforced by the kernel and container runtime. (An unpatched container-escape vulnerability could bypass this — see the disclaimer above.)

---

## Security details
 
| Parameter | Value |
|-----------|-------|
| Root Filesystem | Read-only (`read_only: true`) |
| Privilege Escalation | Blocked (`no-new-privileges:true`) |
| Linux Capabilities | Dropped (`CapDrop: ALL`) |
| Docker API Access | Mediated via `docker-socket-proxy` |
| Proxy Restrictions | Exec, Volumes, Networks, System, Auth blocked |
| Writable Scope | Restricted to `openclaw-enclave/workspace` |
| Network | Isolated `openclaw-internal` |
 
See [SECURITY.md](SECURITY.md) for the full policy and how to report issues.
 
---

## Quick Start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine), installed and running.
- **LMStudio**: this setup defaults to [LMStudio](https://lmstudio.ai/) running locally with the **Qwen 3.6 35B (a3b)** model. Swap it out anytime — point it at a different model or provider by editing `openclaw.json`.

### Setup and Run

1. Run the bootstrap script to create the necessary directories with correct permissions:
```bash
   ./setup.sh
```
2. Edit the generated `.env` file and drop in your API keys and tokens.
3. Launch the secure environment — this also pulls and installs OpenClaw automatically:
```bash
   cd openclaw-docker-config
   docker-compose up -d --build
```
 
No `sudo` needed. The boundaries are in place the moment it boots.
 
### Documentation

For day-to-day lifecycle management:

- [Launch and Update](docs/launch_and_update.md)
- [Shutdown Instructions](docs/shutdown.md)
- [Security Verification](docs/security_verification.md)
 