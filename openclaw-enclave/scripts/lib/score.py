# Relevance gating and ranking. Pure functions, no I/O, no network.
#
# This module is the answer to an early run where an entire Stack Overflow
# section came back as configuration-management results for a consumer product,
# because the category word also named a piece of infrastructure and nothing in
# the pipeline could tell. Two mechanisms fix that class of failure:
#
#   1. A hard exclusion gate. An item matching an exclude term scores exactly
#      0.0 and is dropped — not down-weighted. An infrastructure homograph in a
#      consumer-product result is never a near-miss worth keeping.
#   2. A friction requirement. Being on-topic is not enough; we are mining
#      complaints, so an item with no friction language ranks below one with it.
#
# Everything here is deterministic and side-effect free so precision can be
# measured offline against a labelled set. If you change a weight, that number
# is how you find out whether you improved anything — do not tune by reading
# output and forming an impression.

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from difflib import SequenceMatcher

from normalize import Item

# Items below this are dropped entirely rather than shown low in the list. A
# brief padded with weak results trains the reader to skim, which defeats it.
RELEVANCE_FLOOR = 0.30

# Minimum body length for an item whose topic match comes only from its body.
# Measured, not guessed: on the first live corpus the shortest genuine finding
# had a 91-character body and the one piece of surviving noise had 36.
MIN_BODY_SUBSTANCE = 60

# Near-duplicate threshold for SequenceMatcher over normalized titles. 0.88
# collapses "[Feature] Job Application Tracker" against "[FEATURE] Job
# Application Tracker Dashboard" while leaving genuinely distinct issues apart.
NEAR_DUP_RATIO = 0.88

# Complaints stay true for a long time — a 2023 review of a still-shipping
# product is real evidence. Decay gently; this is not a news feed.
RECENCY_HALF_LIFE_DAYS = 365.0
RECENCY_FLOOR = 0.40

# Starting weights, revised from the yield report in render.py rather than by
# intuition. Stack Overflow is low because it is a Q&A site for implementers:
# structurally it holds "how do I build X", not "X is infuriating".
SOURCE_WEIGHTS = {
    "chrome_reviews": 1.30,
    # Complaints about a product named by name. A product name cannot collide
    # the way a category word can, so this is the highest-precision text source
    # available without a credential.
    "hn_competitor": 1.20,
    "github_issues": 1.00,
    "hn": 1.00,
    "discourse": 0.90,
    "stackoverflow": 0.60,
}
DEFAULT_SOURCE_WEIGHT = 0.80

# Sources whose every item is already a complaint. A one-star review does not
# need to contain the word "frustrating" to be friction.
INHERENT_FEEDBACK_SOURCES = frozenset({"chrome_reviews"})

FRICTION_TERMS = (
    "frustrating", "frustrated", "confusing", "confused", "broken", "annoying",
    "annoyed", "buggy", "bug", "useless", "unusable", "clunky", "tedious",
    "painful", "hate", "terrible", "awful", "disappointed", "doesn't work",
    "does not work", "stopped working", "no longer works", "can't", "cannot",
    "won't", "fails", "failed", "crash", "crashes", "slow", "wish", "missing",
    "lacks", "workaround", "gave up", "switched away", "cancelled", "refund",
)

# Voice detection — the single most useful discriminator found while labelling
# a real pool by hand, and the one that generalises furthest.
#
# The highest-scoring noise in that pool was not off-topic. It was perfectly
# on-topic and completely worthless: auto-generated issues in "contribute a
# project" farm repos, whose titles are exact keyword matches
# ("[New Project]: <category phrase>") but behind which no user exists.
# Keyword relevance cannot separate those from real reports, because on keywords
# they are indistinguishable.
#
# What separates them is who is speaking. Real evidence is written in the first
# person about lived experience — "I created a script because...", "from my
# usage", "users still need to rely on Excel". Generated tasks are written in
# spec voice — "Implement core logic", "### Project Type", "Write unit tests".
# Nobody is behind the second kind, so it is not evidence about anything.
PERSONAL_MARKERS = (
    "i created", "i built", "i made", "i wrote", "i use", "i used", "i tried",
    "i switched", "i gave up", "i have to", "i had to", "i need", "i wanted",
    "i keep", "i ended up", "i can't", "i cannot", "my usage", "my experience",
    "my workflow", "in my case", "my point-of-view", "my point of view",
    "for me", "we use", "we ended up", "our team", "users still", "still need to",
    "have to manually", "manually copy", "ended up using", "instead i",
    "as a user", "i'm a", "i am a", "been using",
)

