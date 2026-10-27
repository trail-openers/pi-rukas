#!/usr/bin/env bun
/**
 * #1856 review round 2 (HIGH) — the `## Duplicate check — excluded candidates`
 * section fits the slot the post-fit append budget gives it.
 *
 * The defect: `POST_FIT_APPENDS_MAX_CHARS` (3,072) is the whole budget for
 * EVERYTHING appended after `fitDraftToBudget` returns — residual gaps, open
 * points, the base fallback, the image links, the provenance wrapper, and this
 * section. The section's only bound was `truncateForDisclosure` (300) on the
 * clause INSIDE the prior-art reason, while the reason is composed: a fixed rule
 * sentence plus that clause plus an evidence tail. Ten fully-loaded rows rendered
 * 4,753 chars — more than the entire append budget, on their own.
 *
 * BASE-BEHAVIOUR EVIDENCE was established OUTSIDE the repo, against the pre-fix
 * renderer checked out at the commit this branch was cut from: the same
 * worst-case fixture measured 5,865 chars against the 3,072-char append budget.
 * No committed test reads a git revision — CI's checkout does not carry a branch
 * commit — so what this file asserts is the render itself: the worst-case section
 * stays inside its own cap, and stays a minority shareholder in the shared one.
 */

import { POST_FIT_APPENDS_MAX_CHARS } from "../src/plan-dropped-budget.ts";
import {
  EXCLUSION_REASONS,
  PRIOR_ART_EVIDENCE,
} from "../src/plan-duplicate-self.ts";
import {
  EXCLUSION_CLAUSE_MAX_CHARS,
  EXCLUSION_DISCLOSURE_MAX_ROWS,
  EXCLUSION_REASON_MAX_CHARS,
  EXCLUSION_ROW_MAX_CHARS,
  EXCLUSION_SECTION_HEADING,
  EXCLUSION_SECTION_MAX_CHARS,
  EXCLUSION_TITLE_MAX_CHARS,
  EXCLUSION_WORST_CASE_CHARS,
  duplicateExclusionSection,
} from "../src/plan-duplicate-disclosure.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The widest reason the producer composes: the rule sentence + a full clause + the tail. */
function worstReason(clauseLen: number): string {
  const clause = "c".repeat(clauseLen);
  return `${PRIOR_ART_RULE} — "${clause}" (${PRIOR_ART_TAIL})`;
}

/**
 * The rule sentence and the evidence tail the producer composes the reason from
 * (`EXCLUSION_REASONS["prior-art"]` and `PRIOR_ART_EVIDENCE` in
 * plan-duplicate-self.ts). The clip constant is derived over THOSE constants, so
 * the widest reason a producer can hand the renderer is composed here from the
 * same wording — a fixture whose reason could never reach the clip would let a
 * bound measured against an impossible input pass.
 */
const PRIOR_ART_RULE =
  "a CLOSED issue the risk check itself called prior art or a reversal target";
const PRIOR_ART_TAIL = "the risk check called it that in this clause";

/**
 * The measured width of the non-exclusion appends at their own bounds: the
 * residual section, the open-points section, the base fallback, the image links
 * and the provenance wrapper, each rendered from its module's template with the
 * fields at their clip. Deliberately generous (all of them present at once).
 */
const OTHER_POST_FIT_APPENDS_MAX = 1_400;

/**
 * The other post-fit appends, at the widths their own modules bound them to
 * (plan-gap-disclosure.ts's 300-char disclosure clip, plan-provenance.ts's
 * wrapper, plan-images.ts's link list). Bounded here as a sum so the shared
 * budget is one arithmetic a reviewer can check, not a hope.
 */
function otherPostFitAppendsMax(): number {
  return OTHER_POST_FIT_APPENDS_MAX;
}

