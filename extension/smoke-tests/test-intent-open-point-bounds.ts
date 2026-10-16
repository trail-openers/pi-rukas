#!/usr/bin/env bun
/**
 * #1187 fix round 2 — the bounds the Open points reader and gate apply.
 *
 * The shapes the section parser accepts are in test-intent-open-point-edges.ts; this file
 * is only about what happens when a section is BIG. Every bound was added after review, and
 * each one is asserted on its COUNT and on the exact text of the note it appends, because a
 * cap that silently drops entries is worse than no cap: the park would read as complete.
 */

import {
  OPEN_POINT_CHAR_CAP,
  OPEN_POINT_ENTRY_CAP,
  readOpenPoints,
} from "../src/open-points-reader.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, renderAssumptions } from "../src/work-driver-intent.ts";

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
    gated.verdict === "park" &&
      stored.endsWith("…(clipped)") &&
      Array.from(stored).length <= OPEN_POINT_CHAR_CAP,
    "an enormous entry is clipped to the bound with the '…(clipped)' marker",
  );
}

// --- Invisible characters in the HEADING must not disable the gate (#1187 fix round 4) ----
//
// The heading matcher was built from the raw OPEN_POINTS_HEADING constant, so a stray U+200B
// was a character the pattern REQUIRED at that position: a heading that did not match opened
// no section, the section's CRITICAL points were never read, and a body that should have
// parked read back as clean and proceeded. That is fail-open on the gate's own entry
// condition, and it is a paste artefact rather than an attack. The match is still an exact
// literal, so a mangled word or a reworded tail still opens nothing (asserted below).
{
  const H = "## Open points (unresolved at the gap-gate cap)";
  const zwspTail = `${H}\u200B`;
  const zwspInside = "## Open poin\u200Bts (unresolved at the gap-gate cap)";
  for (const [name, heading] of [
    ["trailing U+200B", zwspTail],
    ["interior U+200B", zwspInside],
  ] as const) {
    const body = [heading, "", "- [CRITICAL] Which timeout wins"].join("\n");
    const gated = finaliseSpecVerdict(spec(), body);
    assert(
      gated.verdict === "park" &&
        gated.parkReason === "unresolved-critical-open-point" &&
        gated.openPoints?.[0] === "[CRITICAL] Which timeout wins",
      `a heading with a ${name} is still read: the section is scanned and the point parks`,
    );
  }
  // The exactness the settlement demands is untouched: invisible characters do not make the
  // matcher fuzzy, they only make it see the visible text.
  for (const near of [
    "## Open points (unresolved at the gap-gate",
    "## Open poinits (unresolved at the gap-gate cap)",
    "## Open points somewhere else",
    "## Open points (unresolved at the gap-gate cap) extra\u200B",
  ]) {
    const body = [near, "", "- [CRITICAL] Which timeout wins"].join("\n");
    assert(
      finaliseSpecVerdict(spec(), body).verdict === "proceed",
      `a near-miss heading ${JSON.stringify(near.slice(0, 34))} still opens no section and does not park`,
    );
  }
}

// --- Resolver-authored assumptions are redacted and bounded (#1187 fix round 4) -----------
//
// `renderAssumptions` puts every assumption in the PR body verbatim. The open-point texts
// were bounded where the gate wrote them and where the artifact restored them, but the
// assumptions the RESOLVER authored arrived untouched, so a token quoted in one reached a
// public surface with no redaction anywhere in its path.
{
  const token = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123";
  const gated = finaliseSpecVerdict(
    spec({
      assumptions: [
        {
          text: `the resolver found ${token} in the fixture and redacts it`,
          basis: `seen at retry.ts:7 where ${token} is hard-coded`,
        },
        { text: "z".repeat(6000), basis: "b".repeat(6000) },
      ],
    }),
    section("- plain note"),
  );
  assert(
    gated.assumptions.every(
      (a) => !a.text.includes("sk-ant-api03") && !a.basis.includes("sk-ant-api03"),
    ),
    "a provider token in a resolver-authored assumption does not survive finaliseSpecVerdict",
  );
  assert(
    gated.assumptions.some((a) => a.text.includes("[REDACTED]")),
    "the assumption is kept, with the token replaced by the redaction marker",
  );
  assert(
    gated.assumptions.every(
      (a) =>
        Array.from(a.text).length <= OPEN_POINT_CHAR_CAP &&
        Array.from(a.basis).length <= OPEN_POINT_CHAR_CAP,
    ),
    "a resolver-authored assumption is bounded to the char cap in both fields",
  );
  const block = renderAssumptions(gated);
  assert(
    block.includes("sk-ant-api03") === false && block.includes("[REDACTED]"),
    "renderAssumptions renders no credential for the PR body",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
