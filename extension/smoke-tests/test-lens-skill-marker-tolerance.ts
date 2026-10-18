#!/usr/bin/env bun
/**
 * #872 — the `readEnumMarker` tolerance arms, split from
 * `test-lens-skill-wiring.ts` for the 500-line gate (AGENTS.md §12).
 *
 * The parent file drives the real six-pass fan-out with mocked spawns; these
 * two cases need none of that. They exercise ONE pure function — how the
 * reviewer's self-reported `Skill Load Status` marker is read out of free-form
 * reply text — and they are the reason an explicit `FAILED` can never ride
 * through to `APPROVED` on a formatting accident.
 *
 * They are separated rather than trimmed because both arms fail usefully and
 * neither is redundant with the other:
 *
 *   (g) what DOES parse — bold, lowercase, heading form, and last-match-wins.
 *   (h) what must NOT parse — the role prompt's own rule prose, which contains
 *       `Skill Load Status=FAILED`. The `=` form is not an accepted declaration
 *       (PM decision #872), so a child quoting the rule back must not be
 *       blocked by its own quotation, while a real marker after the quote still
 *       wins.
 *
 * Same `readEnumMarker` import, same `eq` shape as the parent file so a failure
 * reads identically whichever file it came from.
 */

let exit = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual === expected) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg} (got ${String(actual)}, want ${String(expected)})`);
    exit = 1;
  }
}

const { readEnumMarker } = await import("../src/reply-markers.ts");

const STATUS = "Skill Load Status";
const VALUES = ["SUCCESS", "FAILED"];

/* (g) marker tolerance — bold/case/heading variants, unknown value, musing. */
{
  eq(readEnumMarker("**Skill Load Status:** FAILED", STATUS, VALUES), "FAILED", "(g) bold + colon + trailing bold parses FAILED");
  eq(readEnumMarker("skill load status: success", STATUS, VALUES), "SUCCESS", "(g) lowercase + colon parses SUCCESS");
  eq(readEnumMarker("### Skill Load Status\nFAILED", STATUS, VALUES), "FAILED", "(g) heading form parses FAILED");
  eq(readEnumMarker("Skill Load Status: ERROR", STATUS, VALUES), undefined, "(g) out-of-set value parses as undefined (absent)");
  eq(
    readEnumMarker("I will set Skill Load Status: FAILED if...", STATUS, VALUES),
    "FAILED",
    "(g) last-match-wins: a musing about FAILED is still FAILED (the prompt says to END with the marker, so the last one is the answer)",
  );
}

/* (h) the rule prose cannot be misread as a declaration. The CRITICAL RULE
 * in the role prompt reads "If Skill Load Status=FAILED, verdict CANNOT be
 * APPROVED" — a child that QUOTES it while ending with a real marker must
 * not be blocked by the quote. The `=` form is NOT an accepted declaration
 * (PM decision #872); the colon-anchored reader must miss it entirely. */
{
  eq(
    readEnumMarker("If Skill Load Status=FAILED, verdict CANNOT be APPROVED.", STATUS, VALUES),
    undefined,
    "(h) the rule prose's `Status=FAILED` is not a declaration — parses absent",
  );
  eq(
    readEnumMarker(
      "Per the rules, if Skill Load Status=FAILED I must block.\n\nSkill Load Status: SUCCESS",
      STATUS,
      VALUES,
    ),
    "SUCCESS",
    "(h) a reply quoting the rule and ending with a real SUCCESS marker parses SUCCESS",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