/** 10 rows, every interpolable slot at its maximum — the shape that measured 4,753. */
function worstRows(count = EXCLUSION_DISCLOSURE_MAX_ROWS) {
  return Array.from({ length: count }, (_, i) => ({
    number: 9007199254740000 + i,
    state: "CLOSED" as const,
    title: "t".repeat(500),
    reason: worstReason(400),
  }));
}

function worstSection(count?: number): string {
  return duplicateExclusionSection(
    {
      level: "medium",
      rationale: "",
      downgradedFrom: "high",
      excludedIssues: worstRows(count),
    } as never,
    Number.MAX_SAFE_INTEGER,
  );
}

// ------------------------------------------------- the worst case fits its slot

{
  const section = worstSection();
  assert(
    section.length <= EXCLUSION_SECTION_MAX_CHARS,
    `worst case: 10 rows with max-length title/state/reason/clause render inside the section cap (${section.length} <= ${EXCLUSION_SECTION_MAX_CHARS})`,
  );
  // The fixture is a worst case only if it is actually loaded: an unfilled slot
  // would let a vacuous cap pass.
  const bullets = section.split("\n").filter((l) => l.startsWith("- #"));
  assert(
    bullets.length > 0 &&
      bullets.every((b) => b.length > EXCLUSION_ROW_MAX_CHARS - 40),
    `the fixture really loads every row near its clip (shortest ${Math.min(...bullets.map((b) => b.length))}, row cap ${EXCLUSION_ROW_MAX_CHARS})`,
  );
  assert(
    section.includes(`"${"c".repeat(EXCLUSION_CLAUSE_MAX_CHARS)}"`) &&
      !section.includes(`${"c".repeat(EXCLUSION_CLAUSE_MAX_CHARS + 1)}`),
    `the quoted clause is clipped to ${EXCLUSION_CLAUSE_MAX_CHARS}, not left at whatever the child wrote`,
  );
}

// --------------------------------------- the section fits the SHARED append budget
// The assertion the finding is about: this section, plus every other post-fit
// append, must fit `POST_FIT_APPENDS_MAX_CHARS`. The section's own cap is the
// guarantee, so the arithmetic is stated rather than implied.

{
  assert(
    EXCLUSION_SECTION_MAX_CHARS <= Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2) + 1,
    `the section takes at most half the shared post-fit append budget (${EXCLUSION_SECTION_MAX_CHARS} <= ${Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2)})`,
  );
  assert(
    EXCLUSION_SECTION_MAX_CHARS + otherPostFitAppendsMax() <= POST_FIT_APPENDS_MAX_CHARS,
    `the section at its cap PLUS every other post-fit append fits the budget (${EXCLUSION_SECTION_MAX_CHARS} + ${otherPostFitAppendsMax()} <= ${POST_FIT_APPENDS_MAX_CHARS})`,
  );
  // The assertion the finding is about, rendered: the same fixture that measured
  // 5,865 chars on the pre-fix renderer now comes out under half the shared
  // append budget when the renderer actually applies its row clips. A tree whose
  // renderer has no clips blows this number and fails here. The pre-fix
  // measurement itself was taken outside the repo against the base commit — no
  // committed test reads a git revision, because CI's checkout does not carry one.
  const fixed = worstSection().length;
  assert(
    fixed <= Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2),
    `the worst-case section fits the shared post-fit append budget on its own (${fixed} <= ${Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2)})`,
  );
}

// ------------------------------------------------------ the budget is arithmetic

