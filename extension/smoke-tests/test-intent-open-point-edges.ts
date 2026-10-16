#!/usr/bin/env bun
/**
 * #1187 — the Open points reader, one assertion per form the acceptance criteria name.
 *
 * The gate is topic-neutral: an unresolved CRITICAL point parks whatever it says.
 * What is tested here is the SHAPE rules: which lines are points, which are resolved,
 * which block (unparsed), and which never park. The gate's verdict is in
 * test-intent-open-point-gate.ts.
 */

import { OPEN_POINTS_HEADING, openPointsHeadingPattern } from "../src/open-points-contract.ts";
import { OPEN_POINT_ENTRY_CAP, readOpenPoints } from "../src/open-points-reader.ts";
import { openPointsSection } from "../src/plan-gap-disclosure.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gap-parse.ts";
import type { PlanGap } from "../src/plan-types.ts";
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

// --- Every stored text is REAL text, not the empty string (#1187 fix round 2) ----------
//
// The reader used to seed each entry with `text: ""` and only overwrite it when a second
// piece arrived, so a prose line, a sub-heading, a setext underline, a fence and any
// single-line item drained into the reading as "" and the handoff rendered empty bullets.
// Counts alone could not see that; these assertions read the TEXT of one-entry forms.
assert(
  readOpenPoints(section("### Details")).unparsed[0] === "### Details",
  "a sub-heading stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("The gap gate found one thing in the design.")).unparsed[0] ===
    "The gap gate found one thing in the design.",
  "a non-bullet prose line stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("Setext title", "---")).unparsed.some((t) => t === "---"),
  "a setext underline stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("```")).unparsed[0] === "```",
  "a single-line fence stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("- [CRITICAL] one line only")).points[0] === "[CRITICAL] one line only",
  "a single-line CRITICAL point stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("- [CRITICAL][RESOLVED] one line only")).resolved[0] ===
    "[CRITICAL][RESOLVED] one line only",
  "a single-line resolved point stores its own text (was an empty bullet)",
);
assert(
  readOpenPoints(section("~~~", "inside", "~~~")).unparsed.every((t) => t !== "") &&
    readOpenPoints(section("~~~", "inside", "~~~")).unparsed[0] === "~~~ inside ~~~",
  "a fenced block accumulates its whole body into the fence entry's text, and no entry is empty",
);
assert(
  readOpenPoints(section("```", "", "```", "- plain")).unparsed.every((t) => t !== ""),
  "a blank line inside a fence never becomes an entry or an empty string",
);
assert(
  readOpenPoints(section("- [CRITICAL] a", "", "### Details")).unparsed.every((t) => t !== ""),
  "no entry of any kind reaches a reading as an empty string",
);

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

/** Reads a section and reports (points, resolved, unparsed) counts. */
function counts(...lines: string[]) {
  const r = readOpenPoints(section(...lines));
  return { p: r.points.length, r: r.resolved.length, u: r.unparsed.length };
}

/** The verdict the gate reaches for the same section. */
const verdictOf = (...lines: string[]) => finaliseSpecVerdict(spec(), section(...lines)).verdict;

// --- Forms that PARK -------------------------------------------------------

