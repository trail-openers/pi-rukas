#!/usr/bin/env bun
/**
 * #1151 review — open-point edge cases for the intent gate.
 *
 * A bare `- [CRITICAL]` bullet is still a point (it must not vanish from the
 * gate), and assumption text is clipped by code point so an emoji run never
 * leaves a lone surrogate. The round trip and authorization canaries live in
 * test-intent-criticality.ts.
 * (#1171: the security park text is checked against every SECURITY_CLASS_LABELS entry.)
 */

import { openPointsSection } from "../src/plan-gap-disclosure.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gap-parse.ts";
import type { PlanGap } from "../src/plan-types.ts";
import { SECURITY_CLASS_LABELS } from "../src/security-class.ts";
import { parseNormalisedSpecArtifact } from "../src/work-driver-intent-artifact.ts";
import {
  criticalOpenPoints,
  openPointText,
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

const HEADING = "## Open points (unresolved at the gap-gate cap)";

/** An issue body whose Open points section carries the given raw lines. */
const section = (...lines: string[]) => [HEADING, "", ...lines].join("\n");

// A bare `- [CRITICAL]` is still a point; it must not vanish from the gate.
{
  const bare = criticalOpenPoints(section("- [CRITICAL]", "- [CRITICAL] "));
  assert(
    bare.length === 2 && bare.every((p) => p.kind === "empty"),
    `empty CRITICAL bullet is a typed empty point (${bare.length})`,
  );
  const gated = finaliseSpecVerdict(spec(), section("- [CRITICAL]", "- [CRITICAL] "));
  assert(
    gated.verdict === "proceed-with-assumptions" &&
      gated.assumptions.some((a) => a.text.includes("(empty CRITICAL open point)")),
    "an empty CRITICAL bullet caps a proceed and renders its placeholder",
  );
}

// Clipping counts code points, so an emoji run is never split into a lone surrogate.
{
  const emoji = "\u{1F600}".repeat(400);
  const capped = finaliseSpecVerdict(spec(), section(`- [CRITICAL] ${emoji}`));
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

// Issue text quoted into assumptions: each control/line-separator run becomes one space.
// An unparsed line is quoted raw, so it can carry U+2028/U+2029; a parsed point cannot (the
// item regex does not match across them), so a tab is the control character that reaches a point.
{
  const unparsed = section("- CRITICAL: Which\u2028timeout\u0007wins\u2029\u0000now");
  const text =
    finaliseSpecVerdict(spec(), unparsed).assumptions.find((a) =>
      a.text.startsWith("Open-point gate could not parse a CRITICAL line: "),
    )?.text ?? "";
  assert(
    text.includes("`- CRITICAL: Which timeout wins now`"),
    `flatten: control characters and line separators become single spaces (${JSON.stringify(text)})`,
  );
  assert(
    !/[\p{Cc}\u2028\u2029]/u.test(text),
    "flatten: the quoted assumption holds no control characters or line separators",
  );
  const tabbed = finaliseSpecVerdict(
    spec(),
    section("- [CRITICAL] Which\ttimeout wins"),
  ).assumptions.some(
    (a) => a.text === "unresolved CRITICAL open point in the filed issue: `Which timeout wins`",
  );
  assert(tabbed, "flatten: a tab inside a point is one space in the quoted assumption");
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
  const body = section(
    "- [CRITICAL][RESOLVED] Which timeout wins \u2014 answered: the shorter",
    "- [CRITICAL] [RESOLVED] Who owns retries \u2014 answered: the driver",
    "- [CRITICAL] Which backoff applies [RESOLVED]",
    "- ~~[CRITICAL] struck point~~",
  );
  const reading = readOpenPoints(body);
  assert(
    reading.resolved.length === 2 &&
      openPointText(reading.resolved[0] ?? { kind: "empty" }).startsWith("Which timeout wins"),
    `resolved: [RESOLVED] after the tag is resolved, both spellings (${reading.resolved.length})`,
  );
  assert(
    reading.points.length === 1 &&
      openPointText(reading.points[0] ?? { kind: "empty" }).includes("[RESOLVED]"),
    "resolved: [RESOLVED] elsewhere in the text does not resolve the point",
  );
  assert(
    reading.unparsed.length === 1,
    "resolved: a struck-through CRITICAL line is unparsed, not resolved",
  );
  const gated = finaliseSpecVerdict(spec(), body);
  assert(
    gated.assumptions.some((a) =>
      a.text.startsWith("Resolved open point (marked [RESOLVED] in the issue body): "),
    ),
    "resolved: a skipped resolved bullet reaches the assumptions (PR body)",
  );
}

// A resolved security point is recorded as self-resolved, and it does not park.
{
  const gated = finaliseSpecVerdict(
    spec(),
    section(
      "- [CRITICAL][RESOLVED] Who may call the endpoint \u2014 authentication: bearer tokens",
    ),
  );
  assert(
    gated.verdict === "proceed" &&
      gated.assumptions.some((a) =>
        a.text.startsWith("security open point self-resolved in the issue body: "),
      ),
    "resolved security point: recorded as self-resolved in the issue body, and does not park",
  );
}

// Malformed section: a CRITICAL line that does not parse caps the proceed; a HIGH line or a line
// outside the section does not.
{
  const body = [
    "Some CRITICAL context outside the section.",
    HEADING,
    "- CRITICAL: missing the bracket tag",
    "- [HIGH] a high point that mentions CRITICAL",
  ].join("\n");
  const reading = readOpenPoints(body);
  assert(
    reading.unparsed.length === 1 && reading.unparsed[0]?.startsWith("- CRITICAL"),
    `malformed: one unparsed CRITICAL line, nothing from HIGH or outside the section (${reading.unparsed.length})`,
  );
  const capped = finaliseSpecVerdict(spec(), body);
  assert(
    capped.verdict === "proceed-with-assumptions" &&
      capped.assumptions.some((a) =>
        a.text.startsWith("Open-point gate could not parse a CRITICAL line: "),
      ),
    "malformed: an unparsed CRITICAL line caps proceed with a named assumption",
  );
  const parked = finaliseSpecVerdict(spec({ verdict: "park", parkReason: "too-large" }), body);
  assert(
    parked.verdict === "park" && parked.parkReason === "too-large",
    "malformed: an existing park is not rewritten",
  );
}

// Case variants (#1171): only the uppercase bracketed tag parses. Lowercase and titlecase tags,
// and a line that leads with CRITICAL in any case, are unparsed, so they cap rather than vanish.
{
  for (const line of [
    "- [critical] Which timeout wins",
    "- [Critical] Which timeout wins",
    "- [critical][RESOLVED] Which timeout wins",
  ]) {
    const reading = readOpenPoints(section(line));
    assert(
      reading.points.length === 0 && reading.resolved.length === 0 && reading.unparsed.length === 1,
      `case variant routes to unparsed: ${line}`,
    );
    const capped = finaliseSpecVerdict(spec(), section(line));
    assert(capped.verdict === "proceed-with-assumptions", `case variant caps a proceed: ${line}`);
  }
  for (const line of ["critical: a lowercase label", "Critical review of the gap gate"]) {
    assert(
      readOpenPoints(section(line)).unparsed.length === 1,
      `a line leading with critical in any case is unparsed: ${line}`,
    );
  }
  assert(
    readOpenPoints(section("The gap gate found one critical point in the design.")).unparsed
      .length === 0,
    "mid-sentence lowercase critical in plain prose is still ignored",
  );
  const lowerSecurity = finaliseSpecVerdict(
    spec(),
    section("- [critical] Who may call the endpoint \u2014 authentication is undecided"),
  );
  assert(
    lowerSecurity.verdict === "park" && lowerSecurity.parkReason === "security-open-point",
    "case variant of a security point still parks",
  );
}

// Prose outside the section that leads with CRITICAL is not read at all.
assert(
  readOpenPoints("CRITICAL: outside any section").unparsed.length === 0,
  "a CRITICAL line outside the Open points section is not read",
);

// The security park names the whole class, not only the first words of it (#1151 review).
// (#1171: the text is derived from SECURITY_CLASS_LABELS, so a new term cannot go unnamed.)
assert(
  SECURITY_CLASS_LABELS.every((label) => explainPark("security-open-point", 42).includes(label)),
  "explainPark: the security park names every SECURITY_CLASS_TERMS label",
);

// #1151 review: an unparsed CRITICAL line naming a security class parks, as a parsed one does.
{
  const gated = finaliseSpecVerdict(spec(), section("- CRITICAL: authentication is undecided"));
  assert(
    gated.verdict === "park" && gated.parkReason === "security-open-point",
    "unparsed security line parks as security-open-point",
  );
}

// Prefixed forms of the security stems are security-class too.
for (const phrase of [
  "unencrypted payload",
  "preauth hook",
  "reauth window",
  "unvalidated input",
  "unsanitized input",
]) {
  const gated = finaliseSpecVerdict(spec(), section(`- [CRITICAL] the ${phrase} is undecided`));
  assert(
    gated.verdict === "park" && gated.parkReason === "security-open-point",
    `prefixed security form parks: ${phrase}`,
  );
}

// Handoff evidence: security points on a parked spec are open questions, one entry each.
{
  const body = section(
    "- [CRITICAL] Who may call the endpoint \u2014 authentication is undecided",
    "- [CRITICAL] Which timeout wins \u2014 proposal: the shorter",
    "- CRITICAL: authorization for the export is undecided",
  );
  const parked = finaliseSpecVerdict(
    spec({
      verdict: "park",
      parkReason: "already-implemented",
      parkReasonSource: "parsed",
    }),
    body,
  );
  const questions = parked.openQuestions.filter((q) =>
    q.startsWith("Security open point (unresolved): "),
  );
  assert(
    parked.parkReason === "already-implemented" && questions.length === 2,
    `handoff: a parked spec lists each security open point as an open question (${questions.length})`,
  );
  const gatedPark = finaliseSpecVerdict(spec(), body);
  assert(
    gatedPark.parkReason === "security-open-point" &&
      gatedPark.openQuestions.some((q) => q.includes("authentication is undecided")),
    "handoff: a security park the gate creates carries its points as open questions",
  );
}

// Round trip: the gap gate's own rendered section reads back with nothing unparsed, and a
// non-security section caps a proceed without a "could not parse" assumption.
{
  const gaps: PlanGap[] = [
    {
      severity: "CRITICAL",
      description: "Which timeout wins",
      resolution: "the shorter",
    },
    {
      severity: "CRITICAL",
      description: "Which backoff applies",
      resolution: GAP_RESOLUTION_PLACEHOLDER,
    },
  ];
  const rendered = openPointsSection(gaps);
  assert(
    readOpenPoints(rendered).unparsed.length === 0,
    "round trip: rendered section has no unparsed lines",
  );
  const finalised = finaliseSpecVerdict(spec(), rendered);
  assert(
    finalised.verdict === "proceed-with-assumptions" &&
      finalised.assumptions.length === 2 &&
      !finalised.assumptions.some((a) => /could not parse/.test(a.text)),
    `round trip: non-security section gives proceed-with-assumptions with no parse assumption (${finalised.verdict})`,
  );
}

process.exit(exit);
