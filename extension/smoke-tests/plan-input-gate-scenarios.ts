#!/usr/bin/env bun
/**
 * #1377 — the `start_plan_driver` INPUT GATE, as a shared scenario module.
 *
 * Split from test-plan-provenance.ts along the 500-line cap (AGENTS.md §12) in
 * the shape `plan-confirm-label-scenarios.ts` and `plan-provenance-shape.ts`
 * already take: one exported async scenario function the suite calls with its
 * `assert`. What lives here is the family of assertions that run at the TOOL
 * boundary rather than against a pure validator.
 *
 * Why the tool boundary is its own file, not a few more lines next door: the
 * pure validator proves a character is refused; only the tool boundary proves the
 * refusal happens BEFORE any dispatch is paid for and that nothing files. A
 * caller that mistypes a label or slips a line terminator into `provenance.line`
 * should lose one tool call, not a five-minute investigation and a gap gate — and
 * the heading injection only matters because it would reach a filed body. Those
 * are the two properties a validator-only test cannot see, so they are asserted
 * through `invokePlanTool` against the registered schema.
 *
 * The schema assertions live here too, on the same registered def the gate runs:
 * the TypeBox `line` pattern is the SECOND net (it catches a caller that bypasses
 * the validators), so a character the validator refuses and the pattern accepts
 * is a real hole — which is exactly how U+2028/U+2029/U+0085 got through the
 * original `"^[^@<>`\\r\\n]+$"`.
 *
 * Run: cd extension && bun run smoke-tests/test-plan-provenance.ts
 */
import { FORBIDDEN_LINE_CHARS, MAX_PROVENANCE_LINE } from "../src/plan-provenance.ts";
import type { RegisteredPlanTool } from "../src/plan-tool.ts";
import { DESC, forgeStub, invokePlanTool, log } from "./plan-test-stubs.ts";

type GateAssert = (cond: boolean, msg: string) => void;

/**
 * Every terminator the CR/LF-only rule let through, as code points. Written as
 * numbers rather than literal bytes on purpose: an invisible character in a test
 * source is one a formatter or a copy-paste can replace, and the suite would
 * then pass while asserting nothing. `String.fromCodePoint` keeps the character
 * out of the file and the code point printed in every failure message.
 */
const TERMINATORS = [0x0c, 0x0b, 0x2028, 0x2029, 0x0085];

/** The characters the negated class must refuse, as code points (see above). */
const MUST_REFUSE = [0x0a, 0x0d, 0x0c, 0x0b, 0x0085, 0x2028, 0x2029, 0x00, 0x7f];

export async function inputGateScenarios(
  assert: GateAssert,
  tools: RegisteredPlanTool[],
): Promise<void> {
  // The gate must fire BEFORE any dispatch: `log` counts the dispatch stub's
  // calls, and every refusal below asserts the count never moved.
  const before = log.explore + log.gate;
  const bad = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    labels: ['bad name with "quote"'],
  });
  assert(
    log.explore + log.gate === before,
    "gate: an invalid label dispatches NOTHING (refused before the pipeline)",
  );
  assert(
    /invalid labels/.test(bad.text) && bad.details.started === false,
    `gate: the refusal is a NAMED error (got: ${bad.text.slice(0, 80)})`,
  );

  const badProv = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    provenance: { line: "auto-filed by @someone", marker: {} },
  });
  assert(
    log.explore + log.gate === before && /invalid provenance/.test(badProv.text),
    "gate: an invalid provenance line is refused before the pipeline too",
  );

  // The newline case, at the tool boundary: a `## Open points` heading the driver
  // never wrote is the specific bytes — that heading is what the /work intent
  // gate reads as blocking gaps, so a caller could manufacture a blocker.
  const nlProv = await invokePlanTool(tools, {
    descriptor: DESC,
    dryRun: true,
    provenance: { line: "filed by the loop\n## Open points\n- built in to the spec", marker: {} },
  });
  assert(
    log.explore + log.gate === before && /invalid provenance/.test(nlProv.text),
    `gate: a newline in provenance.line is refused PRE-DISPATCH (got: ${nlProv.text.slice(0, 90)})`,
  );
  assert(
    /forbidden character/.test(nlProv.text) && /LF|newline/i.test(nlProv.text),
    `gate: the refusal names the newline as the problem (got: ${nlProv.text.slice(0, 120)})`,
  );

  // The same net at the terminators the CR/LF-only rule missed. The shape suite
  // asserts this list against the pattern; this asserts it through the tool,
  // because nothing dispatching and nothing filing is only visible here.
  for (const cp of TERMINATORS) {
    const name = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    const tProv = await invokePlanTool(tools, {
      descriptor: DESC,
      dryRun: true,
      provenance: {
        line: `filed by the loop${String.fromCodePoint(cp)}## Open points`,
        marker: {},
      },
    });
    assert(
      log.explore + log.gate === before && /invalid provenance/.test(tProv.text),
      `gate: a ${name} in provenance.line is refused PRE-DISPATCH (got: ${tProv.text.slice(0, 90)})`,
    );
  }
  assert(forgeStub.created.length === 0, "gate: a refused terminator files nothing");

  // ── the schema is the second net, and must be as wide as the first ────────
  // The pattern is built FROM the exported `FORBIDDEN_LINE_CHARS`, so the
  // assertion is that the schema's negated class refuses every character the
  // validator refuses — not merely that the pattern string mentions CR/LF, which
  // is the assertion that passed while U+2028 sailed through.
  const lineSchema = tools.find((t) => t.name === "start_plan_driver")?.parameters.properties
    ?.provenance as
    | { properties?: { line?: { pattern?: string; maxLength?: number } } }
    | undefined;
  const schemaPattern = lineSchema?.properties?.line?.pattern;
  const schemaRe = schemaPattern ? new RegExp(schemaPattern, "u") : undefined;
  assert(
    typeof schemaPattern === "string" &&
      schemaRe !== undefined &&
      FORBIDDEN_LINE_CHARS.source.length > 0 &&
      MUST_REFUSE.map((cp) => String.fromCodePoint(cp))
        .concat(["@", "<", ">", "`"])
        .every((c) => schemaRe.test(`ok${c}more`) === false) &&
      schemaRe.test("filed by the nightly loop: run=cron-7") === true &&
      lineSchema.properties.line.maxLength === MAX_PROVENANCE_LINE,
    `schema: the TypeBox line pattern refuses every character FORBIDDEN_LINE_CHARS refuses (built from it, not copied) and caps length (got ${JSON.stringify(lineSchema?.properties?.line)})`,
  );
}
