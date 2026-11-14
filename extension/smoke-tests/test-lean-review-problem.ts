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
  SPEC_TAIL_CONSTRAINT,
} from "./lib/lean-review-spec-fixture.ts";
import {
  GOLDEN_BODIES,
  GOLDEN_CLIP_NOTICE,
  GOLDEN_PROBLEM_MARKER,
  OVER_PROBLEM_BODY,
  criterionLine,
  goldenAdversarialIssueBlock,
  goldenFixIssueSection,
  goldenLensContext,
  goldenSpecCriteriaSection,
  rawBlockPayload,
  renderedCriterionLine,
} from "./lib/lean-review-spec-split-golden.ts";

const { assert, failures } = makeAssert();

/** A statement whose tail the prose bound cuts: the seat reads it ONLY through
 * the criteria section, which is the whole claim under test. */
const PROBLEM_TAIL = `PROBLEM-TAIL-${"statement ".repeat(300)}`;

/** A body whose `problem` is over the prose bound, with three short criteria.
 * Nothing else in the brief carries the statement's tail. */
const OVER_PROBLEM_STATEMENT_BODY: string = (() => {
  const json = JSON.stringify(
    {
      problem: `The meter must refuse the draw once the quota is spent, and say so in one fixed sentence. ${PROBLEM_TAIL}`,
      criteria: [
        { id: "AC1", text: "The meter refuses the draw.", verify: "test" },
        { id: "AC2", text: "The refusal names the quota.", verify: "test" },
        { id: "AC3", text: "The counter never goes negative.", verify: "manual" },
      ],
      size: "M",
    },
    null,
    2,
  );
  return `Add a quota check to the meter.\n\n${SPEC_TAIL_CONSTRAINT}\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();

/** A body whose prose, once its block is stripped, IS its `problem` — the shape
 * `/plan` files. The statement appears once, under the section's cap. */
const PROBLEM_EQUALS_PROSE_BODY: string = (() => {
  const problem =
    "The meter must refuse the draw once the quota is spent,\n  and say so in one fixed sentence.";
  const json = JSON.stringify(
    {
      problem,
      criteria: [{ id: "AC1", text: "The meter refuses the draw.", verify: "test" }],
      size: "S",
    },
    null,
    2,
  );
  return `${problem}\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();

/** A body whose prose differs from its `problem` even after whitespace is
 * collapsed: both blocks must print, and the dedupe must not fire. */
const PROBLEM_DIFFERS_BODY: string = (() => {
  const json = JSON.stringify(
    {
      problem: "The meter must refuse the draw once the quota is spent.",
      criteria: [{ id: "AC1", text: "The meter refuses the draw.", verify: "test" }],
      size: "S",
    },
    null,
    2,
  );
  return `Add a quota check to the meter, which is a ledger of draws.\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();

/** A body that PARSES with `criteria: []` — the E1 case. `parsePiSpec` accepts an
 * empty list; `readiness()` is what refuses it on a real run. */
const EMPTY_CRITERIA_BODY: string = (() => {
  const json = JSON.stringify(
    { problem: "The meter must refuse the draw once the quota is spent.", criteria: [], size: "S" },
    null,
    2,
  );
  return `Add a quota check to the meter.\n\n${SPEC_TAIL_CONSTRAINT}\n\n\`\`\`pi-spec v1\n${json}\n\`\`\`\n`;
})();

/** The statement sub-block's own lead-in, named here so the assertion that the
 * seat is TOLD what the statement is does not hard-code a sentence the renderer
 * could reword out from under it. */
const PROBLEM_LEAD = "The statement of the problem this run is for";

/** The fixer's args with nothing variable in them but the body. */
function fixerArgs(issueBody: string | undefined): Record<string, unknown> {
  return {
    issue: 7,
    wave: "full",
    gate: "six-lens review (ISSUES_FOUND)",
    findings: "- [HIGH] SECURITY a.ts:1: reword the exception",
    worktree: "/repo/.worktrees/lean-7-fix-l-1-0-1793451347919",
    repoRoot: "/repo",
    branch: "lean/issue-7",
    base: "deadbeef",
    head: "cafebabe",
    frozenPaths: ["tests/AC1.test.ts"],
    budget: { opts: {}, fired: () => undefined },
    stop: {},
    issueBody,
  };
}

/** One seat's print: the pure renderers plus the two briefs that call them. */
function seats(body: string) {
  return {
    prose: renderReviewProse(body),
    criteria: renderSpecCriteriaSection(body),
    block: renderReviewIssueBlock(body, "Judge the diff against it."),
    lens: lensContext(7, "full", { issueBody: body }),
    fix: fixPrompt(fixerArgs(body) as never),
  };
}

/** Everything in a brief AFTER the criteria heading — the section a seat reads as
 * its contract, and the only place the statement may appear. */
function sectionOf(brief: string): string {
  return brief.split(LEAN_REVIEW_CRITERIA_HEADING)[1] ?? "";
}

/** The character a fence is built from, as a string: counted with `split` rather
 * than a regex, where an escape for it reads as the literal's own terminator. */
const FENCE_CHAR = "\u0060";

/** Count fence lines at the start of a line, so a brief's fences are paired. */
function fenceLines(text: string): number {
  return (text.match(/^```/gm) ?? []).length;
}

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
      assert(
        lensContext(7, "full", { issueBody: SPEC_BODY }) ===
          goldenLensContext(SPEC_BODY) &&
          renderSpecCriteriaSection(SPEC_BODY) === goldenSpecCriteriaSection(SPEC_BODY),
        "(1) and with the split off no brief carries the statement block — the statement half needs BOTH switches on",
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
          (s.prose.match(/…\(issue truncated\)/g) ?? []).length === 1,
        "(2) non-vacuity: the prose bound cuts the statement's tail and says so",
      );
      for (const [seat, text] of [
        ["criteria section", s.criteria],
        ["issue block", s.block],
        ["lens brief", s.lens],
        ["fixer brief", s.fix],
      ] as const) {
        assert(
          sectionOf(text).includes("PROBLEM-TAIL-"),
          `(2) the ${seat} carries the statement's tail INSIDE the criteria section`,
        );
      }
      assert(
        s.criteria.includes(PROBLEM_LEAD),
        "(2) and the section says what the block above the list is",
      );
      assert(
        s.criteria.indexOf(PROBLEM_LEAD) < s.criteria.indexOf("**AC1** ["),
        "(2) and the statement OPENS the section: it sits above the criteria list",
      );
      assert(
        !s.lens.includes("PROBLEM-TAIL-") || sectionOf(s.lens).includes("PROBLEM-TAIL-"),
        "(2) the lens brief carries the tail nowhere but the section",
      );
      assert(
        fenceLines(s.criteria) === 4,
        `(2) and the section is two fenced payloads, so its fences pair (${String(
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
      const occurrences = sectionOf(s.block).split(statement).length - 1;
      assert(
        occurrences === 1,
        `(3) and the statement appears ONCE in the brief, under the section's cap (saw ${String(occurrences)})`,
      );
      assert(
        s.block.includes(LEAN_REVIEW_CRITERIA_HEADING) &&
          criterionLine("AC1").test(s.block),
        "(3) while the criteria still print beside it",
      );
    }

    // ── (4) no dedupe when the prose differs from the statement ──────────────
    {
      const s = seats(PROBLEM_DIFFERS_BODY);
      assert(
        s.prose.includes("which is a ledger of draws") &&
          sectionOf(s.block).includes("refuse the draw once the quota is spent"),
        "(4) a prose that differs from the statement keeps its own block AND gains the statement",
      );
    }

    // ── (5) two payloads, two bounds (E2) ────────────────────────────────────
    {
      const statementClip = renderSpecCriteriaSection(OVER_PROBLEM_BODY);
      assert(
        statementClip.includes(GOLDEN_PROBLEM_MARKER),
        "(5) a statement past its own cap says `…(problem truncated)`",
      );
      assert(
        !statementClip.includes("…(criteria truncated)") &&
          !statementClip.includes(GOLDEN_CLIP_NOTICE),
        "(5) and the criteria list — one row, nowhere near its cap — is not reported as cut",
      );
      assert(
        statementClip.includes("**AC1**"),
        "(5) while the criteria themselves survive whole",
      );

      const criteriaClip = renderSpecCriteriaSection(MANY_CRITERIA_40_BODY);
      assert(
        criteriaClip.includes("…(criteria truncated)"),
        `(5) ${String(D3_COUNT)} criteria past the cap say \`…(criteria truncated)\``,
      );
      assert(
        !criteriaClip.includes(GOLDEN_PROBLEM_MARKER) &&
          !criteriaClip.includes(GOLDEN_CLIP_NOTICE),
        "(5) and the statement — nowhere near its cap — is not reported as cut",
      );
      assert(
        criteriaClip.includes(renderedCriterionLine(MANY_CRITERIA_40_BODY, "AC1")),
        "(5) with the FIRST criterion still printed verbatim — the cut is at the tail, not the head",
      );
      assert(
        fenceLines(criteriaClip) % 2 === 0 &&
          criteriaClip.startsWith("```text\n") &&
          criteriaClip.endsWith("\n```") &&
          criteriaClip.split(FENCE_CHAR).length === 7,
        `(5) and the section's fences stay intact across the clip (${String(
          fenceLines(criteriaClip),
        )} fence lines)`,
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
        (lens.match(/…\(issue truncated\)/g) ?? []).length === 1 &&
          (lens.match(/…\(problem truncated\)/g) ?? []).length === 1,
        "(6) and all three cuts stay tellable apart in one brief",
      );
      assert(
        lens.includes(renderedCriterionLine(MANY_CRITERIA_40_BODY, "AC1")),
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
          sectionOf(brief).includes("PROBLEM-TAIL-"),
          `(8) brief ${String(i)} was dispatched with the statement's tail inside the section`,
        );
        const raw = rawBlockPayload(OVER_PROBLEM_STATEMENT_BODY);
        assert(
          raw.length > 0 && !raw.some((needle) => !sectionOf(brief).includes(needle) && brief.includes(needle)),
          `(8) and brief ${String(i)} prints none of the raw spec block outside the section`,
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
      const lens = lensContext(7, "full", { issueBody: body });
      const lensGolden = goldenLensContext(body);
      assert(
        lensGolden.length > 0 && lens === lensGolden,
        `(9) off arm: the lens brief for "${name}" is byte-identical (${String(
          lens.length,
        )} chars vs ${String(lensGolden.length)})`,
      );
      const brief = fixPrompt(fixerArgs(body) as never);
      const fixGolden = goldenFixIssueSection(body);
      const fixSection = brief.slice(brief.indexOf("\n"), brief.indexOf("\n## The findings"));
      assert(
        fixGolden.length > 0 && fixSection === fixGolden,
        `(9) off arm: the fixer brief's issue section for "${name}" is byte-identical`,
      );
      const criteria = renderSpecCriteriaSection(body);
      assert(
        criteria === goldenSpecCriteriaSection(body),
        `(9) off arm: the criteria section for "${name}" is byte-identical (${String(
          criteria.length,
        )} chars vs ${String(goldenSpecCriteriaSection(body).length)})`,
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
    const off = seats(OVER_PROBLEM_STATEMENT_BODY);
    assert(
      !off.criteria.includes("PROBLEM-TAIL-") && !off.lens.includes("PROBLEM-TAIL-"),
      "(9) with `=0` the statement's tail reaches no seat, as before",
    );
    assert(
      off.lens === goldenLensContext(OVER_PROBLEM_STATEMENT_BODY),
      "(9) and that lens brief is byte-identical to the pre-split render",
    );
    const offDedupe = seats(PROBLEM_EQUALS_PROSE_BODY);
    assert(
      offDedupe.block === renderReviewIssueBlock(PROBLEM_EQUALS_PROSE_BODY, "Judge the diff against it.") &&
        offDedupe.prose.includes("one fixed sentence"),
      "(9) and the prose block is never dropped by the dedupe when the switch is off",
    );
    assert(
      offDedupe.lens === goldenLensContext(PROBLEM_EQUALS_PROSE_BODY),
      "(9) with the same body, whose prose restates its own statement",
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
