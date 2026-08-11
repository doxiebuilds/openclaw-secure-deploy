#!/usr/bin/env python3
"""Unit tests for the distillation layer.

    python3 -m unittest discover -s openclaw-enclave/scripts/tests

Runs host-side: no container, no network, no cron. Every test builds its Items
directly, so the suite carries no recorded third-party API payloads.

These cover mechanics — parsing, dedup, gate, corpus bookkeeping. They do not
measure output quality, and passing them is not evidence the brief is good: a
change can keep every test here green and still make the output worse. Judging
ranking quality needs a labelled set scored against a real fetch, which is a
separate exercise from anything in this file.

The fictional project throughout is a recipe manager. The domain is load
bearing rather than decorative: "recipe" and "cookbook" also name Chef
concepts, so it exercises the exclusion gate against a genuine homograph
collision the way any ambiguous category would.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))

import corpus  # noqa: E402
import normalize  # noqa: E402
import render  # noqa: E402
import score  # noqa: E402

SPEC = score.QuerySpec.parse(
    "recipe-box",
    keywords="recipe manager, meal planner",
    exclude="chef, cookbook, knife, puppet",
    competitors="paprika, mealie, tandoor",
)


def item(**kwargs) -> normalize.Item:
    base = dict(
        id="x", project="recipe-box", source="github_issues",
        url="https://example.com/1", title="", excerpt="",
    )
    base.update(kwargs)
    return normalize.Item(**base)


class TestCleaning(unittest.TestCase):
    def test_strips_html_and_decodes_entities(self):
        # Stack Exchange titles arrive escaped; without decoding, the exclusion
        # gate would look for words that are not textually present.
        self.assertEqual(
            normalize.clean_text("<b>doesn&#39;t</b> work"), "doesn't work"
        )

    def test_removes_control_characters(self):
        self.assertEqual(normalize.clean_text("a\x00b\x07c"), "abc")

    def test_caps_length_with_ellipsis(self):
        out = normalize.clean_text("x" * 900, limit=50)
        self.assertEqual(len(out), 50)
        self.assertTrue(out.endswith("…"))

    def test_collapses_whitespace(self):
        self.assertEqual(normalize.clean_text("a \n\n  b\tc"), "a b c")


class TestUrlIdentity(unittest.TestCase):
    def test_normalizes_tracking_params_and_trailing_slash(self):
        a = normalize.normalize_url("https://Example.com/a/?utm_source=hn#frag")
        b = normalize.normalize_url("https://example.com/a")
        self.assertEqual(a, b)

    def test_same_url_same_id(self):
        self.assertEqual(
            normalize.make_id("hn", "https://example.com/a/"),
            normalize.make_id("hn", "https://example.com/a"),
        )

    def test_different_source_different_id(self):
        # Cross-source collapse would destroy convergence signal, so ids must
        # stay distinct even for an identical link.
        self.assertNotEqual(
            normalize.make_id("hn", "https://example.com/a"),
            normalize.make_id("github_issues", "https://example.com/a"),
        )

    def test_falls_back_to_title_when_no_url(self):
        # Ask HN entries structurally have no link; without the fallback every
        # one of them would share an id and collapse to a single record.
        self.assertNotEqual(
            normalize.make_id("hn", "", "first"),
            normalize.make_id("hn", "", "second"),
        )


class TestAdapters(unittest.TestCase):
    def test_empty_body_is_parse_error_not_empty_result(self):
        # The distinction the old pipeline could not make.
        result = normalize.from_hn("", project="p", query="q")
        self.assertEqual(result.status, "parse_error")
        self.assertFalse(result.ok)

    def test_malformed_json_is_parse_error(self):
        self.assertEqual(
            normalize.from_github("{not json", project="p", query="q").status,
            "parse_error",
        )

    def test_github_rate_limit_is_api_error(self):
        # A rate-limited search must never look like a quiet day.
        result = normalize.from_github(
            json.dumps({"message": "API rate limit exceeded"}),
            project="p", query="q",
        )
        self.assertEqual(result.status, "api_error")
        self.assertIn("rate limit", result.detail.lower())

    def test_genuinely_empty_result_is_ok(self):
        result = normalize.from_hn(json.dumps({"hits": []}), project="p", query="q")
        self.assertEqual(result.status, "ok")
        self.assertEqual(result.items, [])

    def test_unknown_source_kind_fails_loudly(self):
        self.assertEqual(
            normalize.dispatch("nope", "{}", project="p", query="q").status,
            "parse_error",
        )

    def test_github_items_parse_into_records(self):
        payload = json.dumps({"items": [
            {"title": "Import from Paprika drops the notes field",
             "repository_url": "https://api.github.com/repos/acme/recipe-box",
             "html_url": "https://github.com/acme/recipe-box/issues/1",
             "body": "Every import loses the notes.", "comments": 3,
             "created_at": "2026-07-20T10:00:00Z"},
        ]})
        result = normalize.dispatch("github_issues", payload,
                                    project="recipe-box", query="recipe manager")
        self.assertTrue(result.ok)
        self.assertEqual(len(result.items), 1)
        # The repo slug is prefixed onto the title so a brief line is attributable.
        self.assertTrue(result.items[0].title.startswith("[acme/recipe-box]"))
        self.assertTrue(result.items[0].url.startswith("https://"))

    def test_discourse_builds_url_and_joins_blurb(self):
        # The topic list carries no absolute URL and the matched text lives on
        # posts[], so both reconstruction and the topic_id join are exercised.
        payload = json.dumps({
            "posts": [{"topic_id": 42, "blurb": "meal planner keeps forgetting"}],
            "topics": [{"id": 42, "slug": "planner-forgets", "title": "Planner forgets",
                        "posts_count": 4, "like_count": 1,
                        "created_at": "2026-07-20T10:00:00Z"}],
        })
        result = normalize.dispatch("discourse", payload, project="recipe-box",
                                    query="meal planner confusing",
                                    host="forum.example.org")
        self.assertTrue(result.ok)
        self.assertEqual(result.source, "discourse:forum.example.org")
        self.assertIn("forum.example.org/t/planner-forgets/42", result.items[0].url)
        self.assertEqual(result.items[0].excerpt, "meal planner keeps forgetting")

    def test_chrome_review_inverts_rating_into_engagement(self):
        payload = json.dumps({"reviews": [
            {"text": "Constantly loses my saved recipes", "rating": 1},
            {"text": "Works great, love it", "rating": 5},
        ]})
        result = normalize.from_chrome_reviews(
            payload, project="p", query="q", extension="paprika")
        self.assertTrue(result.ok)
        angry, happy = result.items[0], result.items[1]
        self.assertGreater(angry.engagement, happy.engagement)


class TestExclusionGate(unittest.TestCase):
    def test_infra_homograph_is_excluded(self):
        # "cookbook" names a Chef concept; without the gate the whole config
        # management ecosystem reads as on-topic for a recipe product.
        it = item(title="Chef cookbook not converging on the node")
        self.assertEqual(score.excluded_by(it, SPEC), "chef")
        self.assertEqual(score.relevance(it, SPEC), 0.0)

    def test_exclusion_beats_a_perfect_keyword_match(self):
        # Gate runs first and unconditionally; it is not a tie-breaker.
        it = item(title="recipe manager for chef cookbooks")
        self.assertEqual(score.relevance(it, SPEC), 0.0)

    def test_word_boundary_prevents_substring_false_positives(self):
        # Puppeteer is a browser library and has nothing to do with Puppet.
        self.assertFalse(score.matches("i had a puppeteer problem", "puppet"))
        self.assertTrue(score.matches("switching to puppet now", "puppet"))

    def test_plural_tolerance(self):
        # "Recipes Manager" must match the keyword "recipe manager" — a real
        # user report was lost to this before plural handling was added.
        self.assertTrue(score.matches("the Recipes Manager feature", "recipe manager"))

    def test_offtopic_item_scores_zero(self):
        self.assertEqual(score.relevance(item(title="Django ajax bug"), SPEC), 0.0)


class TestVoiceFactor(unittest.TestCase):
    def test_generated_task_template_is_demoted(self):
        generated = item(
            title="[New Project]: recipe manager",
            excerpt="### Project Name x ### Project Type Frontend "
                    "### Requirements 1. Implement core logic 2. Write unit tests",
        )
        personal = item(
            title="recipe manager",
            excerpt="I created a script because I have to manually retype every "
                    "recipe; from my usage this is the worst part.",
        )
        self.assertLess(score.voice_factor(generated), score.voice_factor(personal))
        self.assertLess(score.relevance(generated, SPEC), score.relevance(personal, SPEC))

    def test_voice_factor_is_bounded(self):
        spam = item(excerpt=" ".join(score.PERSONAL_MARKERS))
        self.assertLessEqual(score.voice_factor(spam), score.VOICE_CEIL)
        junk = item(excerpt=" ".join(score.TEMPLATE_MARKERS))
        self.assertGreaterEqual(score.voice_factor(junk), score.VOICE_FLOOR)


class TestScoring(unittest.TestCase):
    def test_competitor_name_outranks_category_phrase(self):
        named = item(title="Paprika keeps losing my saved recipes")
        generic = item(title="recipe manager keeps losing data")
        self.assertGreater(
            score.topic_relevance(named, SPEC), score.topic_relevance(generic, SPEC)
        )

    def test_competitor_name_alone_is_not_enough(self):
        # Regression: the first live run filled the brief with cooking articles,
        # because "Paprika" is a spice and "Tandoor" is an oven. A product name
        # needs domain vocabulary beside it.
        collision = item(title="Hungarian Goulash, Properly",
                         excerpt="a heaping spoon of paprika at the very end")
        self.assertEqual(score.topic_relevance(collision, SPEC), 0.0)

    def test_throwaway_body_is_not_evidence(self):
        # Regression: a one-line quip under a cooking story matched both a
        # competitor and a domain word, and was the last surviving noise item
        # in the first live run.
        quip = item(title="Hungarian Goulash, Properly",
                    excerpt="Yes, but is the paprika recipe even real?")
        self.assertEqual(score.topic_relevance(quip, SPEC), 0.0)

    def test_substance_floor_does_not_apply_to_title_matches(self):
        # A short body is fine when the title itself is the evidence.
        titled = item(title="Paprika lost my saved recipe", excerpt="same here")
        self.assertGreater(score.topic_relevance(titled, SPEC), 0.0)

    def test_competitor_with_domain_context_scores_top(self):
        real = item(title="Paprika lost my whole recipe collection",
                    excerpt="I switched away after it dropped my meal planner")
        self.assertEqual(score.topic_relevance(real, SPEC), 1.0)

    def test_domain_words_come_from_config_not_hardcoded(self):
        other = score.QuerySpec.parse("x", keywords="podcast transcription")
        self.assertIn("podcast", score.domain_words(other))
        self.assertNotIn("recipe", score.domain_words(other))

    def test_zero_engagement_is_weak_not_annihilated(self):
        it = item(title="recipe manager is frustrating", engagement=0)
        self.assertGreater(score.final_score(it, SPEC), 0.0)

    def test_engagement_is_sublinear(self):
        low = item(id="a", title="recipe manager broken", engagement=5)
        high = item(id="b", title="recipe manager broken", engagement=500)
        ratio = score.final_score(high, SPEC) / score.final_score(low, SPEC)
        self.assertLess(ratio, 4.0)  # 100x engagement, well under 4x score

    def test_friction_language_raises_rank(self):
        plain = item(id="a", title="recipe manager feature")
        angry = item(id="b", title="recipe manager is broken and confusing")
        self.assertGreater(score.friction_factor(angry), score.friction_factor(plain))

    def test_recency_decay_bounded_and_monotonic(self):
        today = date(2026, 7, 27)
        fresh = item(created_at="2026-07-20")
        old = item(created_at="2020-01-01")
        self.assertGreater(score.recency_decay(fresh, today), score.recency_decay(old, today))
        self.assertGreaterEqual(score.recency_decay(old, today), score.RECENCY_FLOOR)

    def test_unknown_date_is_not_guessed(self):
        self.assertEqual(score.recency_decay(item(created_at=""), date(2026, 7, 27)), 0.85)

    def test_novelty_boost_for_new_and_recurring(self):
        today = date(2026, 7, 27)
        new = item(first_seen="2026-07-27")
        recurring = item(first_seen="2026-01-01", times_seen=5)
        stale = item(first_seen="2026-01-01", times_seen=1)
        self.assertGreater(score.novelty_boost(new, today), score.novelty_boost(stale, today))
        self.assertGreater(score.novelty_boost(recurring, today), score.novelty_boost(stale, today))


class TestDeduplication(unittest.TestCase):
    def test_exact_id_dedup_unions_queries(self):
        a = item(id="same", title="Same", matched_query=["q1"], engagement=2)
        b = item(id="same", title="Same", matched_query=["q2"], engagement=9)
        out = score.deduplicate([a, b])
        self.assertEqual(len(out), 1)
        self.assertCountEqual(out[0].matched_query, ["q1", "q2"])
        self.assertEqual(out[0].engagement, 9)

    def test_near_duplicate_titles_collapse(self):
        a = item(id="a", title="[repo] [FEATURE] Recipe Manager Dashboard")
        b = item(id="b", title="[other] [Feature] Recipe Manager Dashboard!")
        self.assertEqual(len(score.deduplicate([a, b])), 1)

    def test_distinct_titles_survive(self):
        a = item(id="a", title="Capture flow is slow")
        b = item(id="b", title="Kanban board drag and drop broken")
        self.assertEqual(len(score.deduplicate([a, b])), 2)

    def test_cross_source_duplicates_are_kept(self):
        # Convergence across independent sources is the strongest signal there
        # is; collapsing it would be actively harmful.
        a = item(id="a", source="hn", title="Recipe manager loses data")
        b = item(id="b", source="github_issues", title="Recipe manager loses data")
        self.assertEqual(len(score.deduplicate([a, b])), 2)

    def test_bracket_prefix_ignored_in_dedup_key(self):
        self.assertEqual(
            score.dedup_key("[owner/repo] Fix the thing"), score.dedup_key("Fix the thing!")
        )

    def test_rank_drops_below_floor_and_truncates(self):
        # Distinct titles on purpose: identical ones would legitimately collapse
        # in the near-dup pass and this test would be measuring dedup instead.
        topics = ["capture is broken", "export is broken", "search is broken",
                  "sync is broken", "import is broken", "filters are broken",
                  "reminders are broken", "tags are broken", "notes are broken",
                  "login is broken"]
        items = [item(id=f"i{n}", title=f"recipe manager {topic}",
                      engagement=n) for n, topic in enumerate(topics)]
        items.append(item(id="junk", title="Chef cookbook converge tuning"))
        ranked = score.rank(items, SPEC, limit=3)
        self.assertEqual(len(ranked), 3)
        self.assertNotIn("junk", [i.id for i in ranked])
        self.assertEqual(ranked, sorted(ranked, key=lambda i: i.score, reverse=True))


class TestCorpus(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.addCleanup(self.dir.cleanup)

    def path(self):
        return corpus.corpus_path(self.root, "recipe-box")

    def test_missing_corpus_is_empty_not_an_error(self):
        self.assertEqual(corpus.load(self.path()), {})

    def test_first_sighting_sets_provenance(self):
        merged = corpus.merge({}, [item(id="a", title="t")], date(2026, 7, 27))
        self.assertEqual(merged[0].first_seen, "2026-07-27")
        self.assertEqual(merged[0].times_seen, 1)

    def test_second_day_increments_times_seen(self):
        day1 = corpus.merge({}, [item(id="a", title="t")], date(2026, 7, 27))
        day2 = corpus.merge({i.id: i for i in day1},
                            [item(id="a", title="t")], date(2026, 7, 28))
        self.assertEqual(day2[0].times_seen, 2)
        self.assertEqual(day2[0].first_seen, "2026-07-27")
        self.assertEqual(day2[0].last_seen, "2026-07-28")

    def test_rerun_same_day_does_not_double_count(self):
        # A second run in one morning is a correction, not a second observation.
        # Letting it increment would make repetition look like corroboration.
        today = date(2026, 7, 27)
        first = corpus.merge({}, [item(id="a", title="t")], today)
        second = corpus.merge({i.id: i for i in first}, [item(id="a", title="t")], today)
        self.assertEqual(second[0].times_seen, 1)

    def test_merge_keeps_richest_content(self):
        stored = corpus.merge({}, [item(id="a", title="t", excerpt="short",
                                        engagement=1, matched_query=["q1"])],
                              date(2026, 7, 27))
        updated = corpus.merge(
            {i.id: i for i in stored},
            [item(id="a", title="t", excerpt="a much longer excerpt",
                  engagement=9, matched_query=["q2"])],
            date(2026, 7, 28),
        )[0]
        self.assertEqual(updated.excerpt, "a much longer excerpt")
        self.assertEqual(updated.engagement, 9)
        self.assertCountEqual(updated.matched_query, ["q1", "q2"])

    def test_roundtrip_through_disk(self):
        items = [item(id="a", title="t", excerpt="e", matched_query=["q"])]
        merged = corpus.merge({}, items, date(2026, 7, 27))
        corpus.save(self.path(), merged)
        loaded = corpus.load(self.path())
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded["a"].matched_query, ["q"])
        self.assertEqual(loaded["a"].first_seen, "2026-07-27")

    def test_corrupt_line_is_skipped_not_fatal(self):
        path = self.path()
        path.parent.mkdir(parents=True, exist_ok=True)
        good = json.dumps(item(id="a", title="t").to_json())
        path.write_text(f"{good}\nnot json at all\n\n", encoding="utf-8")
        self.assertEqual(len(corpus.load(path)), 1)

    def test_prune_drops_stale_and_caps(self):
        old = item(id="old", title="t")
        old.last_seen = "2026-01-01"
        fresh = item(id="new", title="t")
        fresh.last_seen = "2026-07-27"
        kept = corpus.prune([old, fresh], date(2026, 7, 27), max_age_days=90)
        self.assertEqual([i.id for i in kept], ["new"])

    def test_prune_caps_total(self):
        many = []
        for n in range(50):
            it = item(id=f"i{n}", title="t", score=float(n))
            it.last_seen = "2026-07-27"
            many.append(it)
        kept = corpus.prune(many, date(2026, 7, 27), max_items=10)
        self.assertEqual(len(kept), 10)
        self.assertEqual(max(i.score for i in kept), 49.0)

    def test_health_rerun_replaces_same_day(self):
        path = corpus.health_path(self.root)
        today = date(2026, 7, 27)
        corpus.append_health(path, [{"source": "hn", "returned": 5}], today)
        rows = corpus.append_health(path, [{"source": "hn", "returned": 9}], today)
        same_day = [r for r in rows if r["date"] == "2026-07-27"]
        self.assertEqual(len(same_day), 1)
        self.assertEqual(same_day[0]["returned"], 9)


class TestHealthVerdicts(unittest.TestCase):
    def test_unreachable_when_no_request_lands(self):
        h = render.SourceHealth(source="discourse:community.notion.so",
                                requested=4, http_ok=0)
        self.assertEqual(h.verdict, "UNREACHABLE")

    def test_broken_when_responds_but_never_parses(self):
        h = render.SourceHealth(source="x", requested=4, http_ok=4, parsed=0)
        self.assertEqual(h.verdict, "BROKEN")

    def test_offtarget_when_results_all_excluded(self):
        h = render.SourceHealth(source="stackoverflow", requested=2, http_ok=2,
                                parsed=2, returned=30, passed_gate=0)
        self.assertEqual(h.verdict, "OFF-TARGET")

    def test_empty_is_distinct_from_broken(self):
        # A source that answered honestly with nothing is not a failure.
        h = render.SourceHealth(source="hn", requested=2, http_ok=2, parsed=2, returned=0)
        self.assertEqual(h.verdict, "EMPTY")

    def test_healthy_source(self):
        h = render.SourceHealth(source="github_issues", requested=2, http_ok=2,
                                parsed=2, returned=30, passed_gate=6)
        self.assertEqual(h.verdict, "ok")
        self.assertAlmostEqual(h.yield_ratio, 0.2)


class TestRender(unittest.TestCase):
    def test_brief_marks_new_items_and_carries_evidence(self):
        it = item(id="a", title="Recipe box loses data", url="https://example.com/1",
                  excerpt="I lost everything", matched_query=["recipe manager"])
        it.first_seen = "2026-07-27"
        it.score = 3.2
        out = render.render_brief([it], slug="recipe-box", keywords="k",
                                  today=date(2026, 7, 27))
        self.assertIn("**NEW**", out)
        self.assertIn("https://example.com/1", out)
        self.assertIn("Untrusted remote content", out)

    def test_empty_brief_says_check_sources_not_users_are_happy(self):
        out = render.render_brief([], slug="recipe-box", keywords="k",
                                  health=[render.SourceHealth(source="hn", requested=1)],
                                  today=date(2026, 7, 27))
        self.assertIn("statement about the fetch", out)

    def test_health_history_flags_persistently_dry_source(self):
        rows = [{"date": f"2026-07-{20 + n:02d}", "source": "discourse:dead",
                 "returned": 0, "passed_gate": 0} for n in range(7)]
        out = render.render_health_history(rows, days=7)
        self.assertIn("RETIRE", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
