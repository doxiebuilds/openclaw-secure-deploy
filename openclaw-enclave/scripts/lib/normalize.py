# Source adapters — raw API JSON in, uniform Item records out.
#
# ALL source-specific JSON shape knowledge lives in this module and nowhere
# else. score.py, corpus.py and render.py must never learn that Hacker News
# calls it `objectID` or that Discourse hides the URL behind a slug. When a
# provider changes its response shape, this is the only file that moves.
#
# Every adapter returns a SourceResult rather than a bare list, because the
# three ways a fetch can come back empty are not the same thing and the old
# pipeline could not tell them apart:
#
#   ok          — parsed fine, N items (N may legitimately be 0)
#   api_error   — parsed fine, but the body is an error object (rate limit)
#   parse_error — the body was not JSON at all
#   http_error  — the request never landed; set by the acquire stage
#
# Collapsing those into one "(no results)" line is why community.discourse
# failed 4/4 for the pipeline's entire life without anyone noticing.
#
# Targets python3.11 (the container image). No third-party imports — the
# container rootfs is read-only and has no pip.

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

# Excerpts are pasted into a model's context. Cap them: a single pathological
# forum post should not be able to consume the whole brief's budget.
MAX_EXCERPT = 400
MAX_TITLE = 250

_TAG_RE = re.compile(r"<[^>]+>")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WS_RE = re.compile(r"\s+")

# Tracking junk that makes two links to the same page hash differently.
_STRIP_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "ref", "ref_src", "source", "s", "fbclid", "gclid",
}


def clean_text(raw: Any, limit: int = MAX_EXCERPT) -> str:
    """HTML-strip, entity-decode, collapse whitespace, drop control chars, cap.

    Applied at ingest to every remote string. Control-character stripping is a
    safety measure, not cosmetics: this text lands in a model's context, and
    GOALS.md requires treating fetched content as data rather than instructions.
    Removing the characters that let remote text forge structure is the
    mechanical half of honouring that rule.
    """
    if raw is None:
        return ""
    text = str(raw)
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = _CONTROL_RE.sub("", text)
    text = _WS_RE.sub(" ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


def normalize_url(url: str) -> str:
    """Canonical form for identity purposes — lowercase host, no fragment, no
    tracking params, no trailing slash. Two links that render the same page must
    normalize identically or the exact-dedup pass leaks duplicates."""
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    query = "&".join(
        piece
        for piece in parts.query.split("&")
        if piece and piece.split("=", 1)[0].lower() not in _STRIP_PARAMS
    )
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))


def make_id(source: str, url: str, title: str = "") -> str:
    """Stable identity across runs. Keyed on the normalized URL so the same issue
    found by three different keywords collapses to one record. Falls back to the
    title when a source gives no link (Ask HN entries structurally have none)."""
    basis = normalize_url(url) or f"{source}:{title.lower().strip()}"
    return hashlib.sha256(f"{source}\x00{basis}".encode()).hexdigest()[:16]


