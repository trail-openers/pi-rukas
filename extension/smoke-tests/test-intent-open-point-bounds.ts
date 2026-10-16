#!/usr/bin/env bun
/**
 * #1187 fix round 2 — the bounds the Open points reader and gate apply.
 *
 * The shapes the section parser accepts are in test-intent-open-point-edges.ts; this file
 * is only about what happens when a section is BIG. Every bound was added after review, and
 * each one is asserted on its COUNT and on the exact text of the note it appends, because a
 * cap that silently drops entries is worse than no cap: the park would read as complete.
 */

import { OPEN_POINT_ENTRY_CAP, readOpenPoints } from "../src/open-points-reader.ts";
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

const HEADING = "## Open points (unresolved at the gap-gate cap)";

/** An issue body whose Open points section carries the given raw lines. */
const section = (...lines: string[]) => [HEADING, "", ...lines].join("\n");

const spec = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [{ id: "d1", description: "apply the requested change", paths: [] }],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const r = readOpenPoints(section(`- [CRITICAL] rotate the ${token} key now`));
  assert(
    r.points.length === 1 && r.points[0]?.includes("sk-ant-api03") === false,
    "a provider token inside a blocking line is redacted out of the point text",
  );
  assert(
    r.points[0]?.includes("[REDACTED]") === true,
    "the redaction replaces the token with the fixed marker rather than dropping the point",
  );
  const gated = finaliseSpecVerdict(spec(), section(`- [CRITICAL] rotate the ${token} key now`));
  assert(
    gated.verdict === "park" &&
      gated.openPoints?.length === 1 &&
      gated.openPoints[0]?.includes("sk-ant-api03") === false,
    "the parked spec's openPoints carry no credential for the public handoff to quote",
  );
}

{
  // 25 points: the cap keeps 20, the 21st slot says how many were dropped, and the drop is traced.
  const many = section(...Array.from({ length: 25 }, (_, i) => `- [CRITICAL] point ${i}`));
  const gated = finaliseSpecVerdict(spec(), many);
  const points = gated.openPoints ?? [];
  assert(
    points.length === OPEN_POINT_ENTRY_CAP + 1 &&
      points[OPEN_POINT_ENTRY_CAP] === "…and 5 more open-point lines",
    "blocking lines are capped at 20 entries plus one '…and N more' note",
  );
  assert(
    points[OPEN_POINT_ENTRY_CAP - 1] === "[CRITICAL] point 19" &&
      points.some((p) => p === "[CRITICAL] point 20") === false,
    "the cap keeps the first 20 points and drops the rest",
  );
}

{
  // ONE combined cap over points AND unparsed lines, not one per list (#1187 fix round 2):
  // two lists each capped at 20 made the park store 40 entries while its own doc said 20.
  // 25 points + 25 prose lines => exactly 20 kept + 1 note = 21, points first.
  const lines = [
    ...Array.from({ length: 25 }, (_, i) => `- [CRITICAL] point ${i}`),
    ...Array.from({ length: 25 }, (_, i) => `prose line ${i}`),
  ];
  const gated = finaliseSpecVerdict(spec(), section(...lines));
  const points = gated.openPoints ?? [];
  assert(
    points.length === OPEN_POINT_ENTRY_CAP + 1,
    "25 points plus 25 prose lines give exactly 21 blocking entries — ONE combined cap",
  );
  assert(
    points[0] === "[CRITICAL] point 0" &&
      points[OPEN_POINT_ENTRY_CAP - 1] === "[CRITICAL] point 19",
    "the combined cap keeps the points first, so a CRITICAL point is never displaced by prose",
  );
  assert(
    points[OPEN_POINT_ENTRY_CAP] === "…and 30 more open-point lines",
    "the 'N more' note counts BOTH lists (5 dropped points + 25 dropped prose lines)",
  );
}

{
  // Resolved points have a bound of their own now: they become assumptions the PR body
  // renders, and an uncapped list was an unbounded public surface no other bound covered.
  const lines = Array.from({ length: 500 }, (_, i) => `- [CRITICAL][RESOLVED] answered point ${i}`);
  const gated = finaliseSpecVerdict(spec(), section(...lines));
  const assumptions = gated.assumptions.filter((a) => a.text.startsWith("resolved open point: "));
  assert(gated.verdict === "proceed", "500 resolved points still proceed — none of them gates");
  assert(
    assumptions.length === OPEN_POINT_ENTRY_CAP + 1,
    "500 resolved bullets give at most 21 resolved-open-point assumptions (20 + the note)",
  );
  assert(
    assumptions[OPEN_POINT_ENTRY_CAP]?.text ===
      "resolved open point: …and 480 more resolved open points",
    "the resolved list carries its own note naming what it dropped",
  );
  assert(
    assumptions.slice(0, OPEN_POINT_ENTRY_CAP).every((a) => a.text !== "resolved open point: "),
    "no capped resolved assumption is an empty bullet",
  );
}

{
  const huge = `- [CRITICAL] ${"y".repeat(5000)} tail`;
  const gated = finaliseSpecVerdict(spec(), section(huge));
  const stored = gated.openPoints?.[0] ?? "";
  assert(
    gated.verdict === "park" && stored.endsWith("…(clipped)") && Array.from(stored).length <= 2000,
    "an enormous entry is clipped to the bound with the '…(clipped)' marker",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
