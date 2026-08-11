# OpenClaw Control Plane

Fleet UI and API for managing the multi-cell OpenClaw enclave in this monorepo.

OpenClaw Gateways remain the source of truth for runtime, cron, configuration, and
approval enforcement. This control plane is a projection / operator layer.

## See the UI

### Prerequisites

1. Enclave stack running (`openclaw`, `openclaw-scout`, `openclaw-curator`)
2. Docker available to the control-plane API process
3. Node.js 20+

### Run (two terminals)

```bash
cd control-plane
npm install

# once per clone: pair this clone's Ed25519 device identity with each gateway
# (needs the enclave up and docker exec; re-running is safe)
node scripts/bootstrap/pair-control-plane.mjs

# terminal 1
npm run dev:api

# terminal 2
npm run dev:web
```

Skip the pairing step and every gateway shows **offline**. The identity lives at
`data/device-identity.json` (0600, gitignored) and is created on first use.

Open **http://127.0.0.1:5173/**  
Login: **`admin` / `admin`** (change via `CONTROL_PLANE_PASSWORD`)

### Features

- Dashboard, gateways, agents, sessions (chat + timeline)
- Approvals (exec + research requests)
- Automations (list / enable / disable / run / history)
- Configuration (snapshot / propose / apply / rollback on **host** files)
- Exchange pipeline visibility
- Security (enclave-check, check-approvals, posture)
- Audit (filter, integrity chain)

Native Control UIs: main `:18789`, scout `:18829`, curator `:18869`

## Quality

```bash
npm run typecheck
npm run test
npm run smoke    # API must already be running
bash scripts/bootstrap/probe.sh
```

## Architecture notes

### Source of truth

| Concern | Owner |
| --- | --- |
| Runtime / cron / exec approvals | OpenClaw Gateway |
| Config file | Host `openclaw.json` (RO in container) |
| Fleet projections / CP audit / RBAC | Control plane |

### Layout

```text
control-plane/
├── apps/api
├── apps/web
├── packages/domain
├── packages/gateway-client
├── scripts/bootstrap
└── scripts/smoke.sh
```
