---
name: dispatch-research
description: Dispatches a web research request to the scout agent via the exchange. Use when the user asks you to search the web, look something up online, or get information from the internet. You cannot fetch or search the web directly — this is the only path.
metadata:
  openclaw:
    emoji: 🔎
---

# Dispatch Research

You have **no web tools**. When the user asks you to search the web, look something up
online, check the weather, find a price, or get any information that requires internet
access, you must dispatch a research request to the scout agent through the exchange.

## How It Works

1. You write a JSON file to `/home/node/exchange/requests/<id>.json`.
2. A human reviews and approves (or rejects) the request.
3. Once approved, it moves to `inbox/` where the scout agent picks it up.
4. Scout fetches the answer and writes it to `raw/`.
5. The sealer normalizes it, the curator distills a brief, the sealer promotes it.
6. The brief appears in `/home/node/exchange/briefs/` for you to read.

**The answer will NOT arrive in this turn.** Tell the user their request has been
submitted and that the result will appear as a brief once approved and processed.

## File Schema

The request file is a **closed schema** — no extra keys are allowed. It is validated
by `research-request-mover.sh` before a human ever sees it.

```json
{
  "query": "<plain-language search query, 1–300 characters>",
  "topic_id": "<unique identifier, alphanumeric with dots/hyphens/underscores, 1–64 chars>"
}
```

### Rules for `query`
- Plain natural language only. Write it as you would type it into a search engine.
- **No URLs, no filesystem paths, no shell metacharacters** (`;`, `&`, `|`, `` ` ``, `$`, `()`, `{}`, `<>`, `\n`, `\`).
- **No encoded blobs** (base64 strings 40+ chars).
- **No credential prefixes** (`sk-`, `xoxb-`, `ghp_`, etc.).
- Maximum 300 characters.

### Rules for `topic_id`
- A short, descriptive, unique identifier for this request.
- Alphanumeric characters, dots, hyphens, and underscores only.
- Maximum 64 characters.
- Example: `weather-nyc-2026-08-03`, `apple-silicon-m5-specs`.

### Rules for the filename
- The filename must be `<topic_id>.json` — matching the `topic_id` inside.
- Characters allowed: `A-Za-z0-9._-` (the filename is also validated).

## Example

User says: *"Can you search on the internet what's the weather tomorrow in NYC?"*

You write to `/home/node/exchange/requests/weather-nyc-2026-08-03.json`:

```json
{
  "query": "weather forecast tomorrow in New York City",
  "topic_id": "weather-nyc-2026-08-03"
}
```

Then reply:

> I've submitted a research request for tomorrow's NYC weather forecast. A human
> needs to approve it before scout can fetch the answer — once it's processed,
> the result will appear as a brief. I'll let you know when it arrives.

## What NOT To Do

- **Do not** attempt to use `web_search` or `web_fetch` — you do not have them.
- **Do not** try to work around the boundary with `exec`, scripts, or any other tool.
- **Do not** embed URLs, paths, or encoded data in the query field.
- **Do not** write more than one request per user ask unless they explicitly ask for
  multiple distinct searches.

## Checking for Results

Briefs land in `/home/node/exchange/briefs/`. The file `INDEX.txt` in that directory
lists all available briefs. Read it to discover new briefs, then read the relevant
`.json` file to get the research results.

Ad-hoc research briefs will NOT have a `product-hunt-*` filename — they will be named
after the `topic_id` from the original request (e.g., `weather-nyc-2026-08-03.json`).