# Structural fingerprints of issue-template and task-generator output.
TEMPLATE_MARKERS = (
    "### project name", "### project type", "### project description",
    "### category", "### requirements", "### file path", "### task",
    "### acceptance criteria", "acceptance criteria:", "implement core logic",
    "add error handling", "write unit tests", "update documentation",
    "ensure performance", "### deliverables", "### expected outcome",
    "good first issue", "hacktoberfest", "gssoc", "assign me", "please assign",
    "### tech stack", "### mentor", "### difficulty",
    # Contribution-farm submission forms. These repos exist to collect project
    # proposals, so their issues are perfect keyword matches with no user
    # behind them — the dominant noise class in the 2026-07-27 pool.
    "### one-line description", "### your github username", "pre-flight checks",
    "contributing.md", "### tags", "### proposed solution",
    "### problem statement", "### difficulty level", "### folder",
    "i would like to work on", "want to work on this",
)

VOICE_FLOOR, VOICE_CEIL = 0.35, 1.50


@dataclass
class QuerySpec:
    """Per-project search configuration, sourced from PROJECT_STATE frontmatter
    via index.tsv. `exclude` is what turns a hand-written note about a known
    homograph in PROJECT_STATE-<slug>.md into something the pipeline enforces."""

    slug: str
    include: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)
    competitors: list[str] = field(default_factory=list)

    @classmethod
    def parse(cls, slug: str, keywords: str = "", exclude: str = "",
              competitors: str = "") -> "QuerySpec":
        return cls(
            slug=slug,
            include=split_terms(keywords),
            exclude=split_terms(exclude),
            competitors=split_terms(competitors),
        )


def split_terms(raw: str) -> list[str]:
    """Comma-separated, whitespace-tolerant, lowercased, order-preserving."""
    if not raw:
        return []
    seen, out = set(), []
    for piece in str(raw).split(","):
        term = " ".join(piece.split()).lower()
        if term and term not in seen:
            seen.add(term)
            out.append(term)
    return out


def _term_pattern(term: str) -> re.Pattern:
    """Word-boundary match so 'ai' does not fire on 'said'. Interior whitespace
    is flexible because titles wrap, and each word tolerates a trailing plural
    's' — without that, "Recipes Manager" fails to match the keyword "recipe
    manager", which cost a real user report its place in the first labelled run."""
    escaped = r"s?\s+".join(re.escape(word) for word in term.split())
    return re.compile(rf"(?<!\w){escaped}s?(?!\w)", re.IGNORECASE)


_PATTERN_CACHE: dict[str, re.Pattern] = {}


def matches(haystack: str, term: str) -> bool:
    pattern = _PATTERN_CACHE.get(term)
    if pattern is None:
        pattern = _PATTERN_CACHE[term] = _term_pattern(term)
    return bool(pattern.search(haystack))


def matches_any(haystack: str, terms: list[str]) -> bool:
    return any(matches(haystack, term) for term in terms)


def first_match(haystack: str, terms: list[str]) -> str:
    for term in terms:
        if matches(haystack, term):
            return term
    return ""


def excluded_by(item: Item, spec: QuerySpec) -> str:
    """The exclude term that killed this item, or "". Returned rather than a
    bool so the source-health report can say *why* a source yields nothing —
    'Stack Overflow: 15 returned, 15 excluded (chef)' is actionable in a way
    that '(no results)' never was."""
    return first_match(item.blob(), spec.exclude)


def domain_words(spec: QuerySpec) -> list[str]:
    """Significant words from the category keywords, used as a context check.

    Derived from config rather than hardcoded, so this stays project-agnostic:
    for a recipe manager it yields recipe/meal/planner-ish words, and for some
    other project it yields that project's vocabulary."""
    words: list[str] = []
    for term in spec.include:
        for word in term.split():
            if len(word) >= 3 and word not in words:
                words.append(word)
    return words


