#!/usr/bin/env bun
/**
 * #2141 — the Open Questions splice renders untrusted text VERBATIM.
 *
 * draftSpec assembled the body with the Open Questions section as a literal
 * `- (none)` placeholder, spliced the gate writeback, collapsed blank runs,
 * then substituted the rendered Open Questions with ONE `replace()` whose
 * REPLACEMENT was an interpolated string. `String.prototype.replace` expands
 * dollar patterns inside a string replacement: dollar-backtick re-inserts
 * everything in the body BEFORE the match, dollar-apostrophe everything AFTER
 * it, dollar-ampersand the matched placeholder itself. A single angle item
 * quoting a regex that ended in one of those re-rendered the whole body once
 * per pattern — a /plan dry run measured ~82k characters and was refused as
 * too large to file. Dollar-digit is inert at THIS sink (the placeholder
 * carries no capture groups), so it rides as a no-regression row in the same
 * bullet as a live pattern rather than as its own case.
 *
 * The fix is at the one sink: the Open Questions text is concatenated in AFTER
 * the last replace over the body. These rows are that contract:
 *
 *   - the three expanding patterns render byte-for-byte in an open question
 *     AND in a carried resolution, in both draftSpec call-site shapes —
 *     phase3Draft's fitter (no writebackMap) and correctiveRedraft's
 *     (buildResolvedDecisions + writebackMap);
 *   - dollar-digit survives unchanged beside a live pattern;
 *   - byte-stability: the same fixed input drafts to the same bytes twice,
 *     and the pattern body's length is set by the pattern text, not by how
 *     much prose precedes the section (the blow-up was proportional to it).
 *
 * The dollar patterns are built from char codes (`D` below), the repo idiom,
 * so neither this file nor the issue text carries the literal two-character
 * sequences.
 */
import { type AngleFindings, draftSpec } from "../src/plan-draft.ts";
import { phase3Draft } from "../src/plan-driver-phase3.ts";
import { correctiveRedraft } from "../src/plan-driver-redraft.ts";
import { type PlanGap, PlanType } from "../src/plan-types.ts";
import {
  type ResolvedDecision,
  buildResolvedDecisions,
  renderOpenQuestions,
} from "../src/plan-writeback.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const D = String.fromCharCode(36); // a dollar sign, spelled so this file is data
const BACKTICK = D + String.fromCharCode(96); // the prefix-inserting pattern
const APOSTROPHE = D + String.fromCharCode(39); // the suffix-inserting pattern
const AMPERSAND = D + String.fromCharCode(38); // the matched-text pattern
const DIGIT = `${D}1${D}2`; // inert at this sink — the no-regression row

const NO_DIRS = {
  acceptanceCriteria: [],
  pitfalls: [],
  outOfScope: [],
  testSurface: [],
  decomposition: [],
  neverClaim: [],
  operatorOutcomes: [],
};

function findings(text: string, items: { kind: string; text: string }[]): AngleFindings[] {
  return [
    {
      name: "affected-code",
      ok: true,
      text,
      toolUses: items.map((i) => ({ kind: i.kind, text: i.text, angle: "affected-code" })),
    },
  ];
}

/** The Open Questions section of a drafted body, terminator excluded. */
function openQuestionsSection(body: string): string {
  const start = body.indexOf("## Open Questions");
  const end = body.indexOf("\n## ", start + 1);
  return body.slice(start, end === -1 ? body.length : end);
}

/** How many times a section heading occurs — the blow-up's observable shape. */
function countHeading(body: string, heading: string): number {
  return body.split(heading).length - 1;
}

// A fixed filler: N extra reference items, i.e. prose BEFORE the Open
// Questions section. The unfixed replacement expands proportionally to it;
// the fix must not care about its size at all.
function fillerReferences(n: number): AngleFindings[] {
  return findings("surveyed the render path", [
    ...Array.from({ length: n }, (_, i) => ({
      kind: "reference",
      text: `extension/src/plan-fill-${i}.ts — filler item ${i} padding the section before Open Questions`,
    })),
  ]);
}

