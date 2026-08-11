# Cell config: curator

The schema sets `additionalProperties: false` at the root, so a `_comment`
key is rejected by `openclaw config validate`. The rationale lives here
instead of inside the JSON.

CELL 2 — curator. The strictest cell in the system. It reads hostile text (normalized quarantine) and must therefore be assumed compromised, so its container has NO route off-box except the local Qwen inference endpoint, and it holds no credential of any kind beyond its own gateway token. It has no web tools to deny because none are granted, and no mcp.servers block at all. /home/node/exchange/raw is not mounted here — it only ever sees text the deterministic sealer has already passed through clean_text() and capped. Mounted :ro.

Subagent delegation is not disabled via `delegationMode` (the only legal
values are `suggest` and `prefer`). It is disabled by simply never granting
`sessions_spawn` or `subagents` in this agent's `tools.allow`, which is the
stronger form anyway: the capability is absent rather than discouraged.