def topic_relevance(item: Item, spec: QuerySpec) -> float:
    """How on-topic is this, before asking whether it is a complaint.

    A named competitor outranks a category phrase — but only when the item also
    carries domain vocabulary. Product names are ordinary English words far more
    often than is convenient: "Teal" is a colour, "Simplify" is a verb, and
    searching a comment corpus for them alone returns solar-panel policy and
    LangChain CVEs. That is the Hadoop collision again on a different axis, and
    the fix is the same in spirit — require corroborating context instead of
    trusting a single lexical hit."""
    title = item.title.lower()
    blob = item.blob()

    # Substance floor for body-only matches. On a comment source the title is
    # the story someone else submitted, so the commenter's text is the entire
    # evidence — and a 36-character aside ("who hunts the Huntr/x?" under a
    # solar-panel story) is a pun, not a report. Titles are exempt: a title
    # match is authored evidence even when it is short.
    if (item.excerpt and len(item.excerpt) < MIN_BODY_SUBSTANCE
            and not matches_any(title, spec.competitors + spec.include)):
        return 0.0

    if spec.competitors:
        has_context = matches_any(blob, domain_words(spec))
        if has_context:
            if matches_any(title, spec.competitors):
                return 1.00
            if matches_any(blob, spec.competitors):
                return 0.85
    if spec.include:
        if matches_any(title, spec.include):
            return 0.75
        if matches_any(blob, spec.include):
            return 0.50
        # Partial credit: every word of some keyword phrase is present, just not
        # adjacent. Catches "manager for my recipes" against "recipe manager"
        # without opening the door to single-word matches.
        best = 0.0
        for term in spec.include:
            words = [w for w in term.split() if len(w) > 2]
            if len(words) < 2:
                continue
            hit = sum(1 for word in words if matches(blob, word))
            best = max(best, hit / len(words))
        if best >= 0.75:
            return 0.40 * best
    return 0.0


def friction_factor(item: Item) -> float:
    """0.55 for a purely topical item up to 1.0 for one dense with complaint
    language. Never zero: an on-topic feature request with no angry words is
    still weak evidence of a gap, and dropping it outright would lose the
    'nobody has built X' signal."""
    if item.source.split(":", 1)[0] in INHERENT_FEEDBACK_SOURCES:
        return 1.0
    blob = item.blob()
    hits = 0
    for term in FRICTION_TERMS:
        if matches(blob, term):
            hits += 1
            if hits >= 3:
                break
    return 0.55 + (0.15 * hits)


def contains_any(haystack: str, markers: tuple[str, ...]) -> int:
    """Count distinct markers present. Plain substring matching — these are long
    distinctive phrases, and regex word boundaries around '###' buy nothing."""
    return sum(1 for marker in markers if marker in haystack)


def voice_factor(item: Item) -> float:
    """Who is speaking: a person with a problem, or an issue template.

    Ranges 0.35 (pure generated task) to 1.5 (dense first-person report). This
    is what demotes a perfect keyword match like "[New Project]: recipe manager"
    below a real user writing "I built a script because the app wouldn't let me
    scale a recipe" — the second is evidence and the first is a to-do item that
    happens to share vocabulary."""
    if item.source.split(":", 1)[0] in INHERENT_FEEDBACK_SOURCES:
        return 1.20  # a review is a person by construction
    blob = item.blob()
    personal = min(3, contains_any(blob, PERSONAL_MARKERS))
    template = min(3, contains_any(blob, TEMPLATE_MARKERS))
    raw = 1.0 + (0.20 * personal) - (0.25 * template)
    return max(VOICE_FLOOR, min(VOICE_CEIL, raw))


def corroboration(item: Item) -> float:
    """Independent queries converging on one item is real evidence. Capped so a
    keyword list that happens to overlap cannot inflate a mediocre result."""
    return min(1.15, 1.0 + 0.05 * max(0, len(item.matched_query) - 1))


def relevance(item: Item, spec: QuerySpec) -> float:
    """Hard gate first, then topic × friction. Returns 0.0 for anything excluded
    or off-topic — callers treat 0.0 as 'drop', not 'rank last'."""
    if spec.exclude and excluded_by(item, spec):
        return 0.0
    topic = topic_relevance(item, spec)
    if topic <= 0.0:
        return 0.0
    return min(1.0, topic * friction_factor(item) * voice_factor(item)
               * corroboration(item))


def recency_decay(item: Item, today: date | None = None) -> float:
    if not item.created_at:
        return 0.85  # unknown age: mildly penalised, not guessed at
    try:
        created = datetime.strptime(item.created_at[:10], "%Y-%m-%d").date()
    except ValueError:
        return 0.85
    today = today or datetime.now(timezone.utc).date()
    age = max(0, (today - created).days)
    return max(RECENCY_FLOOR, 0.5 ** (age / RECENCY_HALF_LIFE_DAYS))


