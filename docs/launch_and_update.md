# Launch and Update

Force-recreate the OpenClaw containers after a configuration or image update.

---

## Update and Restart

```bash
cd ~/openclaw/openclaw-docker-config
docker-compose up -d --build --force-recreate
```

| Step | What Happens |
|------|-------------|
| `--build` | Rebuilds the image if `Dockerfile.openclaw` has changed |
| `--force-recreate` | Recreates containers, applying any `docker-compose.yml` changes |
| `-d` | Runs in detached mode (background) |

The containers boot with all security boundaries applied immediately — no additional configuration required.
