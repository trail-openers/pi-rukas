#!/usr/bin/env bun
/**
 * The lean review seats read the spec's `problem`, not only its criteria.
 *
 * The split (#2244) gave every review seat the criteria as its own section and
 * the prose bounded at `MAX_ISSUE_CHARS` — but it never printed `spec.problem`.
 * A statement whose tail sat past the prose bound therefore reached the lenses,
 * the adversarial reviewer and the fixer NOWHERE: the block was stripped from the
 * prose, and the criteria section carried rows only. `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM`
 * puts the statement back, at the head of the criteria section.
 *
 * The section is now two payloads under two bounds (the issue's E2):
 *
 *   - the statement, fenced at its own 20 000-char cap, saying
 *     `…(problem truncated)` when IT clipped;
 *   - the criteria list, fenced at its own 20 000-char cap, saying
 *     `…(criteria truncated)` when IT clipped.
 *
 * Neither marker may substitute for the other, and neither payload may be cut by
 * the other's cap. When the prose IS the statement — the shape `/plan` files,
 * whose body restates `problem` verbatim — the separate prose block is dropped,
 * so the statement appears once, under the section's cap rather than the prose's
 * (the same whitespace-collapsing rule `lean/issue-prose.ts` applies).
 *
 * `PI_ENSEMBLE_LEAN_REVIEW_PROBLEM=0` is the off arm, and `=0` alone — the split
 * left unset — must leave every brief byte-identical to the pre-split golden
 * (E4). `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=0` renders no statement regardless of
 * this switch: the problem half is gated by BOTH readers.
 *
 * `criteria: []` is E1's gate: the statement prints only when the criteria render
 * at least one row, so an empty list keeps today's raw bounded fallback whole.
 *
 * Offline: mocked spawns, no model, no token.
 */

import { ADVERSARIAL_FINDING_RULE } from "../src/adversarial-prompts.ts";
import {
  LEAN_REVIEW_CRITERIA_HEADING,
  renderSpecCriteriaSection,
} from "../src/lean/review-criteria.ts";
import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import {
  leanReviewSpecSplitEnabled,
  renderReviewIssueBlock,
  renderReviewProse,
} from "../src/lean/review-spec-split.ts";
import { leanReviewProblemEnabled } from "../src/lean/review-problem-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { runReviewStepCapturingProblem } from "./lib/lean-review-problem-capture.ts";
import {
  D3_COUNT,
  MANY_CRITERIA_40_BODY,
  MEDIUM_SPEC_BODY,
  SMALL_SPEC_BODY,
  SPEC_BODY,
} from "./lib/lean-review-spec-fixture.ts";
import {
  GOLDEN_BODIES,
  OVER_PROBLEM_BODY,
  goldenFixIssueSection,
  goldenLensContext,
} from "./lib/lean-review-spec-split-golden.ts";
import {
  BOTH_PAYLOADS_OVER_CAP_BODY,
  EMPTY_CRITERIA_BODY,
  FENCE_CHAR,
  GOLDEN_PROBLEM_MARKER,
  OVER_PROBLEM_STATEMENT_BODY,
  PROBLEM_DIFFERS_BODY,
  PROBLEM_EQUALS_PROSE_BODY,
  PROBLEM_LEAD,
  PROBLEM_TAIL,
  PROSE_HEAD_LINE,
  SPEC_JSON_KEYS,
  criteriaSpanOf,
  criterionRow,
  fixerArgs,
  fenceLines,
  preStatementCriteriaSection,
  preStatementFixerIssueSection,
  preStatementLensContext,
  preStatementLensIssueBlock,
  renderedCriterionRow,
  seats,
} from "./lib/lean-review-problem-golden.ts";

const { assert, failures } = makeAssert();

