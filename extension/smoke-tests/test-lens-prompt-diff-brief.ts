#!/usr/bin/env bun
/**
 * #2127 (AC3, R5) — the lens brief tells the child to work from the inlined diff.
 *
 * Field evidence: 92 % of a lens child's tool calls were bash re-deriving a diff
 * that is ALREADY in its prompt (`git -C`, `grep -rn`, `rg`, `sed -n`) or
 * rebuilding sandboxes to do it in (`rm -rf`, `mkdir -p`, `cat >`). The ceiling
 * paces that behaviour; this paragraph is what makes it unnecessary in the first
 * place.
 *
 * R5: an ADDED paragraph only. The existing headings, the forbidden-phrase list
 * and the terminal STOP sentence are unchanged, and the pre-existing prompt
 * suites (`test-lens-prompt-skill-read.ts`, `test-lens-evidence.ts`,
 * `test-lens-severity-calibration.ts`, …) pass UNMODIFIED — which is what makes
 * "added paragraph" testable rather than a claim: the assertions here are all
 * additive, and the last case pins that the paragraph lands on BOTH callers and
 * before the terminal STOP sentence, exactly where #1992 pinned its own lane
 * rules.
 */

import { lensPromptFor } from "../src/lens-review-format.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const lens = LENS_ROSTER[0];
assert(lens !== undefined, "precondition: the bundled lens roster resolves an entry");

// The plain caller (no skill body) — the branch whose prompt was byte-identical
// to the pre-#995 shape, so the paragraph has to reach the child here too.
const plain = lensPromptFor(lens, "diff --git a/a b/a", "ctx", undefined, []);

for (const [re, what] of [
  [/the diff above is the whole change and it is ALREADY in your prompt/i, "AC3: the brief says the diff is already inlined in this prompt"],
  [/read each (touched|changed) file at most once/i, "AC3: a touched file is read at most once"],
  [/do not[\s\S]{0,80}rebuild[^\n]*sandbox/i, "AC3: no rebuilding sandboxes"],
  [/re-derive the diff with git or grep only to verify a specific claim/i, "AC3: re-deriving the diff with git or grep is for verifying a specific claim"],
] as const) {
  assert(re.test(plain), `#2127 brief: ${what}`);
}

// The paragraph is not branch-specific: the skill-body caller is the one every
// real lens gets, and a rule that only the plain caller renders is unread.
{
  const withBody = lensPromptFor(
    lens,
    "diff --git a/a b/a",
    "ctx",
    undefined,
    [],
    "",
    "/tmp/skills/code-review-security",
    "<lens-skill-body nonce=\"n\">\nApply the lane.\n</lens-skill-body>",
  );
  assert(
    /read each (touched|changed) file at most once/i.test(withBody),
    "#2127 brief: the paragraph reaches the skill-body prompt too (the caller every real lens uses)",
  );
  // The terminal STOP sentence stays the LAST line — the paragraph is added, not
  // appended over it (test-lens-evidence.ts pins that sentence as the final line).
  const last = [...withBody.split("\n").reverse()].find((l) => l.trim() !== "") ?? "";
  assert(/^After writing your summary, STOP/.test(last), "#2127 brief: the terminal STOP sentence is still the last line");
  const headingAt = withBody.indexOf("## Your working directory is NOT the branch");
  const at = withBody.search(/read each (touched|changed) file at most once/i);
  assert(
    headingAt >= 0 && at >= 0 && at < withBody.indexOf("## How to report findings"),
    "#2127 brief: the paragraph sits in the working-directory section, before the reporting instructions",
  );
}

// R5: nothing the existing suites pin was disturbed.
assert(
  plain.includes("## Your working directory is NOT the branch") &&
    plain.includes("## How to report findings") &&
    plain.includes("## Stay in the review lane"),
  "R5: the pre-existing headings are all still present",
);
for (const forbidden of [
  "use the `read` tool to load your assigned skill file",
  "NOT inlined in your context",
  "Skill Load Status: SUCCESS",
]) {
  assert(!plain.includes(forbidden), `R5: the read-era phrase stays gone: "${forbidden}"`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
