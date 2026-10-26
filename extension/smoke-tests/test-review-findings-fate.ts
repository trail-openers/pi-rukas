#!/usr/bin/env bun
/**
 * #1469 — unit coverage for `rowFate`'s line-less branch. No test imported
 * review-findings-fate.ts directly before this: every fate assertion went
 * through `runLensReview` or `recordFindingRunOutcome`, which is exactly why the
 * "no usable line → carry, unconditionally" branch survived while it made a
 * file-level CRITICAL unkillable. The end-to-end scenarios live in
 * test-review-findings-resolve.ts (S*); this file pins the rule itself, on a
 * present file, with a hand-built row — including the two asymmetries the
 * end-to-end drive cannot express cheaply: an ACCEPTED line-less row is never
 * retired by silence, and a row whose path is invalid at head never is either.
 */

import { type ReviewKind, rowFate } from "../src/review-findings-fate.ts";
import type { StoredFinding } from "../src/review-findings-file.ts";
import type { HeadState } from "../src/review-findings-head.ts";
import { hashText, snippetHashAt } from "../src/review-findings-match.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const LINES = ["// header", "export const a = 1;", "export const b = 2;"];
const AT_HEAD: HeadState = { kind: "lines", lines: LINES };
const GONE: HeadState = { kind: "missing" };
const INVALID: HeadState = { kind: "invalid" };

/** A line-less row: no `line`, the empty snippet hash, and the explicit marker. */
const lineless = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  id: "aaaa0001",
  branch: "feat/x",
  path: "src/a.ts",
  anchor: "file",
  titleClass: "hardcoded secret",
  title: "Hardcoded secret",
  severity: "CRITICAL",
  lens: "SECURITY",
  noLine: true,
  snippetHash: snippetHashAt([], undefined),
  firstSeen: 1,
  lastSeen: 1,
  status: "open",
  ...over,
});

const kinds: ReviewKind[] = ["full", "delta", "incomplete"];

/** The cited-line hash exactly as `lineHashAt` would have stored it (#1832). */
function hashLine(line: string): string {
  return hashText(line.replace(/\s+/g, " ").trim());
}

// A complete full review retires it; a delta or an incomplete round never does.
for (const review of kinds) {
  const fate = rowFate(lineless(), AT_HEAD, review);
  assert(
    review === "full"
      ? fate.kind === "resolve" && fate.reason === "not-reported"
      : fate.kind === "carry",
    `a line-less CRITICAL on a present file: ${review} round → ${JSON.stringify(fate)}`,
  );
}

// Every severity retires under the one rule — no severity split.
for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const) {
  const fate = rowFate(lineless({ severity }), AT_HEAD, "full");
  assert(
    fate.kind === "resolve" && fate.reason === "not-reported",
    `a line-less ${severity} row retires on a complete full round that no longer reports it`,
  );
}

// A row written BEFORE the fix carries neither `line` nor `noLine`, only the
// empty snippet hash. The rule must catch that spelling too, or an operator
// with an already-stuck PR stays stuck after the fix ships. An `undefined`
// value is what "absent" means to both the schema check and JSON round trip.
const preFixFate = rowFate({ ...lineless(), line: undefined, noLine: undefined }, AT_HEAD, "full");
assert(
  preFixFate.kind === "resolve" && preFixFate.reason === "not-reported",
  "a pre-fix row (no line field, no marker, empty snippet hash) retires under the same rule",
);
// The same row with a marker AND the empty hash is the same decision: the two
// spellings of "no line" must not diverge.
assert(
  rowFate(
    { ...lineless(), noLine: true, snippetHash: snippetHashAt([], undefined) },
    AT_HEAD,
    "full",
  ).kind === "resolve",
  "the marker and the empty snippet hash agree — both spellings retire",
);

// The two exits the new rule must NOT override.
assert(
  rowFate(lineless(), GONE, "full").kind === "resolve" &&
    (rowFate(lineless(), GONE, "full") as { reason: string }).reason === "path-gone",
  "a line-less row whose path is absent at head still resolves as path-gone, not not-reported",
);
assert(
  rowFate(lineless(), INVALID, "full").kind === "carry",
  "a line-less row on an invalid path (unsafe, or a directory) has no automatic exit",
);
assert(
  rowFate(lineless({ status: "accepted" }), AT_HEAD, "full").kind === "carry",
  "an ACCEPTED line-less row is never retired by a round's silence — only by proof",
);

// A line-bearing row whose cited code is UNCHANGED is untouched by the new
// rule: steps 3-4 carry it before the CRITICAL arm is ever reached, so a
// CRITICAL whose cited code survives still carries on a full review.
const cited = { ...lineless(), line: 2, noLine: undefined, snippetHash: snippetHashAt(LINES, 2) };
assert(rowFate(cited, AT_HEAD, "full").kind === "carry", "an unchanged cited line still carries");

// #1832 — the line-bearing CRITICAL that WOULD have retired, if it were not
// CRITICAL. The cited line is deleted from the head file, so neither its window
// hash nor its line hash is found anywhere; the only thing that used to stand
// between it and retirement was the severity check.
const GONE_LINES = ["// header", "export const b = 2;", "// trailing"];
const GONE_HEAD: HeadState = { kind: "lines", lines: GONE_LINES };
/** A row recorded against line 2 of `LINES`, whose code is gone from `GONE_LINES`. */
const goneCritical = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  ...lineless(over),
  line: 2,
  noLine: undefined,
  snippetHash: snippetHashAt(LINES, 2),
  lineHash: hashLine(LINES[1]),
});

for (const review of kinds) {
  const fate = rowFate(goneCritical(), GONE_HEAD, review);
  assert(
    review === "full"
      ? fate.kind === "resolve" && fate.reason === "code-gone"
      : fate.kind === "carry",
    `a line-bearing CRITICAL whose window AND cited line are both gone at head: ${review} round → ${JSON.stringify(fate)}`,
  );
}

// The two hash carries stay first: if EITHER hash still occurs in the head
// file, the CRITICAL carries even on a complete full review.
assert(
  rowFate(goneCritical(), AT_HEAD, "full").kind === "carry",
  "a CRITICAL whose window hash is still found at head carries on a full round",
);
assert(
  rowFate(
    // A window hash the head file cannot produce: the index holds only real
    // ±2-line windows of `lines`, so this forces the row past step 3 and onto
    // step 4, where the surviving cited LINE must carry it.
    { ...goneCritical(), snippetHash: "0000000000000000000000000000000000000000000000000000000000000000" },
    { kind: "lines", lines: ["x", LINES[1], "y", "z", "w"] },
    "full",
  ).kind === "carry",
  "a CRITICAL whose cited LINE survives elsewhere in the head file carries on a full round",
);

// A CRITICAL with no `lineHash` cannot prove its cited line changed: it carries
// even on a complete full review with both hashes otherwise gone.
assert(
  rowFate({ ...goneCritical(), lineHash: undefined }, GONE_HEAD, "full").kind === "carry",
  "a CRITICAL with no lineHash still carries — no hash, no proof",
);

// The same row as a non-CRITICAL resolves on the full round (the pre-existing
// step-9 rule), and on a delta whose ranges cover the stored line (#1125).
for (const severity of ["HIGH", "MEDIUM", "LOW"] as const) {
  const fate = rowFate(goneCritical({ severity }), GONE_HEAD, "full");
  assert(
    fate.kind === "resolve" && fate.reason === "code-gone",
    `a line-bearing ${severity} row whose hashes are gone retires on a full round (unchanged)`,
  );
}

process.exit(exit);