// ── (1) the truth table: only the literal "0" is off, read at call time ──────
{
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    // The split is left at its own default so this table measures ONE variable.
    await withEnv(
      { PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined, PI_ENSEMBLE_LEAN_REVIEW_PROBLEM: value },
      async () => {
        assert(
          leanReviewProblemEnabled() === want,
          `(1) PI_ENSEMBLE_LEAN_REVIEW_PROBLEM=${JSON.stringify(value)} reads ${String(want)}`,
        );
      },
    );
  }
  // E4: the statement half is gated by BOTH readers.
  await withEnv(
    { PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: "0", PI_ENSEMBLE_LEAN_REVIEW_PROBLEM: undefined },
    async () => {
      assert(
        !leanReviewSpecSplitEnabled() && leanReviewProblemEnabled(),
        "(1) with the split off the statement renders nothing even though its own switch is on",
      );
      // The half this switch owns is gated by BOTH readers (E4). `renderSpec-
      // CriteriaSection` renders on its own when it is called directly — the seam
      // that decides whether a seat is called with it at all is the split — so the
      // claim is made on the brief: with the split off, no seat is handed a
      // criteria section, and so no seat is handed the statement either.
      assert(
        !lensContext(7, "full", { issueBody: SPEC_BODY }).includes(LEAN_REVIEW_CRITERIA_HEADING) &&
          lensContext(7, "full", { issueBody: SPEC_BODY }) ===
            goldenLensContext(SPEC_BODY) &&
          fixPrompt(fixerArgs(SPEC_BODY) as never).indexOf(LEAN_REVIEW_CRITERIA_HEADING) === -1,
        "(1) and with the split off no brief carries a criteria section — so none carries the statement either",
      );
    },
  );
}