assert(
  counts("- ~~[CRITICAL] Who may call the endpoint~~").u === 1,
  "struck-through severity bullet parks (unparsed)",
);
assert(
  counts("- [CRITICAL] Which timeout wins", "wrapped onto an unindented line").u === 1,
  "unindented continuation line parks",
);
assert(
  counts("- [CRITICAL][RESOLVED] Which timeout wins", "unindented wrap").u === 1 &&
    counts("- [CRITICAL][RESOLVED] Which timeout wins", "unindented wrap").r === 1,
  "unindented continuation after a [RESOLVED] bullet parks, and the resolved point still resolves",
);
assert(
  counts("- [CRI\u200BTICAL] retry timeout").p === 1,
  "zero-width character inside [CRITICAL] is stripped, so the point parks",
);
assert(
  counts("- [HI\u200BGH] retry timeout").p === 0 && counts("- [HI\u200BGH] retry timeout").u === 0,
  "zero-width character inside [HIGH] is stripped, and a HIGH bullet does not park",
);
assert(
  counts("- [critical] retry timeout").u === 1 && counts("- [critical] retry timeout").p === 0,
  "lowercase [critical] is tag-like and parks",
);
assert(counts("- [CRIT ICAL] retry timeout").u === 1, "split [CRIT ICAL] is tag-like and parks");
assert(
  counts("- [CRIT-ICAL] retry timeout").u === 1,
  "hyphen-split [CRIT-ICAL] is tag-like and parks",
);
assert(
  counts("- [\u0421RITICAL] retry timeout").u === 1 &&
    counts("- [\u0421RITICAL] retry timeout").p === 0,
  "a homoglyph tag (Cyrillic С) is an unknown token and parks as unparsed",
);
assert(
  counts("- [CRITICAL] [RESOLVED] Which timeout wins").r === 1,
  "[CRITICAL] [RESOLVED] with a space resolves (spaced form)",
);
assert(
  counts("- [CRITICAL] **[RESOLVED]** Which timeout wins").p === 1,
  "emphasised **[RESOLVED]** does not count: the point still gates",
);
assert(
  counts("- **[CRITICAL]** Which timeout wins").u === 1,
  "a severity tag behind emphasis is unparsed, so it parks",
);
assert(
  counts("The gap gate found one thing in the design.").u === 1,
  "a non-bullet prose line parks",
);
assert(
  counts("```", "# not a heading", "```", "- [CRITICAL] after the fence").p === 1 &&
    counts("```", "# not a heading", "```").u >= 1,
  "a fenced block parks, and a # line inside it neither ends the section nor is a heading",
);
assert(
  counts("### Details", "- [CRITICAL] after the sub-heading").p === 1 &&
    counts("### Details").u === 1,
  "a sub-heading inside the section parks and does not end the section",
);
assert(counts("Setext title", "---").u >= 1, "a setext underline inside the section parks");
assert(
  counts("```", "- [CRITICAL] never closed").u >= 1 &&
    counts("```", "- [CRITICAL] never closed").p === 0,
  "an unclosed fence runs to end of body and its lines park",
);
assert(
  counts("  indented with no bullet above it").u === 1,
  "an indented line with no preceding bullet parks",
);
assert(
  counts("- [docs-ish] see the note").u === 1,
  "a bracketed token at bullet start that is not a known token parks",
);
assert(
  counts("critical: the retry ceiling").u === 1,
  "a bullet that opens with the word critical (no brackets) parks",
);

// --- Forms that PASS (never park) ------------------------------------------

assert(counts("- plain untagged note").u === 0, "plain untagged bullet does not park");
assert(counts("- [ ] an open task").u === 0, "unchecked task checkbox does not park");
assert(counts("- [x] a done task").u === 0, "checked task checkbox does not park");
assert(
  counts("- [docs](https://example.com) note").u === 0,
  "bullet starting with a link does not park",
);
assert(
  counts("- [HIGH] a high point").u === 0 && counts("- [HIGH] a high point").p === 0,
  "[HIGH] does not gate",
);
assert(
  counts("1) an ordered plain item").u === 0,
  "an ordered item counts as a bullet and does not park",
);
assert(counts("- plain note", "", "", "- another note").u === 0, "blank lines never park");
assert(
  counts("- plain note", "  wrapped with indent").u === 0,
  "an indented line after a plain bullet continues it and does not park",
);
assert(
  counts("- [CRITICAL] Which timeout wins", "  wrapped with indent").p === 1,
  "an indented continuation joins its CRITICAL point",
);

// --- Points, resolutions and the gate's verdict ----------------------------