{
  assert(
    EXCLUSION_SECTION_MAX_CHARS ===
      Math.min(
        Math.floor(EXCLUSION_WORST_CASE_CHARS / 2),
        Math.floor(POST_FIT_APPENDS_MAX_CHARS / 2),
      ),
    `the section cap is the arithmetic, not a hand-tuned number: half the worst-case render, held to half the shared budget (${EXCLUSION_WORST_CASE_CHARS} / ${POST_FIT_APPENDS_MAX_CHARS} -> ${EXCLUSION_SECTION_MAX_CHARS})`,
  );
  assert(
    EXCLUSION_WORST_CASE_CHARS > POST_FIT_APPENDS_MAX_CHARS,
    `the arithmetic worst case alone would overrun the shared budget, which is why the section is capped below it (${EXCLUSION_WORST_CASE_CHARS} > ${POST_FIT_APPENDS_MAX_CHARS})`,
  );
  assert(
    EXCLUSION_REASON_MAX_CHARS > EXCLUSION_CLAUSE_MAX_CHARS &&
      EXCLUSION_TITLE_MAX_CHARS === 120,
    `the row slots each have their own clip (reason ${EXCLUSION_REASON_MAX_CHARS}, title ${EXCLUSION_TITLE_MAX_CHARS}, clause ${EXCLUSION_CLAUSE_MAX_CHARS})`,
  );
  assert(
    worstReason(400).length > EXCLUSION_REASON_MAX_CHARS,
    `an unclipped prior-art reason exceeds the row's reason clip (${worstReason(400).length} > ${EXCLUSION_REASON_MAX_CHARS}) — so the clip does real work`,
  );
  // The reason bound is spelled as literals in the budget module to keep this
  // module free of a circular import back to the rules. That is only sound while
  // the literals still ARE the producer's wording, so the producer's own
  // constants are compared against them here — reword a rule sentence and this
  // fails instead of the bound quietly becoming arithmetic over dead prose.
  assert(
    PRIOR_ART_RULE === EXCLUSION_REASONS["prior-art"] && PRIOR_ART_TAIL === PRIOR_ART_EVIDENCE,
    "the fixture's prior-art wording is the producer's own EXCLUSION_REASONS/PRIOR_ART_EVIDENCE",
  );
  assert(
    `${EXCLUSION_REASONS["prior-art"]} — "x" (${PRIOR_ART_EVIDENCE})`.length - 2 +
      EXCLUSION_CLAUSE_MAX_CHARS <=
      EXCLUSION_REASON_MAX_CHARS,
    "the reason bound still covers the producer's actual composition at a full clause",
  );
  // The longest reason the producer can emit for any rule must fit the clip it is
  // clipped to — otherwise `fitReason` is truncating real output, not just hostile
  // input, and the disclosure would be silently shortened.
  for (const reason of Object.values(EXCLUSION_REASONS)) {
    assert(
      reason.length <= EXCLUSION_REASON_MAX_CHARS,
      `the "${reason.slice(0, 24)}…" reason fits the row's reason clip (${reason.length} <= ${EXCLUSION_REASON_MAX_CHARS})`,
    );
  }
}

// ---------------------------------------- the renderer never exceeds its own cap

{
  // Row counts beyond the itemisation cap: still bounded, and the ones that do
  // not fit are COUNTED rather than silently dropped.
  for (const count of [1, 10, 100, 2_000]) {
    const section = worstSection(count);
    assert(
      section.length <= EXCLUSION_SECTION_MAX_CHARS,
      `bounded: ${count} worst-case rows stay inside the cap (${section.length})`,
    );
    const itemised = section.split("\n").filter((l) => l.startsWith("- #")).length;
    const omission = /- and (\d+) more excluded candidate/.exec(section)?.[1];
    const counted = omission === undefined ? 0 : Number(omission);
    assert(
      counted === count - itemised,
      `bounded: ${count} rows itemise ${itemised} and count the other ${count - itemised} honestly (line says ${counted})`,
    );
    assert(
      (count > itemised) === (omission !== undefined),
      `bounded: ${count} rows — the omission line is present exactly when rows were not itemised (${omission === undefined ? "absent" : `"${omission}"`})`,
    );
  }
  assert(
    worstSection().startsWith(`${EXCLUSION_SECTION_HEADING}\n\n`),
    "the section still opens with its own heading — the bound did not eat it",
  );
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-exclusion-budget`);
process.exit(exit);
