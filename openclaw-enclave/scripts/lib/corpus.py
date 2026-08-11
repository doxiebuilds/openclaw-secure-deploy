# Persistent per-project corpus — the state the old pipeline never had.
#
# Every run before this one produced an independent, disposable dump. There was
# no way to ask the two questions that matter most when mining complaints:
#
#   "is this new?"        — needs first_seen
#   "does this persist?"  — needs times_seen
#
# Both are free once items have stable ids and survive between runs, and both
# are worth more than any single day's raw list. That is the entire reason this
# module exists.
#
# Storage is JSONL: append-friendly, diffable, greppable, and readable without
# a parser if something goes wrong at 06:00 with nobody watching. The rendered
# markdown brief is derived from this; this is never derived from the markdown.

from __future__ import annotations

import json
import os
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from normalize import Item

# Retention. Feedback ages slowly, but an item nobody has re-observed in three
# months is no longer evidence about a live product.
MAX_AGE_DAYS = 90
# Hard ceiling per project so a corpus cannot grow without bound and slow the
# 06:00 job past the 06:20 one that depends on it.
MAX_ITEMS = 2000


def corpus_path(root: Path | str, slug: str) -> Path:
    return Path(root) / "corpus" / f"{slug}.jsonl"


def load(path: Path | str) -> dict[str, Item]:
    """Read a corpus into an id-keyed map. A missing file is an empty corpus,
    not an error — the first run for a project has to start somewhere.

    A malformed line is skipped rather than fatal: losing one record is better
    than losing the run, and the JSONL format means corruption cannot cascade
    past the line it is on."""
    path = Path(path)
    if not path.exists():
        return {}
    items: dict[str, Item] = {}
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                item = Item.from_json(json.loads(line))
            except (json.JSONDecodeError, TypeError, ValueError):
                continue
            if item.id:
                items[item.id] = item
    return items


def merge(existing: dict[str, Item], fresh: list[Item],
          today: date | None = None) -> list[Item]:
    """Fold a fresh fetch into the stored corpus and return the full merged set.

    times_seen increments at most once per calendar day. Running the job twice
    on the same morning must not make a single observation look like two —
    mistaking repetition for corroboration is precisely the failure the
    truncate-on-rerun guard in the original script was written to prevent, and
    the same reasoning applies to counters."""
    today = today or datetime.now(timezone.utc).date()
    stamp = today.strftime("%Y-%m-%d")

    merged = dict(existing)
    for item in fresh:
        prior = merged.get(item.id)
        if prior is None:
            item.first_seen = item.first_seen or stamp
            item.last_seen = stamp
            item.times_seen = 1
            merged[item.id] = item
            continue

        # Keep the stored temporal facts, take the fresher content.
        if prior.last_seen != stamp:
            prior.times_seen = max(1, prior.times_seen) + 1
            prior.last_seen = stamp
        prior.first_seen = prior.first_seen or stamp
        prior.title = item.title or prior.title
        prior.url = item.url or prior.url
        prior.engagement = max(prior.engagement, item.engagement)
        if len(item.excerpt) > len(prior.excerpt):
            prior.excerpt = item.excerpt
        prior.created_at = prior.created_at or item.created_at
        prior.fetched_at = item.fetched_at or prior.fetched_at
        for query in item.matched_query:
            if query not in prior.matched_query:
                prior.matched_query.append(query)
    return list(merged.values())


def prune(items: list[Item], today: date | None = None, *,
          max_age_days: int = MAX_AGE_DAYS,
          max_items: int = MAX_ITEMS) -> list[Item]:
    """Drop stale records, then cap. Age is measured from last_seen, not
    first_seen: an item still being surfaced today is live evidence no matter
    when it was first observed."""
    today = today or datetime.now(timezone.utc).date()
    cutoff = (today - timedelta(days=max_age_days)).strftime("%Y-%m-%d")

    kept = [item for item in items if (item.last_seen or "9999") >= cutoff]
    if len(kept) > max_items:
        kept.sort(key=lambda i: (i.score, i.times_seen, i.last_seen), reverse=True)
        kept = kept[:max_items]
    return kept


def save(path: Path | str, items: list[Item]) -> None:
    """Atomic replace via a temp file in the same directory, so a crash or an
    out-of-space /tmp can never leave a half-written corpus behind. The 06:20
    builder reads downstream of this; a truncated file would be worse than a
    stale one."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    ordered = sorted(items, key=lambda i: (-i.score, i.id))
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent),
        prefix=f".{path.name}.", suffix=".tmp", delete=False,
    )
    try:
        with handle:
            for item in ordered:
                handle.write(json.dumps(item.to_json(), ensure_ascii=False) + "\n")
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def health_path(root: Path | str) -> Path:
    """Source-health history is global rather than per-project: a dead endpoint
    is dead for everyone, and one shared file makes that obvious at a glance."""
    return Path(root) / "corpus" / "_health.jsonl"


def load_health(path: Path | str, *, days: int = 30) -> list[dict]:
    """Recent health rows, oldest first. Bounded on read so the file cannot slow
    the job down as it accumulates."""
    path = Path(path)
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict):
                rows.append(row)
    rows.sort(key=lambda r: str(r.get("date", "")))
    if days > 0:
        keep = {str(r.get("date", "")) for r in rows}
        cutoff = sorted(keep)[-days:]
        rows = [r for r in rows if str(r.get("date", "")) in set(cutoff)]
    return rows


def append_health(path: Path | str, rows: list[dict],
                  today: date | None = None) -> list[dict]:
    """Record today's health, replacing any existing rows for the same day.

    Replace rather than append for the same reason the brief is truncated on
    re-run: a second run in one morning is a correction, not a second
    observation, and letting it stack would make a rerun look like evidence."""
    today = today or datetime.now(timezone.utc).date()
    stamp = today.strftime("%Y-%m-%d")
    path = Path(path)

    history = [r for r in load_health(path, days=0) if str(r.get("date")) != stamp]
    for row in rows:
        entry = dict(row)
        entry["date"] = stamp
        history.append(entry)
    history.sort(key=lambda r: (str(r.get("date", "")), str(r.get("source", ""))))

    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent),
        prefix=f".{path.name}.", suffix=".tmp", delete=False,
    )
    try:
        with handle:
            for entry in history:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise
    return history


def stats(items: list[Item], today: date | None = None) -> dict[str, int]:
    """Counts for the run summary. `new_today` is the number cron prints to its
    log line, which makes a day where nothing new appeared visible at a glance
    instead of requiring someone to diff two briefs."""
    today = today or datetime.now(timezone.utc).date()
    stamp = today.strftime("%Y-%m-%d")
    return {
        "total": len(items),
        "new_today": sum(1 for i in items if i.first_seen == stamp),
        "seen_today": sum(1 for i in items if i.last_seen == stamp),
        "recurring": sum(1 for i in items if i.times_seen >= 3),
    }