assert(counts("- [CRITICAL]").p === 1, "a bare [CRITICAL] bullet is still a point");
assert(counts("1. [CRITICAL] an ordered point").p === 1, "an ordered CRITICAL item is a point");
assert(
  counts("- [CRITICAL](https://example.com) retry timeout").p === 1,
  "an exact [CRITICAL] tag wins over a following link: a point",
);
assert(
  counts("- [CRITICAL] Which timeout wins", "  - nested plain note").p === 1 &&
    counts("- [CRITICAL] Which timeout wins", "  - nested plain note").u === 0,
  "a nested plain bullet is its own item and does not park",
);
assert(
  verdictOf("- [CRITICAL] Which timeout wins") === "park",
  "a topic-neutral CRITICAL point (retry timeout) parks",
);
assert(
  verdictOf("- [CRITICAL][RESOLVED] Which timeout wins") === "proceed",
  "a resolved CRITICAL point proceeds",
);
assert(
  verdictOf("- [CRITICAL] Which timeout wins", "wrapped") === "park",
  "a wrapped point with unindented continuation parks",
);

// --- Section boundaries ----------------------------------------------------

{
  const body = [
    HEADING,
    "",
    "- plain note",
    "",
    "## Some other section",
    "- [CRITICAL] outside the section",
  ].join("\n");
  assert(readOpenPoints(body).points.length === 0, "a same-level heading ends the section");
}
{
  const body = "## Open questions\n\n- [CRITICAL] outside any section\n";
  assert(
    readOpenPoints(body).points.length === 0 && readOpenPoints(body).unparsed.length === 0,
    "no exact Open points heading: no section, nothing parks",
  );
  assert(
    finaliseSpecVerdict(spec(), body).verdict === "proceed",
    "no exact Open points heading: the spec is not parked by this gate",
  );
}
{
  const near = "## Open points (unresolved at the gap-gate)\n\n- [CRITICAL] mangled heading\n";
  assert(
    readOpenPoints(near).points.length === 0,
    "a near-miss heading is not detected (no section, no park)",
  );
}

// --- Flattened, verbatim text ----------------------------------------------

{
  const long = `- [CRITICAL] ${"x".repeat(400)} tail`;
  const point = readOpenPoints(section(long)).points[0] ?? "";
  assert(
    point.endsWith("tail") && point.length > 400,
    "open point text is unclipped flattenIssueText output",
  );
}
{
  const r = readOpenPoints(section("- [CRITICAL] line\u202Eone\u0007two"));
  assert(
    r.points[0] === "[CRITICAL] lineone two",
    "bidi and control characters are flattened out of the point text",
  );
}
{
  const r = readOpenPoints(section("- [CRITICAL][RESOLVED] Which timeout wins"));
  assert(
    r.resolved[0] === "[CRITICAL][RESOLVED] Which timeout wins",
    "a resolved point keeps its flattened text",
  );
}

// --- The section heading is DERIVED from the contract constant (#1187 fix round 2) -----
//
// The matcher used to be a second copy of the heading literal, so a rename on the writer's
// side left the reader matching a heading nothing wrote any more — a gate that silently
// never ran. These canaries fail if the derivation is replaced by a literal again.
{
  const derived = new RegExp(openPointsHeadingPattern());
  assert(
    derived.test(`## ${OPEN_POINTS_HEADING}`),
    "canary: the derived matcher accepts `## ` + OPEN_POINTS_HEADING as the writer renders it",
  );
  assert(
    !derived.test("## Open points (unresolved at the gap-gate") &&
      !derived.test("## Open points somewhere else"),
    "canary: the derived matcher still rejects a near-miss heading (parentheses are literal)",
  );
  const body = `## ${OPEN_POINTS_HEADING}\n\n- [CRITICAL] retry timeout\n`;
  assert(
    readOpenPoints(body).points.length === 1,
    "canary: a section written from the constant is read by the reader",
  );
}

// --- Round trip with the /plan gap gate's own rendering --------------------

