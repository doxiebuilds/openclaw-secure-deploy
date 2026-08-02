# OpenClaw Secure Deployment

Runs [OpenClaw](https://github.com/openclaw) inside a Docker container with almost every privilege removed. Personal project, no security audit.

An autonomous agent is useful because it runs commands without asking you first. That is also the entire problem. The property you want and the property that should worry you are the same property, and no amount of prompting removes it.

So this project doesn't try to make the agent trustworthy. It assumes the agent will eventually do something you didn't intend, through a bug, a bad model day, or a webpage that told it to, and asks a narrower question:

**When that happens, how much can it reach?**

The answer here is: one directory, plus whatever credentials you handed it. That second half is not a small caveat, so it goes before anything else.

## What this does not stop

**Prompt injection.** The container is a wall between the agent and your host. It is not a wall between the agent and its own instructions. If OpenClaw reads a malicious webpage, email, or file, it still holds every API key and token in your `.env`, and it can still use them exactly as you could. Outbound network access is open on purpose, because web search doesn't work without it. Nothing in this repo addresses that.

If you take one thing from this README, take that one.

Also out of scope:

- Container escape via an unpatched Docker, kernel, or runtime vulnerability
- Vulnerabilities in OpenClaw itself, or in any skill, tool, or dependency it loads
- Anything the agent does to files inside its own writable `workspace`, which is disposable by design
- Model-level surprises. A different model, a new skill, or a tool with its own network access changes the picture and this config won't know

What's left after all of that is still worth having. It just isn't a guarantee, and a README that implied otherwise would be the wrong kind of document.

## The principle: cut authority, don't extend trust

A capable agent holding almost no privileges is safer than a limited agent holding all of them. Capability is hard to predict. Authority is a config file.

So every control here is enforced by the kernel or the container runtime, never by the agent's cooperation. The agent is not asked to stay inside the boundary. It cannot reach the edge of it.

That's the whole idea. Everything below is implementation.

## Threat model

Assumed possible:

- The agent executes commands you did not intend
- The agent processes hostile input and follows it
- The agent tries to write outside its workspace
- The agent tries to use the Docker API beyond what it needs

Assumed out of reach: bugs in Docker, the host OS, OpenClaw, or the model. Those belong to the section above, not to the design.

## What follows from that

| Objective | Mechanism |
|---|---|
| No writes to system files | Read-only root filesystem (`read_only: true`) |
| No privilege escalation | `no-new-privileges:true` |
| No kernel privileges at all | All Linux capabilities dropped (`cap_drop: ALL`) |
| No direct Docker socket | Every call mediated by `docker-socket-proxy` |
| Narrow Docker surface | `EXEC`, `VOLUMES`, `NETWORKS`, `SYSTEM`, `AUTH` all denied at the proxy |
| One writable path | `openclaw-enclave/workspace`, nothing else |
| No host or LAN reachability | Dedicated internal network, gateway bound to `127.0.0.1:18789` |

Six mechanisms, one objective each. Bypassing one shouldn't hand you the others. That's the only reason there are six instead of two.

**On the gateway binding.** `127.0.0.1:18789` means local machine only. Rebind it to `0.0.0.0` and you have published an agent control plane to your network. If you change the networking config, the exposure is yours to verify.

## Verify it yourself

Don't take the table on faith. Every claim in it is checkable in about a minute:

```bash
# Capabilities should be empty
docker inspect openclaw --format '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}}'

# Root filesystem should be read-only
docker inspect openclaw --format '{{.HostConfig.ReadonlyRootfs}}'

# Writes outside workspace should fail
docker exec openclaw sh -c 'touch /etc/proof 2>&1'

# The gateway should not answer on your LAN IP
curl -m 3 http://<your-lan-ip>:18789
```

Longer walkthrough in [docs/security_verification.md](docs/security_verification.md). If one of these doesn't behave as documented, that's a bug and I want to know.

## Quick start

Requires Docker Desktop or Docker Engine. Defaults to [LM Studio](https://lmstudio.ai/) running locally with **Qwen 3.6 35B (A3B)**. Point `openclaw.json` at any other model or provider if you prefer.

```bash
./setup.sh                       # creates the enclave directories with the right permissions
# edit the generated .env with your keys
cd openclaw-docker-config
docker compose up -d --build     # pulls and installs OpenClaw
```

No `sudo` anywhere. The boundaries exist from first boot, not after a hardening step you might forget.

Day-to-day: [launch and update](docs/launch_and_update.md) · [shutdown](docs/shutdown.md) · [security verification](docs/security_verification.md)

## Versioning

These controls are tied to the versions this was built against: OpenClaw `<version>`, Docker `<version>`, `docker-socket-proxy` `<version>`. Later versions may add native isolation that overlaps or conflicts with this config. Check what you're actually running.

## Contributing

Issues and PRs are limited to collaborators. Everyone else, open a Discussion. Feedback and independent review are genuinely welcome, and I'll fold in what makes sense. Security reports go through [SECURITY.md](SECURITY.md).

## Disclaimer

Personal project, built solo, never professionally audited. It reduces the authority available to an OpenClaw deployment. It does not eliminate risk, and the prompt-injection gap above is real and unaddressed.

No liability is accepted for any loss arising from use of this project or from an agent misinterpreting it: data loss, service disruption, credential leakage, or anything else. Read the config before you trust it with real keys. Don't point it at anything you can't afford to lose.

Not affiliated with or endorsed by the OpenClaw maintainers.