def novelty_boost(item: Item, today: date | None = None) -> float:
    """Rewards the two things a single day's dump structurally cannot express:
    that something is new, and that something keeps coming back. Both come free
    from the corpus's first_seen/times_seen bookkeeping."""
    today = today or datetime.now(timezone.utc).date()
    stamp = today.strftime("%Y-%m-%d")
    if item.first_seen == stamp:
        return 1.25
    if item.times_seen >= 3:
        return 1.15
    return 1.00


def source_weight(source: str) -> float:
    return SOURCE_WEIGHTS.get(source.split(":", 1)[0], DEFAULT_SOURCE_WEIGHT)


def final_score(item: Item, spec: QuerySpec, today: date | None = None) -> float:
    """score = relevance × (1 + log1p(engagement)) × recency × novelty × source

    The engagement term is 1 + log1p rather than log1p so a zero-comment issue
    is merely weak instead of annihilated, and so a 100-comment thread does not
    drown a sharp 8-comment one."""
    rel = relevance(item, spec)
    if rel <= 0.0:
        return 0.0
    return (
        rel
        * (1.0 + math.log1p(max(0, item.engagement)))
        * recency_decay(item, today)
        * novelty_boost(item, today)
        * source_weight(item.source)
    )


_NOISE_RE = re.compile(r"[^a-z0-9 ]+")
_BRACKET_RE = re.compile(r"^\s*\[[^\]]*\]\s*")


def dedup_key(title: str) -> str:
    """Normalized title for fuzzy comparison — drops the '[owner/repo]' prefix
    and all punctuation so formatting differences do not read as distinct."""
    text = _BRACKET_RE.sub("", title.lower())
    return " ".join(_NOISE_RE.sub(" ", text).split())


def deduplicate(items: list[Item]) -> list[Item]:
    """Two passes: exact by id, then fuzzy by title *within a source*.

    Deliberately not cross-source. The same problem independently surfacing on
    GitHub and Hacker News is corroboration and must stay visible as two items;
    collapsing it would destroy exactly the convergence signal that makes a
    finding trustworthy."""
    exact: dict[str, Item] = {}
    for item in items:
        current = exact.get(item.id)
        if current is None:
            exact[item.id] = item
            continue
        _absorb(current, item)

    by_source: dict[str, list[Item]] = {}
    for item in exact.values():
        by_source.setdefault(item.source, []).append(item)

    kept: list[Item] = []
    for group in by_source.values():
        # Strongest first, so a near-dup merges into the better record.
        group.sort(key=lambda i: (i.score, i.engagement), reverse=True)
        survivors: list[tuple[str, Item]] = []
        for item in group:
            key = dedup_key(item.title)
            hit = None
            for existing_key, existing in survivors:
                if SequenceMatcher(None, key, existing_key).ratio() >= NEAR_DUP_RATIO:
                    hit = existing
                    break
            if hit is None:
                survivors.append((key, item))
            else:
                _absorb(hit, item)
        kept.extend(item for _, item in survivors)
    return kept


def _absorb(keeper: Item, other: Item) -> None:
    """Fold a duplicate into the record we are keeping. Union the queries that
    found it, take the strongest engagement and the fullest excerpt."""
    for query in other.matched_query:
        if query not in keeper.matched_query:
            keeper.matched_query.append(query)
    keeper.engagement = max(keeper.engagement, other.engagement)
    if len(other.excerpt) > len(keeper.excerpt):
        keeper.excerpt = other.excerpt
    keeper.times_seen = max(keeper.times_seen, other.times_seen)
    if other.first_seen and (not keeper.first_seen or other.first_seen < keeper.first_seen):
        keeper.first_seen = other.first_seen


def rank(items: list[Item], spec: QuerySpec, *, limit: int = 20,
         today: date | None = None) -> list[Item]:
    """Gate, score, dedup, sort, truncate. The one entry point callers need."""
    scored: list[Item] = []
    for item in items:
        item.relevance = relevance(item, spec)
        if item.relevance < RELEVANCE_FLOOR:
            continue
        item.score = final_score(item, spec, today)
        scored.append(item)
    survivors = deduplicate(scored)
    survivors.sort(key=lambda i: (i.score, i.engagement), reverse=True)
    return survivors[:limit] if limit and limit > 0 else survivors
