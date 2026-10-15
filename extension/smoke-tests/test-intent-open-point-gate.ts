#!/usr/bin/env bun
/**
 * #1187 — the topic-neutral open-point gate, end to end at the verdict.
 *
 * Covers: any unresolved CRITICAL point parks (no classifier); [RESOLVED] answers it
 * and is recorded as an assumption whose text is the flattened point; an existing park
 * keeps its reason and gains the points; a blank body parks with its own reason that the
 * #397 override cannot lift; a retired artifact is refused and never yields proceed; and
 * the park/handoff text carries the escape.
 */

import {
  parseNormalisedSpecArtifact,
  resolveIntentVerdict,
} from "../src/work-driver-intent-artifact.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import {
  type NormalisedSpec,
  PARK_REASONS,
  explainPark,
  parkAction,
} from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEADING = "## Open points (unresolved at the gap-gate cap)";
const body = (...lines: string[]) => [HEADING, "", ...lines, ""].join("\n");

const complete = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Keep the retry timeout configurable.",
  deliverables: [
    { id: "d1", description: "make the timeout configurable", paths: ["src/retry.ts"] },
  ],
  acceptanceCriteria: ["the timeout is read from configuration"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [{ claim: "the timeout is hard-coded", source: "retry.ts:1", verdict: "confirmed" }],
  verdict: "proceed",
  rationale: "actionable",
  ...over,
});

// Topic-neutral: a retry timeout is as much a park as an authorization point.
{
  const gated = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL] Which timeout wins when both are set"),
  );
  assert(
    gated.verdict === "park" && gated.parkReason === "unresolved-critical-open-point",
    "a topic-neutral CRITICAL point (a retry timeout) parks as unresolved-critical-open-point",
  );
  assert(
    gated.parkReasonSource === "default" &&
      JSON.stringify(gated.openPoints) ===
        JSON.stringify(["[CRITICAL] Which timeout wins when both are set"]),
    "the park records each point as flattened text, with default provenance",
  );
}

// [RESOLVED] answers the point: proceed, recorded as an assumption whose text is the flattened point.
{
  const answered = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL][RESOLVED] Which timeout wins \u2014 the shorter one"),
  );
  assert(answered.verdict === "proceed", "a [RESOLVED] CRITICAL point yields proceed");
  assert(
    answered.assumptions.some(
      (a) => a.text === "[CRITICAL][RESOLVED] Which timeout wins \u2014 the shorter one",
    ),
    "a resolved point is recorded as an assumption whose text is the flattenIssueText output",
  );
  assert(answered.openPoints === undefined, "a resolved point is not a blocking open point");
}

// An emphasised [RESOLVED] does not count: the point still parks (the escape documented in parkAction).
{
  const emphasised = finaliseSpecVerdict(
    complete(),
    body("- [CRITICAL] **[RESOLVED]** Which timeout wins"),
  );
  assert(
    emphasised.verdict === "park",
    "an emphasised **[RESOLVED]** does not resolve; the point parks",
  );
  assert(
    /mark it \[RESOLVED\] right after its severity tag, unemphasised/.test(
      parkAction("unresolved-critical-open-point", 42),
    ),
    "parkAction documents the unemphasised, immediately-after-the-tag rule",
  );
}

// An existing park keeps its reason; the points are appended and provenance becomes default.
{
  const parked = finaliseSpecVerdict(
    complete({ verdict: "park", parkReason: "too-large", parkReasonSource: "parsed" }),
    body("- [CRITICAL] Which timeout wins"),
  );
  assert(
    parked.verdict === "park" && parked.parkReason === "too-large",
    "an existing park keeps its reason",
  );
  assert(
    parked.parkReasonSource === "default" && parked.openPoints?.length === 1,
    "an existing park gains the points and its provenance becomes default",
  );
}

// A blank or whitespace-only body parks with its own reason (not underspecified), and #397 cannot lift it.
for (const blank of ["", "   \n\t ", "\u200B\u200B"]) {
  const gated = finaliseSpecVerdict(
    complete({
      verdict: "park",
      parkReason: "underspecified",
      parkReasonSource: "parsed",
      verdictSource: "default",
    }),
    blank,
  );
  assert(
    gated.verdict === "park" &&
      gated.parkReason === "blank-issue-body" &&
      gated.parkReasonSource === "default",
    `a blank body (${JSON.stringify(blank)}) parks as blank-issue-body, source default, not lifted by #397`,
  );
}
{
  const gated = finaliseSpecVerdict(complete(), undefined);
  assert(
    gated.parkReason === "blank-issue-body",
    "an unread body (undefined) parks as blank-issue-body",
  );
}

// The park reasons are declared in one place and carry their text.
assert(
  PARK_REASONS.includes("unresolved-critical-open-point") &&
    PARK_REASONS.includes("blank-issue-body") &&
    !(PARK_REASONS as readonly string[]).includes("security-open-point"),
  "PARK_REASONS: the two new reasons are declared and the retired security reason is gone",
);
for (const reason of ["unresolved-critical-open-point", "blank-issue-body"] as const) {
  assert(
    explainPark(reason, 42).includes("#42") && parkAction(reason, 42).includes("--restart"),
    `${reason}: explainPark and parkAction name the issue and the --restart escape`,
  );
}

// A retired artifact is refused, so its verdict is never restored; a rejected artifact never yields proceed.
{
  const legacy = JSON.stringify({
    ...complete(),
    verdict: "park",
    parkReason: "underspecified",
    securityOpenPoints: ["`x`"],
  });
  assert(
    parseNormalisedSpecArtifact(legacy) === undefined,
    "an artifact carrying securityOpenPoints is refused",
  );
  const legacyReason = JSON.stringify({
    ...complete(),
    verdict: "park",
    parkReason: "security-open-point",
  });
  assert(
    parseNormalisedSpecArtifact(legacyReason) === undefined,
    "an artifact with the retired security-open-point reason is refused",
  );
  const prose = complete({
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "default",
    verdictSource: "default",
  });
  const restored = resolveIntentVerdict(prose, parseNormalisedSpecArtifact(legacy));
  assert(
    restored.spec?.verdict === "park",
    "a refused artifact cannot turn a default park into proceed (intent re-runs from the issue body)",
  );
}

// The openPoints field round-trips through the artifact.
{
  const kept = complete({
    verdict: "park",
    parkReason: "unresolved-critical-open-point",
    openPoints: ["[CRITICAL] x"],
  });
  const back = parseNormalisedSpecArtifact(JSON.stringify(kept));
  assert(back?.openPoints?.[0] === "[CRITICAL] x", "openPoints round-trips through the artifact");
  assert(
    parseNormalisedSpecArtifact(JSON.stringify({ ...kept, openPoints: [1] })) === undefined,
    "a non-string openPoints is refused",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