@dataclass
class Item:
    """One piece of evidence. The canonical record — markdown is rendered from
    this, never the other way round."""

    id: str
    project: str
    source: str
    url: str
    title: str
    excerpt: str = ""
    engagement: int = 0
    # Every query that surfaced this item. A complaint found by three unrelated
    # searches is better corroborated than one found by a single lucky phrase.
    matched_query: list[str] = field(default_factory=list)
    created_at: str = ""          # ISO date of the source content, "" if unknown
    fetched_at: str = ""
    # Assigned by score.py, persisted so a brief can be re-rendered without refetch.
    relevance: float = 0.0
    score: float = 0.0
    # Owned by corpus.py.
    first_seen: str = ""
    last_seen: str = ""
    times_seen: int = 0

    def blob(self) -> str:
        """Lowercased haystack for keyword gating."""
        return f"{self.title}\n{self.excerpt}".lower()

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Item":
        known = {f for f in cls.__dataclass_fields__}  # tolerate older records
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class SourceResult:
    source: str
    query: str
    status: str                    # ok | api_error | parse_error | http_error
    items: list[Item] = field(default_factory=list)
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _epoch_to_date(value: Any) -> str:
    try:
        return datetime.fromtimestamp(int(value), timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _iso_to_date(value: Any) -> str:
    if not value:
        return ""
    return str(value)[:10]


def _load(payload: str | bytes | dict) -> tuple[Any, str]:
    """Returns (parsed, error). An empty body is a parse error, not an empty
    result — that distinction is the whole point of this module."""
    if isinstance(payload, (dict, list)):
        return payload, ""
    text = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else payload
    if text is None or not text.strip():
        return None, "empty response body"
    try:
        return json.loads(text), ""
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON: {exc.msg} at pos {exc.pos}"


def _fail(source: str, query: str, detail: str) -> SourceResult:
    return SourceResult(source=source, query=query, status="parse_error", detail=detail)


# --------------------------------------------------------------------------
# Adapters. Each takes the raw response body and returns a SourceResult.
# --------------------------------------------------------------------------

def from_hn(payload, *, project: str, query: str, source: str = "hn") -> SourceResult:
    """Hacker News via the Algolia API. Stories carry `title`; comments carry
    `comment_text` and borrow `story_title`. Engagement blends points and
    comments — a 2-point post with 40 replies is an argument, which is exactly
    the shape a friction signal takes."""
    data, err = _load(payload)
    if err:
        return _fail(source, query, err)
    if not isinstance(data, dict):
        return _fail(source, query, "expected a JSON object")

    items: list[Item] = []
    for hit in data.get("hits") or []:
        if not isinstance(hit, dict):
            continue
        title = clean_text(hit.get("title") or hit.get("story_title"), MAX_TITLE)
        body = clean_text(hit.get("comment_text") or hit.get("story_text"))
        if not title and body:
            title = body[:MAX_TITLE]
        if not title:
            continue
        object_id = hit.get("objectID") or ""
        url = f"https://news.ycombinator.com/item?id={object_id}" if object_id else ""
        points = int(hit.get("points") or 0)
        comments = int(hit.get("num_comments") or 0)
        items.append(Item(
            id=make_id(source, url, title),
            project=project, source=source, url=url,
            title=title, excerpt=body,
            engagement=points + (comments * 2),
            matched_query=[query],
            created_at=_epoch_to_date(hit.get("created_at_i")),
            fetched_at=_now(),
        ))
    return SourceResult(source=source, query=query, status="ok", items=items)


def from_github(payload, *, project: str, query: str,
                source: str = "github_issues") -> SourceResult:
    """GitHub issue search. A `message` key at the top level means the API
    refused us — almost always the 10 req/min unauthenticated search ceiling.
    That is an api_error, and reporting it as "no results" would let a rate-limit
    outage masquerade as a quiet day."""
    data, err = _load(payload)
    if err:
        return _fail(source, query, err)
    if not isinstance(data, dict):
        return _fail(source, query, "expected a JSON object")
    if data.get("message"):
        return SourceResult(source=source, query=query, status="api_error",
                            detail=clean_text(data["message"], 200))

    items: list[Item] = []
    for entry in data.get("items") or []:
        if not isinstance(entry, dict):
            continue
        title = clean_text(entry.get("title"), MAX_TITLE)
        if not title:
            continue
        repo = "/".join((entry.get("repository_url") or "").split("/")[-2:])
        url = entry.get("html_url") or ""
        excerpt = clean_text(entry.get("body"))
        items.append(Item(
            id=make_id(source, url, title),
            project=project, source=source, url=url,
            title=f"[{repo}] {title}" if repo else title,
            excerpt=excerpt,
            engagement=int(entry.get("comments") or 0) * 2,
            matched_query=[query],
            created_at=_iso_to_date(entry.get("created_at")),
            fetched_at=_now(),
        ))
    return SourceResult(source=source, query=query, status="ok", items=items)


def from_stackexchange(payload, *, project: str, query: str,
                       source: str = "stackoverflow") -> SourceResult:
    """Stack Exchange /search/advanced. Titles arrive HTML-escaped
    (`doesn&#39;t`), so clean_text's entity decoding is load-bearing here rather
    than cosmetic — without it the exclusion gate would miss terms."""
    data, err = _load(payload)
    if err:
        return _fail(source, query, err)
    if not isinstance(data, dict):
        return _fail(source, query, "expected a JSON object")
    if data.get("error_message") or data.get("error_id"):
        return SourceResult(source=source, query=query, status="api_error",
                            detail=clean_text(data.get("error_message"), 200))

    items: list[Item] = []
    for entry in data.get("items") or []:
        if not isinstance(entry, dict):
            continue
        title = clean_text(entry.get("title"), MAX_TITLE)
        if not title:
            continue
        url = entry.get("link") or ""
        items.append(Item(
            id=make_id(source, url, title),
            project=project, source=source, url=url,
            title=title,
            excerpt=clean_text(entry.get("body_markdown") or entry.get("body")),
            engagement=int(entry.get("score") or 0) + int(entry.get("answer_count") or 0),
            matched_query=[query],
            created_at=_epoch_to_date(entry.get("creation_date")),
            fetched_at=_now(),
        ))
    return SourceResult(source=source, query=query, status="ok", items=items)


def from_discourse(payload, *, project: str, query: str, host: str,
                   source: str = "discourse") -> SourceResult:
    """Discourse /search.json. Two things this has to get right:

    The topic list carries no absolute URL, so it is reconstructed from
    host + slug + id; without that every topic would collide on an empty URL and
    dedup to a single record.

    The matched text lives in `posts[].blurb`, not on the topic, and is joined
    back by topic_id. That blurb is the whole reason to query a support forum —
    it is the sentence where someone says what is broken, and scoring a bare
    topic title would throw away the friction language the gate looks for."""
    data, err = _load(payload)
    if err:
        return _fail(f"{source}:{host}", query, err)
    if not isinstance(data, dict):
        return _fail(f"{source}:{host}", query, "expected a JSON object")

    labelled = f"{source}:{host}"
    blurbs: dict[Any, str] = {}
    for post in data.get("posts") or []:
        if isinstance(post, dict) and post.get("blurb"):
            blurbs.setdefault(post.get("topic_id"), clean_text(post.get("blurb")))

    items: list[Item] = []
    for topic in data.get("topics") or []:
        if not isinstance(topic, dict):
            continue
        title = clean_text(topic.get("title"), MAX_TITLE)
        if not title:
            continue
        slug, topic_id = topic.get("slug") or "", topic.get("id") or ""
        url = f"https://{host}/t/{slug}/{topic_id}" if topic_id else ""
        items.append(Item(
            id=make_id(labelled, url, title),
            project=project, source=labelled, url=url,
            title=title,
            excerpt=blurbs.get(topic_id) or clean_text(topic.get("excerpt")),
            engagement=int(topic.get("posts_count") or 0) + int(topic.get("like_count") or 0),
            matched_query=[query],
            created_at=_iso_to_date(topic.get("created_at")),
            fetched_at=_now(),
        ))
    return SourceResult(source=labelled, query=query, status="ok", items=items)


def from_chrome_reviews(payload, *, project: str, query: str,
                        extension: str = "",
                        source: str = "chrome_reviews") -> SourceResult:
    """Chrome Web Store reviews, normalized from a pre-flattened
    {"reviews": [{"text","rating","author","date"}]} shape produced by the
    acquire stage.

    This is the replacement for the retired Apple App Store feed. It matters
    disproportionately: GitHub issues capture what developers hit, but the
    people who abandon a consumer app are not filing issues — they leave a
    two-star review. Low-rated reviews are where that shows up, so rating
    inverts into engagement (1 star outranks 5)."""
    data, err = _load(payload)
    if err:
        return _fail(source, query, err)
    if not isinstance(data, dict):
        return _fail(source, query, "expected a JSON object")

    items: list[Item] = []
    for review in data.get("reviews") or []:
        if not isinstance(review, dict):
            continue
        body = clean_text(review.get("text"))
        if not body:
            continue
        try:
            rating = int(review.get("rating") or 0)
        except (TypeError, ValueError):
            rating = 0
        url = clean_text(review.get("url"), 500) or (
            f"https://chromewebstore.google.com/detail/{extension}/reviews"
            if extension else ""
        )
        title = f"[{extension or 'extension'} ★{rating}] {body[:120]}"
        items.append(Item(
            id=make_id(source, url or "", f"{extension}:{body[:120]}"),
            project=project, source=source, url=url,
            title=clean_text(title, MAX_TITLE),
            excerpt=body,
            # 1★ → 8, 5★ → 0. A furious review is the signal; praise is not.
            engagement=max(0, (5 - rating) * 2) if rating else 2,
            matched_query=[query],
            created_at=_iso_to_date(review.get("date")),
            fetched_at=_now(),
        ))
    return SourceResult(source=source, query=query, status="ok", items=items)


ADAPTERS = {
    "hn": from_hn,
    "github_issues": from_github,
    "stackoverflow": from_stackexchange,
    "discourse": from_discourse,
    "chrome_reviews": from_chrome_reviews,
}


def dispatch(kind: str, payload, **kwargs) -> SourceResult:
    """Route a raw body to its adapter. An unknown kind is a programming error
    in the acquire stage, so it surfaces as parse_error rather than silently
    yielding nothing."""
    adapter = ADAPTERS.get(kind)
    if adapter is None:
        return _fail(kind, kwargs.get("query", ""), f"no adapter for source '{kind}'")
    return adapter(payload, **kwargs)


def merge_queries(items: Iterable[Item]) -> list[Item]:
    """Deduplicate a single fetch batch by id, unioning matched_query and
    keeping the highest engagement seen. Cheap pre-pass so the expensive fuzzy
    dedup in score.py has less to chew on."""
    merged: dict[str, Item] = {}
    for item in items:
        existing = merged.get(item.id)
        if existing is None:
            merged[item.id] = item
            continue
        for query in item.matched_query:
            if query not in existing.matched_query:
                existing.matched_query.append(query)
        existing.engagement = max(existing.engagement, item.engagement)
        if len(item.excerpt) > len(existing.excerpt):
            existing.excerpt = item.excerpt
    return list(merged.values())