// ── (2) the statement reaches every seat, past the prose bound ───────────────
await withEnv(
  { PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: undefined, PI_ENSEMBLE_LEAN_REVIEW_PROBLEM: undefined },
  async () => {
    {
      const s = seats(OVER_PROBLEM_STATEMENT_BODY);
      assert(
        !s.prose.includes("PROBLEM-TAIL-") &&
          (s.prose.match(/…\(issue truncated\)/g) ?? []).length === 1 &&
          s.criteria.includes("PROBLEM-TAIL-"),
        "(2) non-vacuity: the prose bound cuts the statement's tail and says so, while the section holds it",
      );
      for (const [seat, text] of [
        ["criteria section", s.criteria],
        ["issue block", s.block],
        ["lens brief", s.lens],
        ["fixer brief", s.fix],
      ] as const) {
        assert(
          criteriaSpanOf(text).includes("PROBLEM-TAIL-"),
          `(2) the ${seat} carries the statement's tail INSIDE the criteria section`,
        );
      }
      // Non-vacuity for the fence count below: the two sub-blocks are two fences,
      // so the section opens ` ```text ` twice and closes twice.
      assert(
        (s.criteria.match(/^```text$/gm) ?? []).length === 2,
        `(2) and the section holds exactly two fenced payloads (${String(
          (s.criteria.match(/^```text$/gm) ?? []).length,
        )})`,
      );
      assert(
        s.criteria.includes(PROBLEM_LEAD),
        "(2) and the section says what the block above the list is",
      );
      assert(
        s.criteria.indexOf(PROBLEM_LEAD) < s.criteria.indexOf("**AC1** ["),
        "(2) and the statement OPENS the section: it sits above the criteria list",
      );
      assert(
        !s.lens.includes("PROBLEM-TAIL-") || criteriaSpanOf(s.lens).includes("PROBLEM-TAIL-"),
        "(2) the lens brief carries the tail nowhere but the section",
      );
      assert(
        fenceLines(s.criteria) === 4,
        `(2) and the section's four fence delimiters pair (${String(
          fenceLines(s.criteria),
        )})`,
      );
    }

    // ── (3) dedupe: the prose IS the statement ───────────────────────────────
    {
      const s = seats(PROBLEM_EQUALS_PROSE_BODY);
      const statement = "and say so in one fixed sentence";
      assert(
        s.prose.includes(statement),
        "(3) non-vacuity: the renderer can produce the prose block for this body at all",
      );
      assert(
        s.block ===
          `\n\n${s.block.trim().split("\n\n")[0]}\n\n${s.criteria}`,
        "(3) with the prose equal to spec.problem the separate prose block is omitted",
      );
      const occurrences = criteriaSpanOf(s.block).split(statement).length - 1;
      assert(
        occurrences === 1,
        `(3) and the statement appears ONCE in the brief, under the section's cap (saw ${String(occurrences)})`,
      );
      assert(
        s.block.includes(LEAN_REVIEW_CRITERIA_HEADING) &&
          criterionRow("AC1").test(s.block),
        "(3) while the criteria still print beside it",
      );
    }

    // ── (4) no dedupe when the prose differs from the statement ──────────────
    {
      const s = seats(PROBLEM_DIFFERS_BODY);
      assert(
        s.prose.includes("which is a ledger of draws") &&
          criteriaSpanOf(s.block).includes("refuse the draw once the quota is spent"),
        "(4) a prose that differs from the statement keeps its own block AND gains the statement",
      );
    }

    // ── (5) two payloads, two bounds (E2) ────────────────────────────────────
    {
      const statementClip = renderSpecCriteriaSection(OVER_PROBLEM_BODY);
      const criteriaClip = renderSpecCriteriaSection(MANY_CRITERIA_40_BODY);
      // The arm the plain clip cannot reach: the statement is over its OWN cap
      // while the list beside it is nowhere near its own, and the other way round
      // for the second body. A substitution whose regex were unanchored over the
      // whole section would rewrite the wrong payload's notice here.
      assert(
        statementClip.includes(GOLDEN_PROBLEM_MARKER) &&
          !statementClip.includes("…(criteria truncated)"),
        "(5) a statement past its own cap says `…(problem truncated)` while its one-row list is not reported as cut",
      );
      assert(
        criteriaClip.includes("…(criteria truncated)") &&
          !criteriaClip.includes(GOLDEN_PROBLEM_MARKER),
        `(5) and ${String(D3_COUNT)} criteria past the cap say \`…(criteria truncated)\` while the statement — nowhere near its cap — is not reported as cut`,
      );
      // Both bounds firing in one section, each payload keeping its own marker.
      const bothClip = renderSpecCriteriaSection(BOTH_PAYLOADS_OVER_CAP_BODY);
      assert(
        (bothClip.match(/…\(problem truncated\)/g) ?? []).length === 1 &&
          (bothClip.match(/…\(criteria truncated\)/g) ?? []).length === 1,
        "(5) with BOTH payloads over their caps: one of each marker, each substituted only inside its own payload",
      );
      assert(
        !/\[truncated at /.test(statementClip) && !/\[truncated at /.test(criteriaClip),
        "(5) and neither payload leaks `fenceText`'s generic clip notice",
      );
      assert(
        criteriaClip.includes(renderedCriterionRow(MANY_CRITERIA_40_BODY, "AC1")),
        "(5) with the FIRST criterion still printed verbatim — the cut is at the tail, not the head",
      );
      const clippedSection = criteriaClip;
      // Two fenced payloads: two openers and two closers, twelve characters of the
      // fence character in all, and every payload's own backtick run neutralised —
      // so nothing inside the section can close a fence the prompt opened, even
      // where the clip landed mid-run. Counted with `split`: an escape for the
      // fence character inside a regex literal reads as the literal's terminator.
      assert(
        fenceLines(clippedSection) === 4 &&
          (clippedSection.match(/^```text$/gm) ?? []).length === 2 &&
          clippedSection.endsWith("\n```") &&
          clippedSection.split(FENCE_CHAR).length === 13 &&
          (clippedSection.match(/\u02cb/g) ?? []).length === 0,
        `(5) and the section's fences stay intact across the clip (${String(
          fenceLines(clippedSection),
        )} delimiters, ${String(
          (clippedSection.match(/^```text$/gm) ?? []).length,
        )} openers, ${String(clippedSection.split(FENCE_CHAR).length - 1)} fence characters)`,
      );
    }

    // ── (6) D3: ≥40 criteria over 20 000 characters, in a real brief ─────────
    {
      const lens = lensContext(7, "full", { issueBody: MANY_CRITERIA_40_BODY });
      assert(
        (lens.match(/…\(criteria truncated\)/g) ?? []).length === 1,
        "(6) the lens brief carries exactly one criteria marker",
      );
      assert(
        (lens.match(/…\(criteria truncated\)/g) ?? []).length === 1 &&
          !lens.includes(GOLDEN_PROBLEM_MARKER) &&
          !lens.includes("…(issue truncated)") &&
        lens.includes(PROSE_HEAD_LINE),
        "(6) and the cuts stay tellable apart in one brief: the prose cut once and said so, the list cut once and said so, and the statement — well under its cap — said nothing",
      );
      assert(
        lens.includes(renderedCriterionRow(MANY_CRITERIA_40_BODY, "AC1")),
        "(6) and the first criterion is there",
      );
      assert(
        lens.includes(LEAN_REVIEW_CRITERIA_HEADING),
        "(6) and the section is opened by name",
      );
    }

    // ── (7) E1: `criteria: []` keeps today's raw bounded fallback ────────────
    {
      const s = seats(EMPTY_CRITERIA_BODY);
      assert(
        renderSpecCriteriaSection(EMPTY_CRITERIA_BODY) === "",
        "(7) a spec that parses with no criteria renders no section at all — no statement block",
      );
      assert(
        s.block.includes(renderReviewProse(EMPTY_CRITERIA_BODY)) &&
          !s.block.includes(LEAN_REVIEW_CRITERIA_HEADING) &&
          s.lens === goldenLensContext(EMPTY_CRITERIA_BODY),
        "(7) and the seat reads the raw bounded fallback exactly as today: the pre-split lead-in over the prose, no section, and a byte-identical lens brief",
      );
      assert(
        !s.block.includes(LEAN_REVIEW_CRITERIA_HEADING),
        "(7) with no criteria heading anywhere in it",
      );
      assert(
        s.lens === goldenLensContext(EMPTY_CRITERIA_BODY),
        "(7) and the lens brief is byte-identical to the pre-split render",
      );
      assert(
        s.fix.includes("What this change was asked to do") === false ||
          !s.fix.includes(LEAN_REVIEW_CRITERIA_HEADING),
        "(7) and the fixer brief gains no section",
      );
    }

    // ── (8) the child was actually dispatched with the statement ─────────────
    {
      const captured = await runReviewStepCapturingProblem(OVER_PROBLEM_STATEMENT_BODY);
      assert(
        captured.adversarialBriefs.length >= 1 &&
          captured.fixBriefs.length === 1 &&
          captured.contexts.length >= 1,
        `(8) the step dispatched a reviewer, a fixer and a lens (reviewer ${String(
          captured.adversarialBriefs.length,
        )}, fixer ${String(captured.fixBriefs.length)}, lens ${String(
          captured.contexts.length,
        )}, verdict ${captured.verdict})`,
      );
      const briefs = [
        ...captured.adversarialBriefs,
        ...captured.fixBriefs,
        ...captured.contexts,
      ];
      for (const [i, brief] of briefs.entries()) {
        assert(
          criteriaSpanOf(brief).includes("PROBLEM-TAIL-"),
          `(8) brief ${String(i)} was dispatched with the statement's tail inside the section`,
        );
        // The strongest thing a step capture can say about a brief: the statement's
        // tail reaches it INSIDE the section (just asserted) and the raw spec block
        // reaches it NOWHERE. The block's JSON keys are not checked on this body —
        // it sits under the prose bound, so the keys are stripped by the layer and
        // the key-level negative is pinned by the split's own ON arm.
        assert(
          !SPEC_JSON_KEYS.some((key) => brief.includes(key)),
          `(8) and brief ${String(i)} carries none of the raw spec block's JSON — no ${SPEC_JSON_KEYS.map((k) => JSON.stringify(k)).join(" and no ")} appears in it (saw ${JSON.stringify(
            brief.split("\n").find((l) => SPEC_JSON_KEYS.some((k) => l.includes(k))) ?? "",
          )})`,
        );
      }
    }
  },
);

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
      const lensGolden = hasSection
        ? preStatementLensContext(body)
        : goldenLensContext(body);
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
      offDedupe.block ===
        preStatementLensIssueBlock(PROBLEM_EQUALS_PROSE_BODY) &&
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
  `\n${failures() === 0 ? "review-problem green" : "review-problem RED"} (${String(
    failures(),
  )} failing)`,
);
process.exit(failures());
