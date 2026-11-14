#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM=0` is byte-identical to the render from before
 * the statement existed.
 *
 * Split from `test-lean-review-problem.ts` (AGENTS.md §12): the on arm asks what a
 * seat receives, this asks what the switch takes away, and the two are compared
 * against different things — the on arm against the fixtures, this against the
 * pre-statement goldens in `lib/lean-review-problem-golden.ts`. The split is left
 * UNSET throughout (E4): this is the arm an operator reaches for to revert the
 * statement ALONE, so it must land on the pre-split bytes, not merely on the
 * pre-statement ones.
 *
 * The goldens live outside the module under change for the reason stated in that
 * lib's header: a golden that read the section's caps, markers or lead back from
 * `lean/review-criteria.ts` could not catch that module changing them.
 *
 * Offline: pure functions over strings, no child, no model, no token.
 */

import { ADVERSARIAL_FINDING_RULE } from "../src/adversarial-prompts.ts";
import { renderSpecCriteriaSection } from "../src/lean/review-criteria.ts";
import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import { leanReviewProblemEnabled } from "../src/lean/review-problem-switch.ts";
import {
  leanReviewSpecSplitEnabled,
  renderReviewIssueBlock,
  renderReviewProse,
} from "../src/lean/review-spec-split.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  EMPTY_CRITERIA_BODY,
  OVER_PROBLEM_STATEMENT_BODY,
  PROBLEM_EQUALS_PROSE_BODY,
  criteriaSpanOf,
  fixerArgs,
  preStatementCriteriaSection,
  preStatementFixerIssueSection,
  preStatementLensContext,
  preStatementLensIssueBlock,
} from "./lib/lean-review-problem-golden.ts";
import {
  GOLDEN_BODIES,
  goldenFixIssueSection,
  goldenLensContext,
} from "./lib/lean-review-spec-split-golden.ts";

const { assert, failures } = makeAssert();

// ── (9) the OFF arm: `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM=0` is byte-identical ───
// The split is left UNSET here (E4): this is the arm an operator reaches for to
// revert the statement alone, and it must land on the pre-split bytes.
await withEnv(
  { PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined, PI_ENSEMBLE_LEAN_REVIEW_PROBLEM: "0" },
  async () => {
    assert(
      !leanReviewProblemEnabled() && leanReviewSpecSplitEnabled(),
      "(9) the off arm: this switch off, the split still on",
    );
    for (const [name, body] of Object.entries(GOLDEN_BODIES)) {
      // What the lens was handed BEFORE the statement existed: the split's own
      // golden, plus the criteria section as it read with nothing above the list.
      // `PROBLEM=0` reverts the statement alone, so the split's own behaviour —
      // including the prose block it drops when the body restates its statement —
      // stays, and the golden says so.
      const lens = lensContext(7, "full", { issueBody: body });
      // A body with no parsable block has no section, so the statement switch
      // reaches none of it: that arm belongs to the split's own golden, which
      // `lensContext` is compared against directly below when the section is empty.
      const hasSection = preStatementCriteriaSection(body) !== "";
      const lensGolden = hasSection ? preStatementLensContext(body) : goldenLensContext(body);
      assert(
        lensGolden.length > 0 && lens === lensGolden,
        `(9) off arm: the lens brief for "${name}" is byte-identical (${String(
          lens.length,
        )} chars vs ${String(lensGolden.length)})`,
      );
      const brief = fixPrompt(fixerArgs(body) as never);
      const fixGolden = hasSection
        ? preStatementFixerIssueSection(body)
        : goldenFixIssueSection(body);
      // The brief's own section order, read from the print site: the issue block is
      // followed by the decline section when there is one, and `## The findings`
      // comes after it. Slicing to the FIRST of the two would cut the decline
      // section out of the span the golden is supposed to cover.
      const decline = brief.indexOf("\n## Declining a finding that contradicts the issue");
      const findings = brief.indexOf("\n## The findings");
      const fixEnd = findings > 0 ? findings : decline;
      // The span under test: from the newline that ENDS the brief's own first line
      // (that newline included) to the next section heading the print site wrote.
      const fixSection = brief.slice(brief.indexOf("\n"), fixEnd);
      assert(
        fixGolden.length > 0 && fixSection === fixGolden,
        `(9) off arm: the fixer brief's issue section for "${name}" is byte-identical`,
      );
      const criteria = renderSpecCriteriaSection(body);
      assert(
        criteria === preStatementCriteriaSection(body),
        `(9) off arm: the criteria section for "${name}" is byte-identical to the render from before the statement was added (${String(
          criteria.length,
        )} chars vs ${String(preStatementCriteriaSection(body).length)})`,
      );
      // Non-vacuity: a golden that rendered "" for every body would make the four
      // assertions above pass on a renderer that printed nothing.
      assert(
        name === "issue" || name === "over" || criteria.length > 0 || lens.length > 0,
        `(9) off arm: "${name}" is a real body (${String(lens.length)} lens chars, ${String(
          criteria.length,
        )} criteria chars)`,
      );
    }
    // The arm this switch exists for: with `=0` the statement is NOT printed, and
    // the seat that would have read its tail reads the bounded prose instead —
    // i.e. it loses it, exactly as it did before the switch.
    const off = {
      prose: renderReviewProse(OVER_PROBLEM_STATEMENT_BODY),
      criteria: renderSpecCriteriaSection(OVER_PROBLEM_STATEMENT_BODY),
      lens: lensContext(7, "full", { issueBody: OVER_PROBLEM_STATEMENT_BODY }),
    };
    assert(
      !off.criteria.includes("PROBLEM-TAIL-") && !off.lens.includes("PROBLEM-TAIL-"),
      "(9) with `=0` the statement's tail reaches no seat, as before",
    );
    assert(
      off.lens === preStatementLensContext(OVER_PROBLEM_STATEMENT_BODY),
      "(9) and that lens brief is byte-identical to the render from before the statement existed",
    );
    const offDedupe = {
      prose: renderReviewProse(PROBLEM_EQUALS_PROSE_BODY),
      block: renderReviewIssueBlock(PROBLEM_EQUALS_PROSE_BODY, ADVERSARIAL_FINDING_RULE),
      lens: lensContext(7, "full", { issueBody: PROBLEM_EQUALS_PROSE_BODY }),
    };
    assert(
      // The dedupe belongs to the split, not to this switch: with `=0` the prose
      // block keeps printing beside the criteria section — the pre-change shape,
      // where a body that restated its own statement printed it twice.
      offDedupe.block === preStatementLensIssueBlock(PROBLEM_EQUALS_PROSE_BODY) &&
        offDedupe.prose.includes("one fixed sentence") &&
        !criteriaSpanOf(offDedupe.block).includes("one fixed sentence"),
      "(9) and with the switch off the prose block prints next to the criteria section, statement and all, as it did before",
    );
    assert(
      offDedupe.lens === preStatementLensContext(PROBLEM_EQUALS_PROSE_BODY),
      "(9) and that brief is byte-identical too, on the body whose prose restates its own statement",
    );
    const offEmpty = renderSpecCriteriaSection(EMPTY_CRITERIA_BODY);
    assert(offEmpty === "", "(9) and the `criteria: []` fallback holds on the off arm too");
  },
);

console.log(
  `\n${failures() === 0 ? "off arm green" : "off arm RED"} (${String(failures())} failing)`,
);
process.exit(failures());