// The three expanding patterns + the inert digit row, as one bullet each.
const PATTERNS: { label: string; text: string }[] = [
  { label: "dollar-backtick", text: `the regex source ended ${BACKTICK} so the prefix came back` },
  {
    label: "dollar-apostrophe",
    text: `the regex source ended ${APOSTROPHE} so the suffix came back`,
  },
  {
    label: "dollar-ampersand",
    text: `the regex source ended ${AMPERSAND} so the match came back`,
  },
  {
    label: "dollar-digit (no-regression, beside a live pattern)",
    text: `the group forms ${DIGIT} and ${BACKTICK} both render verbatim`,
  },
];

const DESCRIPTOR = "make the plan body renderer insert untrusted text verbatim";

// ---------------------------------------------------------------- round 1: phase3Draft (no writebackMap)

(() => {
  for (const p of PATTERNS) {
    // The round-1 shape: no writebackMap, the Open Questions array carrying
    // the pattern (what phase3Draft's fitter is called with).
    const direct = draftSpec(
      "bug",
      DESCRIPTOR,
      findings("surveyed the render path", [
        { kind: "acceptance-criterion", text: "the section renders verbatim" },
      ]),
      [],
      [p.text],
      [],
      0,
      NO_DIRS,
      [],
      undefined,
    );
    const oq = openQuestionsSection(direct.body);
    assert(oq.includes(p.text), `phase3 shape: ${p.label} renders verbatim in an open question`);
    assert(
      countHeading(direct.body, "## Context & motivation") === 1 &&
        countHeading(direct.body, "## Open Questions") === 1,
      `phase3 shape: ${p.label} does not re-insert the body (every heading occurs once)`,
    );
    assert(
      !direct.body.includes("## Open Questions\n\n- (none)"),
      `phase3 shape: ${p.label} — the placeholder was replaced, so the splice ran`,
    );
  }
})();

// ------------------------------- round 2: correctiveRedraft (resolvedDecisions + writebackMap)

(() => {
  for (const p of PATTERNS) {
    const gap: PlanGap = {
      severity: "CRITICAL",
      description: `the ${p.label} case is unhandled`,
      resolution: `insert the rendered text after the last replace, quoting ${p.text}`,
      resolutionType: "concrete",
    };
    let title = "";
    let body = "";
    correctiveRedraft([gap], {
      type: "bug",
      descriptor: DESCRIPTOR,
      findings: findings("surveyed the render path", [
        { kind: "acceptance-criterion", text: "the section renders verbatim" },
      ]),
      inventoryContext: [],
      openQuestions: [],
      outOfScope: [],
      depth: 0,
      directives: NO_DIRS,
      chosenBudget: { maxItemsPerSection: 20, itemClipChars: 400 },
      setCarried: () => {},
      setTitleBody: (t, b) => {
        title = t;
        body = b;
      },
    });
    const oq = openQuestionsSection(body);
    assert(
      oq.includes(p.text),
      `correctiveRedraft: ${p.label} renders verbatim in the carried resolution's Open Questions bullet`,
    );
    assert(
      countHeading(body, "## Context & motivation") === 1 &&
        countHeading(body, "## References") === 1,
      `correctiveRedraft: ${p.label} does not duplicate the body around the splice`,
    );
    assert(title.length > 0, `correctiveRedraft: ${p.label} produced a title and body`);
    // The same decision, driven straight at draftSpec with a real writebackMap
    // whose destination survived rendering — a resolution naming the Edge cases
    // section (the shape correctiveRedraft builds internally for a write).
    const writeGap: PlanGap = {
      severity: "CRITICAL",
      description: `the ${p.label} case is unhandled`,
      resolution: `state the boundary verbatim ${p.text} in the Edge cases section`,
      resolutionType: "concrete",
    };
    const { decisions, writebackMap } = buildResolvedDecisions([writeGap], "bug");
    const direct = draftSpec(
      "bug",
      DESCRIPTOR,
      findings("surveyed the render path", [
        { kind: "acceptance-criterion", text: "the section renders verbatim" },
      ]),
      [],
      [],
      [],
      0,
      NO_DIRS,
      decisions,
      writebackMap,
    );
    assert(
      openQuestionsSection(direct.body).includes(p.text),
      `writebackMap shape: ${p.label} renders verbatim in the resolution bullet`,
    );
    assert(
      direct.body.includes(
        `- (gate resolution) state the boundary verbatim ${p.text} in the Edge cases section`,
      ),
      `writebackMap shape: ${p.label} survives the section splice verbatim too`,
    );
  }
})();

