#!/usr/bin/env bun
/**
 * #1171 — the shared flatten-and-clip sanitiser, the blank-body note on a parked
 * spec, and the non-critical bullet. One assertion per behaviour; each has a
 * canary that would fail if the behaviour regressed.
 */

import { readOpenPoints } from "../src/open-points-reader.ts";
import { flattenAndClip, flattenIssueText, redactThenBound } from "../src/text-flatten.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Bidi overrides, zero-width characters and the BOM are removed, not spaced.
assert(
  flattenIssueText("pay\u202Epal\u200B\uFEFF!") === "paypal!",
  "flatten: bidi override and zero-width characters are removed without splitting the word",
);
// Control characters and U+2028/U+2029 each become a space, so a forged line break is inert.
assert(
  flattenIssueText("first\nSecond\u2028third\u2029\r\tfourth") === "first Second third fourth",
  "flatten: newlines, tabs, U+2028 and U+2029 collapse to single spaces",
);
// Clipping counts code points and never splits a surrogate pair.
assert(
  flattenAndClip("a\u{1F600}bcdef", 4) === "a\u{1F600}b…",
  "clip: counts code points, keeps a surrogate pair whole, and ends a clipped value in an ellipsis",
);
assert(flattenAndClip("short", 300) === "short", "clip: a value within the limit is unchanged");
assert(
  Array.from(flattenAndClip("x".repeat(500), 300)).length === 300,
  "clip: a failure reason is capped at 300 code points",
);

// Blank body: the note is recorded even when the spec is already parked, and the park stands.
const parked: NormalisedSpec = {
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [{ id: "d1", description: "apply the change", paths: [] }],
  acceptanceCriteria: ["behaviour preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "park",
  parkReason: "too-large",
  rationale: "too big",
};
const blankParked = finaliseSpecVerdict(parked, "   ");
assert(
  blankParked.verdict === "park" && blankParked.parkReason === "too-large",
  "blank body on a parked spec: the park and its reason are unchanged",
);
assert(
  blankParked.assumptions.some((a) => a.text === "Open-point gate did not run: issue body blank"),
  "blank body on a parked spec: the unchecked-body note is recorded as an assumption",
);
const blankProceed = finaliseSpecVerdict(
  { ...parked, verdict: "proceed", parkReason: undefined },
  undefined,
);
assert(
  blankProceed.verdict === "park" && blankProceed.parkReason === "blank-issue-body",
  "blank body on a proceed spec: parked as blank-issue-body, not underspecified (#1171, #1187)",
);

// Non-critical prose is not a malformed CRITICAL line; a real malformed one still is.
const HEADING = "## Open points (unresolved at the gap-gate cap)";
const nonCritical = readOpenPoints(
  `${HEADING}\n\n- [CRITICAL] a real point\n- Non-critical: the cache TTL is open\n- non-critical wording\n`,
);
// The section is really read (the real point is seen), so the zero below is not vacuous.
assert(
  nonCritical.points.length === 1 && nonCritical.unparsed.length === 0,
  "non-critical: 'Non-critical' bullets are not malformed CRITICAL lines (section is read)",
);
assert(
  readOpenPoints(`${HEADING}\n\n- critical: the retry ceiling\n`).unparsed.length === 1,
  "non-critical canary: a lowercase 'critical' bullet is still malformed",
);

// --- redactThenBound: the one redact-then-clip normaliser (#1187 fix round 4) -------------
//
// Every text the open-point gate stores or renders goes through this function, so its two
// properties are asserted here at the source rather than only where a caller uses them:
// redaction happens BEFORE the bound (clipping first can leave a token fragment no pattern
// recognises), and the bound counts code points (so a surrogate pair is never halved).
{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const short = redactThenBound(`rotate the ${token} key`, 2000);
  assert(
    short.text.includes("sk-ant-api03") === false &&
      short.text.includes("[REDACTED]") &&
      short.clipped === false,
    "redactThenBound: redacts a credential inside the bound and reports no clip",
  );
  // A token straddling the bound is still gone: redaction ran on the whole string first.
  const straddling = redactThenBound(`${"y".repeat(1970)} ${token}`, 2000);
  assert(
    straddling.text.includes("sk-ant-api03") === false &&
      Array.from(straddling.text).length <= 2000,
    "redactThenBound: redacts before bounding, so a token crossing the cut leaves no fragment",
  );
  const over = redactThenBound("z".repeat(5000), 2000);
  assert(
    over.clipped === true && Array.from(over.text).length === 2000,
    "redactThenBound: reports `clipped` so a caller appends a marker without re-measuring",
  );
  const under = redactThenBound("z".repeat(2000), 2000);
  assert(
    under.clipped === false && Array.from(under.text).length === 2000,
    "redactThenBound canary: a string exactly at the bound is NOT reported as clipped",
  );
  const astral = redactThenBound("\u{1F600}".repeat(1500), 1000);
  assert(
    Array.from(astral.text).length === 1000 &&
      Array.from(astral.text).every((c) => c.codePointAt(0) === 0x1f600),
    "redactThenBound: bounds by code point, so no lone surrogate half survives",
  );
}

process.exit(exit);
