# Shutdown

Safely stop the OpenClaw container and its associated services.

---

## Full Shutdown

Stops and removes the containers, networks, and volumes:

```bash
cd ~/openclaw/openclaw-docker-config
docker-compose down
```

All security boundaries are cleanly torn down. No orphan processes remain on the host.

## Pause (Keep Containers)

Stops the containers without removing them — useful for temporary maintenance:

```bash
cd ~/openclaw/openclaw-docker-config
docker-compose stop
```

Restart later with `docker-compose start`.