// The gate, not just the reader: the text the handoff will actually quote (#1187 fix round 2).
assert(
  finaliseSpecVerdict(spec(), section("The gap gate left one thing open.")).openPoints?.[0] ===
    "The gap gate left one thing open.",
  "finaliseSpecVerdict records a prose line's TEXT in openPoints, not an empty bullet",
);
{
  const gaps: PlanGap[] = [
    {
      severity: "CRITICAL",
      description: "Which timeout wins when both are set",
      resolution: GAP_RESOLUTION_PLACEHOLDER,
    } as PlanGap,
  ];
  const rendered = openPointsSection(gaps);
  // #1187 fix round 1: the writer's intro sentence is OPEN_POINTS_INTRO and the reader
  // skips it, so the gap gate's own section reads back as exactly the points it wrote.
  // Nothing in the section is prose that parks — which is what makes [RESOLVED] able to
  // clear a gap-gate-filed issue at all (see test-intent-open-point-gate.ts).
  assert(
    readOpenPoints(rendered).points.length === 1 && readOpenPoints(rendered).unparsed.length === 0,
    "the gap gate's rendered section reads back as exactly one point, with no prose line parking",
  );
}

// --- Fence state is scoped to the section (#1187 fix round 2) ---------------

{
  const fence = "```";
  const unclosed = `${fence}\nsome code that never closes\n\n${section(
    "- [CRITICAL] a",
    "- [CRITICAL] b",
    "- [CRITICAL] c",
  )}`;
  const r = readOpenPoints(unclosed);
  assert(
    r.points.length === 3 && finaliseSpecVerdict(spec(), unclosed).verdict === "park",
    "an unclosed fence ABOVE the heading does not swallow it: all 3 CRITICAL points read, and the gate parks",
  );
}
{
  const fence = "```";
  const closed = `${fence}\nfenced code\n${fence}\n\n${section("- [CRITICAL] after the fence")}`;
  assert(
    readOpenPoints(closed).points.length === 1 && readOpenPoints(closed).unparsed.length === 0,
    "a CLOSED fence above the heading leaves the section clean",
  );
}
{
  // A fence inside the section is still a fence: its # line is not a heading and does not end it.
  const body = [HEADING, "", "```", "## Some other section", "```", "- [CRITICAL] after"].join(
    "\n",
  );
  const r = readOpenPoints(body);
  assert(
    r.points.length === 1 && r.unparsed.length === 1,
    "inside the section a fence still hides its # line and the block parks as one entry",
  );
}

// --- An indented list item is its own entry (#1187 fix round 2) -------------

assert(
  counts("- [CRITICAL][RESOLVED] top point", "  - [CRITICAL] nested point").p === 1 &&
    counts("- [CRITICAL][RESOLVED] top point", "  - [CRITICAL] nested point").u === 0,
  "a nested CRITICAL bullet under a resolved point is its own point, so it parks",
);
assert(
  verdictOf("- [CRITICAL][RESOLVED] top point", "  - [CRITICAL] nested point") === "park",
  "the gate parks on a nested CRITICAL bullet hidden under a resolved one",
);
assert(
  counts("- [CRITICAL][RESOLVED] top point", "  - plain nested note").p === 0 &&
    counts("- [CRITICAL][RESOLVED] top point", "  - plain nested note").u === 0 &&
    counts("- [CRITICAL][RESOLVED] top point", "  - plain nested note").r === 1,
  "a nested plain bullet follows the same rule as a top-level plain bullet: it does not park",
);
assert(
  verdictOf("- [CRITICAL][RESOLVED] top point", "  - plain nested note") === "proceed",
  "a resolved point with a nested plain note proceeds",
);
assert(
  counts("- [CRITICAL][RESOLVED] top point", "  plain wrapped prose").u === 0 &&
    readOpenPoints(section("- [CRITICAL][RESOLVED] top point", "  plain wrapped prose"))
      .resolved[0] === "[CRITICAL][RESOLVED] top point plain wrapped prose",
  "an indented plain PROSE line still continues its bullet (joined into the point text, not its own entry)",
);
assert(
  readOpenPoints(section("- [CRITICAL] top point", "  plain wrapped prose")).points[0] ===
    "[CRITICAL] top point plain wrapped prose",
  "an indented prose continuation joins its CRITICAL point, whose text is stored redacted and bounded",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
