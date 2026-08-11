<!--
Template for a per-project state file.

Optional per-project template. Typical path:
  /home/node/.openclaw/workspace/memory/projects/project-state/PROJECT_STATE-<slug>.md

Do not copy this by hand. The bootstrap step creates one of these for
every project repo it finds, with `keywords:` left blank. A blank
`keywords:` means "discovered, not yet defined" — the fetch loop skips
the project until you fill it in, so filling it in is what adopts the
project into the cycle. Delete this comment block when you do.
-->
---
project: <slug>
keywords:
exclude_keywords:
competitors:
phase: explore
budget_per_cycle: 30m
deadline:
thesis:
---

<!-- The three search fields, all comma-separated. Only `keywords:` decides
     adoption; the other two are refinements and may stay blank.

     keywords         — the category, phrased the way a USER would say it.
     exclude_keywords — words that mean this result is the wrong domain.
                        Every ambiguous category has a collision: "recipe"
                        and "cookbook" also name Chef concepts, and before
                        this field existed every Stack Overflow result for a
                        recipe project was configuration-management
                        questions. Add a term here the first time you see a
                        false positive class, not the tenth.
     competitors      — real product names. Complaints about a NAMED product
                        are the highest-precision feedback available for
                        free, because a product name cannot collide the way
                        a category word does. Pull them from
                        memory/research/ once that research exists.

     A term added here changes what the 06:00 fetch retrieves the next
     morning. Verify the effect against a labelled pool before trusting it;
     reading one morning's output and forming an impression is not a check. -->


## Rubric

<!-- Fill in when the project starts. See GOALS.md for the format.
     Concrete and checkable, each with a weight. Write criteria that fit
     THIS project — don't keep a generic list verbatim. -->

-

## Current status

<!-- One or two lines, updated every cycle. What's true right now. -->

Not started.

## Score history

<!-- Append, don't rewrite. Newest at the bottom.
     Score is the CRITIC's score, not the builder's self-assessment
     (see "Scoring authority" in GOALS.md). Spent = budget actually
     consumed, so plateaus and overruns are both visible here. -->

| Date | Cycle | Score | Spent | Thesis outcome | Notes |
|------|-------|-------|-------|----------------|-------|
|      |       |       |       |                |       |

## Backlog

<!-- Next steps, roughly ordered. The critic files its findings here. -->

-

## Open questions for the human

<!-- Anything blocked on a decision only the human can make. Move to
     "Resolved" once answered instead of deleting, so there's a record. -->

### Waiting

-

### Resolved

-

## Assumptions made without a check-in

<!-- Per GOALS.md: if you proceeded on a conservative default instead of
     blocking, log it here so it gets reviewed even if nobody answered
     the Slack ping in time. -->

-
