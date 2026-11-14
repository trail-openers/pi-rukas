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
 * this switch: the problem half is gated by BOTH readers. That arm — every brief
 * compared against the pre-statement goldens — is
 * `test-lean-review-problem-off-arm.ts`.
 *
 * How much of the statement a seat gets — the cap measured, not merely marked —
 * is `test-lean-review-problem-statement-cap.ts`. Presence and length are kept
 * apart because a marker is printed by ANY cap, so a file that only ever asked for
 * a marker could never see the bound move.
 *
 * `criteria: []` is E1's gate: the statement prints only when the criteria render
 * at least one row, so an empty list keeps today's raw bounded fallback whole.
 *
 * Offline: mocked spawns, no model, no token.
 */

import { ADVERSARIAL_FINDING_RULE } from "../src/adversarial-prompts.ts";
import { ISSUE_TRUNCATION_MARKER as ISSUE_TRUNCATED_MARK } from "../src/adversarial-prompts.ts";
import {
  LEAN_REVIEW_CRITERIA_HEADING,
  renderSpecCriteriaSection,
} from "../src/lean/review-criteria.ts";
import { fixPrompt, lensContext } from "../src/lean/review-deps.ts";
import {
  leanReviewSpecSplitEnabled,
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
  OVER_PROBLEM_BODY,
  goldenLensContext,
} from "./lib/lean-review-spec-split-golden.ts";
import {
  EMPTY_CRITERIA_BODY,
  FENCE_CHAR,
  GOLDEN_PROBLEM_MARKER,
  OVER_PROBLEM_STATEMENT_BODY,
  PROBLEM_DIFFERS_BODY,
  PROBLEM_EQUALS_PROSE_BODY,
  PROBLEM_LEAD,
  PROBLEM_LEAD_ABOVE_CLAIMS,
  PROBLEM_TAIL,
  PROSE_HEAD_LINE,
  SPEC_JSON_KEYS,
  BOTH_PAYLOADS_OVER_CAP_BODY,
  criteriaFenceOf,
  criteriaSpanOf,
  criterionRow,
  fixerArgs,
  fenceLines,
  renderedCriterionRow,
  seats,
  statementFenceOf,
} from "./lib/lean-review-problem-golden.ts";
import {
  CRITERIA_QUOTE_PROBLEM_MARKER_BODY,
  PROBLEM_QUOTES_CRITERIA_MARKER_BODY,
} from "./lib/lean-review-problem-quoting.ts";

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
      // The lead sentence is part of what the seat reads, and it makes a claim
      // about the rest of the brief. On THIS shape the claim is the one thing the
      // renderer cannot honour: the prose block is gone, so a lead that sends the
      // reader to issue text above is pointing at nothing.
      assert(
        s.block.includes(ISSUE_TRUNCATED_MARK) === false &&
          s.lens.includes(ISSUE_TRUNCATED_MARK) === false,
        "(3) non-vacuity for the lead below: no `…(issue truncated)` line anywhere in the brief — the prose block is really absent, not merely short",
      );
      const lead = s.criteria.slice(
        s.criteria.indexOf(PROBLEM_LEAD),
        s.criteria.indexOf("\n```text", s.criteria.indexOf(PROBLEM_LEAD)),
      );
      const claimed = PROBLEM_LEAD_ABOVE_CLAIMS.filter((needle) =>
        lead.toLowerCase().includes(needle),
      );
      assert(
        lead.startsWith(PROBLEM_LEAD) &&
          claimed.length === 0,
        `(3) the lead sends the seat nowhere it cannot read: the prose block is dropped on this shape, yet the lead says ${JSON.stringify(
          claimed,
        )}`,
      );
      // The other half of the sentence still has to be there — a lead "fixed" by
      // deleting its claim about the prose would leave the seat told nothing.
      assert(
        /omitted|drop/i.test(lead) && /short/i.test(lead),
        "(3) and the lead still says the prose is the shorter thing and gets omitted when it only restates this",
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
      // The arm that keeps the marker substitution honest. Issue text can QUOTE a
      // marker, and `fenceText` writes its notice after the backtick neutralisation,
      // so a quoted marker survives verbatim into the kept window. A renderer that
      // clipped first and swapped its marker in by rewriting the notice pattern over
      // the finished fence replaced the FIRST match: the payload's quote kept its
      // look and the real clip lost its words, so the seat read a truncation notice
      // for a payload that was never cut. Each body quotes the OTHER payload's marker
      // inside its own kept window; the section must then say `quoted` exactly ONCE —
      // the one real clip — and never twice, which is what an unanchored
      // substitution gives.
      // The tell-apart invariant, pinned directly. A payload can quote a marker —
      // issue text is the input — and `fenceText` writes its clip notice LAST, after
      // the backtick neutralisation, so a quote can never be the line that says a
      // payload was cut. Each body here quotes the OTHER payload's marker inside its
      // own kept window; the whole payload's OWN fence must then carry no marker line,
      // because it never clipped. A count over the whole section cannot say this —
      // the quoting payload legitimately carries the text — hence the per-fence scope.
      for (const [name, body, quoted, wholeFenceOf] of [
        [
          "a statement quoting the criteria marker",
          PROBLEM_QUOTES_CRITERIA_MARKER_BODY,
          "…(criteria truncated)",
          criteriaFenceOf,
        ],
        [
          "a criterion quoting the statement marker",
          CRITERIA_QUOTE_PROBLEM_MARKER_BODY,
          GOLDEN_PROBLEM_MARKER,
          statementFenceOf,
        ],
      ] as const) {
        const section = renderSpecCriteriaSection(body);
        const wholeFence = wholeFenceOf(section);
        assert(
          wholeFence.length > 0 &&
            wholeFence.split("\n").filter((l) => l.trim() === quoted).length === 0,
          `(5) ${name}: the payload that never clipped is not reported as cut — its own fence carries no \`${quoted}\` line (saw ${String(
            wholeFence.split("\n").filter((l) => l.trim() === quoted).length,
          )})`,
        );
      }
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

console.log(
  `\n${failures() === 0 ? "review-problem green" : "review-problem RED"} (${String(
    failures(),
  )} failing)`,
);
process.exit(failures());