// ---------------------------------------------------- byte-stability + no scaling with preceding sections

{
  const build = (n: number, withPattern: boolean) =>
    draftSpec(
      "bug",
      DESCRIPTOR,
      fillerReferences(n),
      [],
      withPattern ? [`quote ${BACKTICK} ${APOSTROPHE} ${AMPERSAND} ${DIGIT} verbatim`] : [],
      [],
      0,
      NO_DIRS,
      [],
      undefined,
    ).body;

  const a = build(3, true);
  const b = build(3, true);
  assert(a === b, "byte-stability: the same fixed input drafts to identical bytes twice");
  assert(
    a.length === b.length,
    "byte-stability: the same fixed input has the same body length twice",
  );

  const small = build(1, true);
  const large = build(60, true);
  // The discriminator for Evidence 2. One ~65-char Open Questions bullet cost
  // ~760 extra characters on the unfixed body — the whole preceding body
  // re-inserted per pattern — while the identical input with NO pattern costs
  // 64. So the pattern body must stay within a small additive distance of its
  // own pattern-free twin, whatever the sections above it contain.
  const plainSmall = build(1, false);
  const plainLarge = build(60, false);
  assert(
    large.length - plainLarge.length < 200 && small.length - plainSmall.length < 200,
    `a dollar-pattern bullet costs its own text, not the preceding body (plain ${plainSmall.length}/${plainLarge.length} vs pattern ${small.length}/${large.length})`,
  );
  // Past the section's per-item cap the filler PLATEAUS and is disclosed as a
  // bounded note, so a body that kept growing there was re-rendering text it
  // had already dropped, not rendering it once.
  const plateau = build(400, true);
  assert(
    plateau.length - large.length < 200,
    `filler past the section cap costs a bounded note, not a copy of the body (${large.length} → ${plateau.length})`,
  );
  assert(
    countHeading(large, "## Open Questions") === 1 &&
      countHeading(large, "## Context & motivation") === 1,
    "no heading occurs twice in the pattern body with filler",
  );
}

// -------------------------- renderOpenQuestions is itself a pure renderer (no replace sink)

{
  const decisions: ResolvedDecision[] = [
    { description: `d ${BACKTICK} kept`, resolution: `q ${APOSTROPHE} kept`, writtenBack: true },
    { description: `r ${AMPERSAND} kept`, resolution: `s ${DIGIT} kept` },
  ];
  const rendered = renderOpenQuestions(
    [`plain ${BACKTICK} ${APOSTROPHE} ${AMPERSAND} ${DIGIT}`],
    decisions,
  );
  assert(
    rendered.includes(BACKTICK) &&
      rendered.includes(APOSTROPHE) &&
      rendered.includes(AMPERSAND) &&
      rendered.includes(DIGIT),
    "renderOpenQuestions: every pattern reaches the string it returns intact",
  );
  assert(
    rendered.includes("status: resolved") && rendered.includes("status: open"),
    "renderOpenQuestions: written-back records still render resolved, un-written ones open",
  );
}

process.exit(exit);
