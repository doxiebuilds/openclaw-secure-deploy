# Security Verification

Confirm that the OpenClaw container is properly isolated, cannot read or write outside its enclave, and cannot escalate its privileges.

---

## Read-Only Root Filesystem

Attempt to write to the container's root directory. This should fail with a "Read-only file system" error.

```bash
docker exec openclaw touch /test_file
```

The container cannot modify system binaries or install packages at runtime.

---

## Privilege Escalation

Attempt to escalate to root. This is blocked by `no-new-privileges:true` and the complete capability drop.

```bash
docker exec openclaw sudo su
```

The command fails — either with "command not found" (if `sudo` is absent) or with a permission denial.

---

## Capability Drops

Verify that all Linux capabilities have been dropped:

```bash
docker inspect openclaw --format='{{.HostConfig.CapDrop}}'
```

| Expected Output | Meaning |
|----------------|---------|
| `[ALL]` | Every capability is dropped — the container runs with zero privileges |

---

## Enclave Restrictions

Inspect the volume mounts to confirm the container only reaches its designated directories:

```bash
docker inspect openclaw --format='{{json .Mounts}}' | jq .
```

| Mount Path | Expected RW | Purpose |
|-----------|-------------|---------|
| `/home/node/.openclaw/openclaw.json` | `false` | Config is read-only — OpenClaw cannot modify its own configuration |
| `/home/node/scripts` | `false` | Operational scripts are read-only |
| `/home/node/.openclaw/workspace` | `true` | The only folder OpenClaw can freely write to |

No host directories outside `openclaw-enclave` (except the explicitly allowed projects folder) should appear.

---

## Docker Socket Isolation

Confirm the container has no direct access to the host Docker socket:

```bash
docker exec openclaw ls -l /var/run/docker.sock
```

| Expected Output | Meaning |
|----------------|---------|
| `No such file or directory` | The socket is not mounted — all Docker API calls go through the secure proxy |

---

## No Broader Host Access

Confirm that the container cannot see arbitrary host paths outside its designated enclave:

```bash
docker compose exec openclaw ls /Users
```

This should say `No such file or directory` — and that is the correct result. It confirms the container does not have broader access to the host filesystem.
