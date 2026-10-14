#!/usr/bin/env bun
/**
 * #1151 review — open-point edge cases for the intent gate.
 *
 * A bare `- [CRITICAL]` bullet is still a point (it must not vanish from the
 * gate), and assumption text is clipped by code point so an emoji run never
 * leaves a lone surrogate. The round trip and authorization canaries live in
 * test-intent-criticality.ts.
 */

import { openPointsSection } from "../src/plan-gap-disclosure.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gap-parse.ts";
import type { PlanGap } from "../src/plan-types.ts";
import { parseNormalisedSpecArtifact } from "../src/work-driver-intent-artifact.ts";
import {
  applyOpenPointGate,
  criticalOpenPoints,
  readOpenPoints,
} from "../src/work-driver-intent-criticality.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, PARK_REASONS, explainPark } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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

// A bare `- [CRITICAL]` is still a point; it must not vanish from the gate.
{
  const bare = criticalOpenPoints(
    "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL]\n- [CRITICAL] \n",
  );
  assert(
    bare.length === 2 && bare.every((p) => p === "(empty CRITICAL open point)"),
    `empty CRITICAL bullet counts as a point (${bare.length})`,
  );
  const gated = applyOpenPointGate(spec({ verdict: "proceed" }), bare);
  assert(
    gated.verdict === "proceed-with-assumptions",
    "an empty CRITICAL bullet caps a proceed rather than being dropped",
  );
}

// Clipping counts code points, so an emoji run is never split into a lone surrogate.
{
  const emoji = "\u{1F600}".repeat(400);
  const capped = applyOpenPointGate(spec({ verdict: "proceed" }), [emoji]);
  const text = capped.assumptions.at(-1)?.text ?? "";
  const span = text.match(/`([^`]*)`$/)?.[1] ?? "";
  const codePoints = Array.from(span);
  assert(
    codePoints.length === 300 && span.endsWith("\u2026"),
    `clip: an emoji point is clipped to 300 code points (${codePoints.length})`,
  );
  assert(
    codePoints.slice(0, -1).every((c) => c === "\u{1F600}"),
    "clip: no lone surrogate is left before the ellipsis",
  );
}

// The artifact reader accepts every park reason the intent gate can emit (#1151 review:
// one shared list, so a new reason cannot be written and then silently refused on read).
{
  const accepted = PARK_REASONS.filter((reason) => {
    const parsed = parseNormalisedSpecArtifact(
      JSON.stringify({ ...spec(), verdict: "park", parkReason: reason }),
    );
    return parsed?.parkReason === reason;
  });
  assert(
    accepted.length === PARK_REASONS.length,
    `artifact reader accepts every ParkReason (${accepted.length}/${PARK_REASONS.length})`,
  );
}

// Resolution: only [RESOLVED] right after the severity tag counts; it is recorded as an assumption.
{
  const body = [
    "## Open points (unresolved at the gap-gate cap)",
    "- [CRITICAL][RESOLVED] Which timeout wins \u2014 answered: the shorter",
    "- [CRITICAL] [RESOLVED] Who owns retries \u2014 answered: the driver",
    "- [CRITICAL] Which backoff applies [RESOLVED]",
    "- ~~[CRITICAL] struck point~~",
  ].join("\n");
  const reading = readOpenPoints(body);
  assert(
    reading.resolved.length === 2 && reading.resolved[0]?.startsWith("Which timeout wins"),
    `resolved: [RESOLVED] after the tag is resolved, both spellings (${reading.resolved.length})`,
  );
  assert(
    reading.points.length === 1 && reading.points[0]?.includes("[RESOLVED]"),
    "resolved: [RESOLVED] elsewhere in the text does not resolve the point",
  );
  assert(
    reading.unparsed.length === 1,
    "resolved: a struck-through CRITICAL line is unparsed, not resolved",
  );
  const gated = applyOpenPointGate(spec({ verdict: "proceed" }), reading.points, reading);
  assert(
    gated.assumptions.some((a) =>
      a.text.startsWith("Resolved open point (marked [RESOLVED] in the issue body): "),
    ),
    "resolved: a skipped resolved bullet reaches the assumptions (PR body)",
  );
}

// Malformed section: a CRITICAL line that does not parse caps the proceed; a HIGH line or a line
// outside the section does not.
{
  const body = [
    "Some CRITICAL context outside the section.",
    "## Open points (unresolved at the gap-gate cap)",
    "- CRITICAL: missing the bracket tag",
    "- [HIGH] a high point that mentions CRITICAL",
  ].join("\n");
  const reading = readOpenPoints(body);
  assert(
    reading.unparsed.length === 1 && reading.unparsed[0]?.startsWith("- CRITICAL"),
    `malformed: one unparsed CRITICAL line, nothing from HIGH or outside the section (${reading.unparsed.length})`,
  );
  const capped = applyOpenPointGate(spec({ verdict: "proceed" }), reading.points, reading);
  assert(
    capped.verdict === "proceed-with-assumptions" &&
      capped.assumptions.some((a) =>
        a.text.startsWith("Open-point gate could not parse a CRITICAL line: "),
      ),
    "malformed: an unparsed CRITICAL line caps proceed with a named assumption",
  );
  const parked = applyOpenPointGate(
    spec({ verdict: "park", parkReason: "too-large" }),
    [],
    reading,
  );
  assert(
    parked.verdict === "park" && parked.parkReason === "too-large",
    "malformed: an existing park is not rewritten",
  );
}

// The security park names the whole class, not only the first words of it (#1151 review).
assert(
  /credentials and keys.*input validation\/injection.*data deletion/.test(
    explainPark("security-open-point", 42),
  ),
  "explainPark: the security park describes the whole class",
);

// #1151 review: an unparsed CRITICAL line naming a security class parks, as a parsed one does.
{
  const reading = readOpenPoints(
    "## Open points (unresolved at the gap-gate cap)\n\n- CRITICAL: authentication is undecided\n",
  );
  const gated = applyOpenPointGate(spec({ verdict: "proceed" }), reading.points, reading);
  assert(
    gated.verdict === "park" && gated.parkReason === "security-open-point",
    "unparsed security line parks as security-open-point",
  );
}

// Prefixed forms of the security stems are security-class too.
for (const word of ["unencrypted", "preauth", "reauth", "unvalidated", "unsanitized"]) {
  const gated = applyOpenPointGate(spec({ verdict: "proceed" }), [`the ${word} path is undecided`]);
  assert(
    gated.verdict === "park" && gated.parkReason === "security-open-point",
    `prefixed security form parks: ${word}`,
  );
}

// Round trip: the gap gate's own rendered section reads back with nothing unparsed, and a
// non-security section caps a proceed without a "could not parse" assumption.
{
  const gaps: PlanGap[] = [
    { severity: "CRITICAL", description: "Which timeout wins", resolution: "the shorter" },
    {
      severity: "CRITICAL",
      description: "Which backoff applies",
      resolution: GAP_RESOLUTION_PLACEHOLDER,
    },
  ];
  const section = openPointsSection(gaps);
  assert(
    readOpenPoints(section).unparsed.length === 0,
    "round trip: rendered section has no unparsed lines",
  );
  const finalised = finaliseSpecVerdict(spec({ verdict: "proceed" }), section);
  assert(
    finalised.verdict === "proceed-with-assumptions" &&
      finalised.assumptions.length === 2 &&
      !finalised.assumptions.some((a) => /could not parse/.test(a.text)),
    `round trip: non-security section gives proceed-with-assumptions with no parse assumption (${finalised.verdict})`,
  );
}

process.exit(exit);
