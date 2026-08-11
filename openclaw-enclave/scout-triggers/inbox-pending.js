// inbox-pending.js — the condition script for scout's research-request job.
//
// THIS FILE IS JAVASCRIPT, AND THAT IS THE WHOLE POINT OF ITS EXISTENCE.
// `openclaw cron add --trigger-script` does not run a program. It snapshots this
// text into the job and evaluates it in code mode, as `openclaw-code-mode:user.js`,
// in a QuickJS-WASI worker. Its predecessor here was `inbox-pending.sh`, a POSIX
// sh script complete with `#!/bin/sh` — which is a syntax error the moment it is
// parsed as JS ("invalid first character of private name", from the `#`). It
// never ran once. All 95 evaluations between the job's registration on
// 2026-08-02 and its repair on 2026-08-05 failed identically, cron backed the
// schedule off from 5m to 1h, and a human-approved request sat unread in inbox/
// for three days while `docker ps` showed everything healthy.
//
// So: no shebang, no `#` comments, and nothing in here may assume a shell.
//
// WHAT A CONDITION SCRIPT OWES THE SCHEDULER. Exactly one thing, through
// `json()`: `{ fire, message?, state? }`. `fire: true` spends a model call,
// `false` reschedules without one. Budget is 30s wall-clock and 5 tool calls.
//
// WHY IT DOES SO LITTLE. It used to do the enumeration too, and it cannot: this
// runs under scout's tool policy, and scout denies `exec` — permanently and
// correctly, being the one cell that reads hostile web pages. Without `exec`
// there is no way to list a directory, because OpenClaw ships no glob, ls or
// find tool either. That is the same wall that killed three supervised curator
// runs on 2026-08-02 (read(dir) -> EISDIR, read(dir/*) -> ENOENT, give up).
//
// Enumeration therefore happens in quarantine-seal.sh, which already computes
// exactly this kind of manifest twice — PENDING.txt for the curator, INDEX.txt
// for cell 3 — and which is the only process holding inbox/, raw/, normalized/
// and briefs/ at once, so it is the only one that can tell what is genuinely
// outstanding rather than infer it. All that is left here is reading its answer.
//
// THE ONE-REQUEST-PER-TICK RULE IS NOT ENFORCED HERE EITHER. The sealer publishes
// at most one filename and will not advance until scout's output lands or the
// dispatch times out. This script must therefore never "helpfully" read past the
// first line: a scheduled scout run gets ONE network action total, and the
// second is refused by build-guard's fetch budget.

const MANIFEST = "/home/node/.openclaw/workspace/.inbox-state/PENDING.txt";

// The `read` tool resolves `{ content: [{ type: "text", text }], details }`, but
// what code mode hands back through tools.call() is typed `Promise<unknown>` and
// is not contractually that shape. Walking a few known containers costs nothing
// and means a wrapper change upstream degrades to "did not fire" rather than
// "fired on a string of JSON". Depth-capped because the input is a foreign object.
function textOf(value, depth) {
  if (value == null || depth > 6) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textOf(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["content", "text", "output", "result", "details", "data", "body", "value"]) {
      if (key in value) {
        const found = textOf(value[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return "";
}

let raw = null;
let failure = null;
try {
  raw = await tools.call("read", { path: MANIFEST });
} catch (error) {
  // NOT AN ERROR CONDITION. A missing manifest is the normal state of a fresh
  // container: the sealer creates it on its first pass, up to 300s after boot.
  // Throwing here would put the job into the same error-backoff spiral the shell
  // script did, which is the failure this whole file exists to have fixed.
  failure = String((error && error.message) || error);
}

// First line only, and trimmed: the manifest is one filename plus a newline, and
// an empty file means there is nothing approved and waiting.
const pick = textOf(raw, 0).split("\n")[0].trim();

// A read that SUCCEEDED but yielded nothing extractable is the one case worth
// distinguishing, because it is indistinguishable from "empty inbox" in every
// externally visible way — and it is exactly how a silent regression in the tool
// result shape would present. Recorded in trigger state, which `openclaw cron
// get <id>` prints, so the difference is visible without instrumenting anything.
const shape = raw === null ? "unread" : Array.isArray(raw) ? "array" : typeof raw;
const state = {
  checkedAt: new Date().toISOString(),
  pick: pick || null,
  shape,
};
if (failure) state.failure = failure;

json({
  fire: pick !== "",
  // Appended to the agent-turn message by cron when it fires. The prompt already
  // tells scout to read the manifest itself; naming the file here as well means a
  // manifest that changes between this evaluation and the turn cannot silently
  // redirect the run. The value came from the sealer, which admits only names
  // matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$.
  message: pick ? `Approved request awaiting dispatch: ${pick}` : undefined,
  state,
});
