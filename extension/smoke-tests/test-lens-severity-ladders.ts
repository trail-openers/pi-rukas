#!/usr/bin/env bun
/**
 * The four uncalibrated lens ladders no longer label a CATEGORY of code HIGH.
 *
 * The pass that motivated this: 49 of 56 findings HIGH in one six-lens review
 * of a 7-file offline-script PR, and about two were real. simplicity,
 * type-safety, architecture and security each defined HIGH by an adjective or a
 * category ("implicit any", "impedes maintenance", "could lead to"), so any
 * finding a lens bothered to report satisfied the definition. error-handling and
 * performance were calibrated — they anchor HIGH to a demonstrated failure.
 *
 * Small on purpose: it pins the two shapes that could not be fixed by rewording
 * alone (a category as HIGH, and the simplicity skill's "regardless of author
 * intent" framing that made the author's judgment out of order), plus the
 * forced-verdict clause the spec replaced with a MEDIUM finding. Per-line
 * ladders are reviewed by eye; this is the canary.
 *
 * Asserted against the SOURCE markdown under `skill/`, not an installed copy:
 * the source is what a contributor commits and what CI ships.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const skill = (lens: string) =>
  // No existsSync guard: an unreadable ladder is the failure this test exists
  // to catch, and readFileSync naming the path and errno beats an empty string.
  readFileSync(path.join(ROOT, "skill", `code-review-${lens}`, "SKILL.md"), "utf8");

/** The HIGH bullet of a ladder — the lines between `**HIGH**` and the next level. */
function highLine(src: string): string {
  const m = src.match(/\*\*HIGH\*\*:([^\n]*)/);
  return m ? m[1] : "";
}

const FOUR = ["simplicity", "type-safety", "architecture", "security"] as const;

for (const lens of FOUR) {
  const src = skill(lens);
  assert(src.length > 0, `${lens}: the ladder is readable`);
  const high = highLine(src);
  assert(high.length > 0, `${lens}: the ladder still has a HIGH line`);
  assert(
    !/implicit any/i.test(high),
    `${lens}: HIGH is not assigned to the category "implicit any"`,
  );
  assert(
    !/regardless of author intent/i.test(src),
    `${lens}: the ladder does not override the author's stated intent`,
  );
  // The rubric's own vocabulary has to appear in the ladder it is aligned to,
  // or "aligned" means nothing more than a shorter sentence.
  assert(
    /reachable|reach/i.test(high),
    `${lens}: the HIGH line requires the failure to be reachable`,
  );
}

// The simplicity skill's forced verdicts: the bound-range enumeration stays (it
// is the useful half), but an incomplete enumeration is now a MEDIUM finding,
// never a verdict the skill dictates.
{
  const src = skill("simplicity");
  assert(
    /BOUND-RANGE ENUMERATION/i.test(src),
    "simplicity: the bound-range enumeration is kept",
  );
  assert(
    !/verdict MUST be BLOCKED/i.test(src),
    "simplicity: an incomplete enumeration no longer forces the verdict",
  );
  assert(
    /report the omission as a MEDIUM finding/i.test(src),
    "simplicity: the omission is reported as a MEDIUM finding instead",
  );
  assert(
    !/verdict MUST be ISSUES_FOUND/i.test(src),
    "simplicity: the lens reports findings, it does not dictate the verdict",
  );
}

// The role prompt's category table sets attention, not severity, and the
// "until proven safe" default stance is gone.
{
  const src = readFileSync(
    path.join(ROOT, "agents-base", "code-review-specialist.md"),
    "utf8",
  );
  assert(
    !/\*\*REQUEST CHANGES until proven safe\.\*\*/i.test(src),
    "role prompt: 'REQUEST CHANGES until proven safe' is gone",
  );
  const table = src.match(/## Review Attention[\s\S]*?\n\n/)?.[0] ?? "";
  assert(table.length > 0, "role prompt: the category table is now an attention table");
  assert(
    !/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/.test(table),
    "role prompt: the attention table no longer carries severity words",
  );
  assert(
    /does \*\*not\*\* set a finding's severity|not\* set a finding's severity/i.test(src),
    "role prompt: the table says it does not set severity",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
