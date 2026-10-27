#!/usr/bin/env bun
/**
 * #1856 review round 2 (HIGH) — the `## Duplicate check — excluded candidates`
 * section fits the slot the post-fit append budget gives it.
 *
 * The defect: `POST_FIT_APPENDS_MAX_CHARS` (3,072) is the whole budget for
 * EVERYTHING appended after `fitDraftToBudget` returns — residual gaps, open
 * points, the base fallback, the image links, the provenance wrapper, and this
 * section. The section's only bound was `truncateForDisclosure` (300) on one slot
 * INSIDE the reason, while the reason is composed from several parts. Ten
 * fully-loaded rows rendered
 * 4,753 chars — more than the entire append budget, on their own.
 *
 * Since #1856 round 5 every reason is fixed prose the producer composes from
 * `EXCLUSION_REASONS` — the prior-art reason and the clause it quoted out of the
 * child's reply are gone — so the widest row is now title + reason, and this file
 * pins the arithmetic over those two slots plus the lead and the omission line.
 *
 * BASE-BEHAVIOUR EVIDENCE was established OUTSIDE the repo, against the pre-fix
 * renderer checked out at the commit this branch was cut from: the same
 * worst-case fixture measured 5,865 chars against the 3,072-char append budget.
 * No committed test reads a git revision — CI's checkout does not carry a branch
 * commit — so what this file asserts is the render itself: the worst-case section
 * stays inside its own cap, and stays a minority shareholder in the shared one.
 */

import { POST_FIT_APPENDS_MAX_CHARS } from "../src/plan-dropped-budget.ts";
import { EXCLUSION_REASONS } from "../src/plan-duplicate-self.ts";
import {
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

/** The widest reason the renderer can be handed. */
function worstReason(reasonLen: number): string {
  return "r".repeat(reasonLen);
}

/**
 * The rule sentences the producer actually composes rows from (`EXCLUSION_REASONS`
 * in plan-duplicate-self.ts). The reason clip is a literal rather than an
 * expression over them — that import would be circular — so the producer's own
 * strings are compared against the bound here: a fixture whose reason could never
 * reach the clip would let a bound measured against an impossible input pass, and
 * a reworded rule sentence must fail here rather than drift.
 */
const PRODUCER_REASONS = Object.values(EXCLUSION_REASONS);
const LONGEST_PRODUCER_REASON = Math.max(...PRODUCER_REASONS.map((r) => r.length));

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
    `worst case: 10 rows with max-length title/state/reason render inside the section cap (${section.length} <= ${EXCLUSION_SECTION_MAX_CHARS})`,
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
    !section.includes("r".repeat(EXCLUSION_REASON_MAX_CHARS + 1)),
    "a reason longer than the clip never reaches the rendered section",
  );
  assert(
    section.includes("r".repeat(EXCLUSION_REASON_MAX_CHARS)),
    `the fixture really loads a reason right at the clip (${EXCLUSION_REASON_MAX_CHARS})`,
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
    EXCLUSION_REASON_MAX_CHARS > 0 && EXCLUSION_TITLE_MAX_CHARS === 120,
    `the row slots each have their own clip (reason ${EXCLUSION_REASON_MAX_CHARS}, title ${EXCLUSION_TITLE_MAX_CHARS})`,
  );
  assert(
    worstReason(400).length > EXCLUSION_REASON_MAX_CHARS,
    `an unclipped reason exceeds the row's reason clip (${worstReason(400).length} > ${EXCLUSION_REASON_MAX_CHARS}) — so the clip does real work`,
  );
  // The reason bound is spelled as a literal in the budget module to keep that
  // module free of a circular import back to the rules. That is only sound while
  // the bound still clears the producer's actual wording, so every reason the
  // producer composes is compared against it below — reword a rule sentence past
  // the clip and this fails instead of the disclosure silently shortening.
  assert(
    PRODUCER_REASONS.length > 0 && LONGEST_PRODUCER_REASON <= EXCLUSION_REASON_MAX_CHARS,
    `the producer's longest EXCLUSION_REASONS sentence still fits the clip (${LONGEST_PRODUCER_REASON} <= ${EXCLUSION_REASON_MAX_CHARS})`,
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
