#!/usr/bin/env python3
# Stage 2 entrypoint: raw fetch manifest in, ranked brief + updated corpus out.
#
# Reads the manifest written by an upstream acquisition step, routes each raw
# response to its adapter, gates and ranks the results, merges them into the
# persistent corpus, and renders the brief.
#
# The shell does I/O and this does judgment. That split is what makes the whole
# thing testable: `--manifest` can point at recorded fixtures, so the full
# pipeline runs offline with no network and no container.
#
# Manifest is JSONL, one row per HTTP request:
#   {"kind":"github_issues","source_label":"github_issues","query":"...",
#    "path":"/tmp/x/gh-0.json","http_status":200,"error":"","host":"","extension":""}
#
# A row with no usable body still gets a manifest entry — that is deliberate.
# Health accounting needs to know a request was attempted and failed, which is
# exactly what the old pipeline could not distinguish from "nothing found".

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import corpus  # noqa: E402
import normalize  # noqa: E402
import render  # noqa: E402
import score  # noqa: E402


def read_manifest(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"warning: bad manifest line skipped: {exc}", file=sys.stderr)
                continue
            if isinstance(row, dict):
                rows.append(row)
    return rows


def collect(rows: list[dict], spec: score.QuerySpec) -> tuple[list[normalize.Item],
                                                              dict[str, render.SourceHealth]]:
    """Normalize every manifest row into Items, accounting for health as we go.

    Health is measured on this fetch alone, before the corpus merge. The
    question a health row answers is "did this source deliver today", which
    would be obscured by items carried over from previous runs."""
    health: dict[str, render.SourceHealth] = {}
    items: list[normalize.Item] = []

    for row in rows:
        label = str(row.get("source_label") or row.get("kind") or "unknown")
        entry = health.setdefault(label, render.SourceHealth(source=label))
        entry.requested += 1

        if row.get("error"):
            entry.errors.append(str(row["error"])[:200])
            continue

        status = row.get("http_status")
        if status is not None and not (200 <= int(status) < 300):
            entry.errors.append(f"HTTP {status}")
            continue
        entry.http_ok += 1

        raw_path = row.get("path")
        if not raw_path or not Path(raw_path).exists():
            entry.errors.append("response body missing on disk")
            continue

        payload = Path(raw_path).read_text(encoding="utf-8", errors="replace")
        kwargs = {"project": spec.slug, "query": str(row.get("query", ""))}
        if row.get("host"):
            kwargs["host"] = str(row["host"])
        if row.get("extension"):
            kwargs["extension"] = str(row["extension"])

        result = normalize.dispatch(str(row.get("kind", "")), payload, **kwargs)

        # The manifest label is authoritative. One adapter can serve several
        # logical sources — from_hn backs both the category search ("hn") and
        # the competitor-name search ("hn_competitor"), which deserve different
        # weights because a named product is far less ambiguous than a category
        # word. Relabelling here keeps health accounting and scoring aligned
        # without teaching the adapter about callers.
        #
        # Ids are deliberately left as the adapter computed them, so the same
        # post found by both searches collapses to one item carrying both
        # queries rather than appearing twice.
        for produced in result.items:
            produced.source = label

        if not result.ok:
            entry.errors.append(f"{result.status}: {result.detail}"[:200])
            continue

        entry.parsed += 1
        entry.returned += len(result.items)
        for item in result.items:
            reason = score.excluded_by(item, spec) if spec.exclude else ""
            if reason:
                entry.excluded_by[reason] = entry.excluded_by.get(reason, 0) + 1
                continue
            if score.relevance(item, spec) >= score.RELEVANCE_FLOOR:
                entry.passed_gate += 1
            items.append(item)

    # Drop sources that never got a real request after label reconciliation.
    return items, {k: v for k, v in health.items() if v.requested > 0}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Distill raw feedback fetches into a ranked brief.")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--keywords", default="")
    parser.add_argument("--exclude", default="")
    parser.add_argument("--competitors", default="")
    parser.add_argument("--out-dir", required=True, type=Path,
                        help="feedback/ directory; brief and corpus/ live here")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--date", default="", help="override today (YYYY-MM-DD), for tests")
    parser.add_argument("--dry-run", action="store_true",
                        help="render to stdout without writing corpus or brief")
    args = parser.parse_args(argv)

    today = (
        datetime.strptime(args.date, "%Y-%m-%d").date() if args.date
        else datetime.now(timezone.utc).date()
    )
    stamp = today.strftime("%Y-%m-%d")
    spec = score.QuerySpec.parse(args.slug, args.keywords, args.exclude, args.competitors)

    if not args.manifest.exists():
        print(f"error: manifest not found at {args.manifest}", file=sys.stderr)
        return 1

    rows = read_manifest(args.manifest)
    fresh, health = collect(rows, spec)
    fresh = normalize.merge_queries(fresh)

    # Merge into the persistent corpus before ranking, so novelty and
    # persistence are known at scoring time rather than bolted on after.
    store = corpus.corpus_path(args.out_dir, args.slug)
    merged = corpus.merge(corpus.load(store), fresh, today)
    merged = corpus.prune(merged, today)

    # Rank over the whole corpus, not just today's fetch. A transient rate-limit
    # or a flaky endpoint then degrades the brief instead of blanking it, and
    # persistent findings keep their place until they actually stop recurring.
    ranked = score.rank(merged, spec, limit=args.limit, today=today)
    counts = corpus.stats(merged, today)

    brief = render.render_brief(
        ranked, slug=args.slug, keywords=args.keywords,
        health=list(health.values()), corpus_total=counts["total"],
        fetched_total=len(fresh), today=today,
    )

    if args.dry_run:
        print(brief)
        print(
            f"dry-run: {len(fresh)} fetched, {len(ranked)} ranked, "
            f"{counts['new_today']} new, {counts['total']} in corpus",
            file=sys.stderr,
        )
        return 0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / f"{stamp}-{args.slug}.md").write_text(brief, encoding="utf-8")
    corpus.save(store, merged)

    history = corpus.append_health(
        corpus.health_path(args.out_dir),
        [dict(row.to_json(), project=args.slug) for row in health.values()],
        today,
    )
    (args.out_dir / "_health.md").write_text(
        render.render_health_history(history), encoding="utf-8"
    )

    broken = [h.source for h in health.values() if h.verdict in ("UNREACHABLE", "BROKEN")]
    summary = (
        f"{args.slug}: {len(ranked)} ranked, {counts['new_today']} new, "
        f"{counts['total']} in corpus"
    )
    if broken:
        summary += f" — SOURCES FAILING: {', '.join(sorted(broken))}"
    print(summary, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
