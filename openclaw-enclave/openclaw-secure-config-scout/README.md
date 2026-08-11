# Cell config: scout

The schema sets `additionalProperties: false` at the root, so a `_comment`
key is rejected by `openclaw config validate`. The rationale lives here
instead of inside the JSON.

CELL 1 — scout. Hostile content in, egress out, nothing worth stealing. This is the ONLY cell with a route to the public internet, and it reaches it through scout-egress-proxy with a strict host allowlist. It holds no Slack token, no Linear OAuth and no frontier-model credential: hostile content never reaches a paid provider and a compromised scout cannot burn credit. /home/node/projects is not mounted here at all. Mounted :ro; the agent can edit neither this file nor the guard it names.

Subagent delegation is not disabled via `delegationMode` (the only legal
values are `suggest` and `prefer`). It is disabled by simply never granting
`sessions_spawn` or `subagents` in this agent's `tools.allow`, which is the
stronger form anyway: the capability is absent rather than discouraged.
