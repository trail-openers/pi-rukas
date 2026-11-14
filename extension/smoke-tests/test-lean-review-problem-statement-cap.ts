#!/usr/bin/env bun
/**
 * The review statement's own cap, pinned by MEASURED length.
 *
 * Split from `test-lean-review-problem.ts` (AGENTS.md §12) because the two files
 * ask different questions of the same section. That file asks whether the
 * statement reaches a seat at all — presence, the two markers told apart, the
 * dedupe, the off arm's byte identity. This one asks how much of it the seat gets,
 * and asks it by number.
 *
 * The distinction is what makes the cap falsifiable. A truncation marker is
 * printed by ANY cap: `MAX_PROBLEM_CHARS = 6 000` (the prose's own bound),
 * `12 000` or `19 999` all leave every marker-presence assertion green, because a
 * body long enough to trigger the real cap is long enough to trigger a smaller
 * one. So nothing in this file rests on a marker being present. It measures the
 * characters the statement's fence kept, from both sides of the bound: the exact
 * kept length of an over-cap statement, and the WHOLE payload of a statement that
 * sits between `MAX_ISSUE_CHARS` and the cap.
 *
 * `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM` is pinned ON here — and read by the fixtures
 * at their own load, which is why the pin wraps the imports' use rather than
 * relying on the ambient default.
 *
 * Offline: pure functions over strings, no child, no model, no token.
 */

import { MAX_ISSUE_CHARS } from "../src/adversarial-prompts.ts";
import { renderSpecCriteriaSection } from "../src/lean/review-criteria.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  GOLDEN_PROBLEM_MARKER,
  MID_PROBLEM_BODY,
  MID_PROBLEM_SENTINEL,
  MID_PROBLEM_STATEMENT,
  PROBLEM_CAP_KEEP,
  PROBLEM_MARKER_FULL,
  STATEMENT_OVER_CAP_BODY,
  STATEMENT_OVER_CAP_SENTINEL,
  STATEMENT_OVER_CAP_STATEMENT,
  keptStatementSpan,
  keptStatementSpanFor,
} from "./lib/lean-review-problem-golden.ts";

const { assert, failures } = makeAssert();

await withEnv(
  { PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined, PI_ENSEMBLE_LEAN_REVIEW_PROBLEM: undefined },
  async () => {
    // ── the over-cap side: the kept span is the cap, to the character ────────
    {
      const kept = keptStatementSpan(renderSpecCriteriaSection(STATEMENT_OVER_CAP_BODY));
      // The prose block beside it prints no cut of its own and the criteria list is
      // three short rows, so this number can only be the statement's own bound.
      assert(
        kept === keptStatementSpanFor(STATEMENT_OVER_CAP_STATEMENT),
        `(cap) the kept statement span is exactly the cap plus the ellipsis plus its own marker — measured ${String(
          kept.length,
        )} chars, not merely a section that carries a marker`,
      );
      assert(
        kept.length === PROBLEM_CAP_KEEP + PROBLEM_MARKER_FULL.length + 1 &&
          kept.length > MAX_ISSUE_CHARS,
        `(cap) and that span (${String(kept.length)} chars) is past the prose bound of ${String(
          MAX_ISSUE_CHARS,
        )}, so what cut it is the statement's cap rather than the prose's`,
      );
      assert(
        kept.endsWith(`\u2026\n${PROBLEM_MARKER_FULL}`) &&
          kept.slice(0, PROBLEM_CAP_KEEP - 1) ===
            STATEMENT_OVER_CAP_STATEMENT.slice(0, PROBLEM_CAP_KEEP - 1) &&
          kept[PROBLEM_CAP_KEEP - 1] === "\u2026",
        "(cap) and the span is the statement verbatim up to the cap, the ellipsis `fenceText` appends, and the statement's marker on its own line",
      );
      assert(
        STATEMENT_OVER_CAP_STATEMENT.endsWith(STATEMENT_OVER_CAP_SENTINEL) &&
          !kept.includes(STATEMENT_OVER_CAP_SENTINEL),
        "(cap) and what the cap took is the statement's own closing clause — the section says so rather than ending silently",
      );
    }

    // ── the under-cap side: nothing may be kept away at all ─────────────────
    // A statement past the prose bound and well under its own cap must reach the
    // seat WHOLE. This is the arm a cap lowered toward the prose's cannot survive,
    // and the one that makes the marker's absence above a fact rather than a default.
    {
      const section = renderSpecCriteriaSection(MID_PROBLEM_BODY);
      const kept = keptStatementSpan(section);
      assert(
        kept === MID_PROBLEM_STATEMENT &&
          kept.length > MAX_ISSUE_CHARS &&
          kept.length < PROBLEM_CAP_KEEP,
        `(cap) a statement between the two bounds reaches the section WHOLE: ${String(
          kept.length,
        )} characters kept, past the prose bound, under the statement cap, with no marker at all`,
      );
      assert(
        !section.includes(GOLDEN_PROBLEM_MARKER) &&
          !kept.includes("\u2026") &&
          section.includes(MID_PROBLEM_SENTINEL),
        "(cap) and its last characters are present — the absence of the marker is a fact about the cap, not about a body that reached no bound",
      );
    }
  },
);

console.log(
  `\n${failures() === 0 ? "statement cap green" : "statement cap RED"} (${String(
    failures(),
  )} failing)`,
);
process.exit(failures());
