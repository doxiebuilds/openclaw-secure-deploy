# OpenClaw Secure Deployment

A highly secure, zero-trust deployment environment for OpenClaw using Docker.

All execution happens in an isolated Docker enclave. The host system is protected by strict container boundaries — the container cannot escape, modify host files, or escalate privileges.

---

## How the Zero-Trust Model Works

This deployment uses multiple layers of isolation to ensure OpenClaw operates safely:

1. A dedicated `openclaw-enclave` directory is created on the host.
2. The OpenClaw container is launched with a `read_only: true` root filesystem.
3. The container's capabilities are completely dropped (`CapDrop: ALL`), and privilege escalation is blocked (`no-new-privileges:true`).
4. Docker socket access is never granted directly. Instead, a `docker-socket-proxy` mediates communication.
5. The proxy explicitly blocks dangerous operations (like exec, volumes, and networks manipulation) while allowing OpenClaw to manage its sandbox containers.
6. Only the designated `workspace` folder is mounted as read-write.

The container is architecturally incapable of modifying the host system or accessing sensitive host configuration files.

---

## Security Details

| Parameter | Value |
|-----------|-------|
| Root Filesystem | Read-only (`read_only: true`) |
| Privilege Escalation | Blocked (`no-new-privileges:true`) |
| Linux Capabilities | Dropped (`CapDrop: ALL`) |
| Docker API Access | Mediated via `docker-socket-proxy` |
| Proxy Restrictions | Exec, Volumes, Networks, System, Auth blocked |
| Writable Scope | Restricted to `openclaw-enclave/workspace` |
| Network | Isolated `openclaw-internal` |

---

## Quick Start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine) must be installed and running.
- **LMStudio**: By default, this setup is built to use [LMStudio](https://lmstudio.ai/) running locally with the **Qwen 3.6 35B (a3b)** model. However, this is fully customizable—you can change the model or connect to a different LLM provider by editing your `openclaw.json` configuration.

### Setup and Run

1. Run the bootstrap script to create the necessary directories with correct permissions:
   ```bash
   ./setup.sh
   ```
2. Edit the generated `.env` file and insert your API keys and tokens.
3. Launch the secure environment (this automatically downloads and installs OpenClaw):
   ```bash
   cd openclaw-docker-config
   docker-compose up -d --build
   ```

No `sudo` is required to run the setup script. The environment boots with strict boundaries applied immediately.

### Documentation

For lifecycle management, refer to the detailed docs:
- [Launch and Update](docs/launch_and_update.md)
- [Shutdown Instructions](docs/shutdown.md)
- [Security Verification](docs/security_verification.md)
