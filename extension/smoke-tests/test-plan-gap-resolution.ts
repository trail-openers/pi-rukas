#!/usr/bin/env bun
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { rerouteGateQuotes } from "../src/plan-gap-resolution.ts";
/**
 * #1111 — the /plan gap gate must not splice undecided resolutions into the
 * spec body, and must not cap the plan on the CRITICAL that its own splice
 * produces. Companion to test-plan-gap-writeback.ts (the 500-line seam).
 *
 *   - only a `resolution-type: concrete` resolution is spliced, as its concrete
 *     statement with no (a)/(b)/(c) label;
 *   - instruction, research and operator-decision (either/or) resolutions, and
 *     a missing or unparseable type, stay in Open Questions (status: open);
 *   - a CRITICAL quoting a gate-spliced bullet is re-routed to the residual
 *     disclosure and never counts toward the cap.
 */
import { parseGaps } from "../src/plan-gaps.ts";
import type { PlanGap } from "../src/plan-types.ts";
import {
  buildResolvedDecisions,
  markWrittenDecisions,
  renderOpenQuestions,
} from "../src/plan-writeback.ts";
import {
  forgeStub,
  gatePrompts,
  installForgeStub,
  installNoPlanCacheStub,
  installOfflineVipuneStub,
  makeDispatchStub,
} from "./plan-test-stubs.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

installForgeStub();
installOfflineVipuneStub();
installNoPlanCacheStub();

const DESCRIPTOR = "add a start_plan_driver tool for the plan pipeline in extension";
const RETRY_STATEMENT =
  "in the Acceptance criteria section, the retry path stops after three attempts";

function sectionOf(body: string, heading: string, nextHeading: string): string {
  const start = body.indexOf(`## ${heading}`);
  const end = body.indexOf(`## ${nextHeading}`, start);
  return body.slice(start, end === -1 ? body.length : end);
}

// ------------------------------ branch 1: resolution names Acceptance criteria

{
  // A CRITICAL whose resolution explicitly names the Acceptance criteria
  // section → written back to that section (outside Open Questions), and the
  // Open Questions bullet renders status: resolved. Round 2 has no CRITICAL,
  // so the cap routes to file (the single-round corrective shape).
  // #1111: the resolution is typed concrete, so it is spliced.
  const replies = [
    `GAP: CRITICAL no failure-mode criterion — proposed resolution: ${RETRY_STATEMENT} — resolution-type: concrete\nVERDICT: NEEDS_ITERATION`,
    "GAP: MEDIUM minor clarification — proposed resolution: add a note — resolution-type: concrete\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(replies) as never);

  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );

  const body = r.spec;
  const ac = sectionOf(body, "Acceptance criteria", "References");
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    ac.includes(`- (gate resolution) ${RETRY_STATEMENT}`),
    "branch 1: the concrete resolution is a NEW bullet in the Acceptance criteria section (marked, no label)",
  );
  assert(
    !oq.includes(`- (gate resolution) ${RETRY_STATEMENT}`),
    "branch 1: the resolution text is NOT a bullet in Open Questions (writeback is outside it)",
  );
  assert(
    oq.includes("no failure-mode criterion"),
    "branch 1: the gap description renders in Open Questions",
  );
  assert(
    /status: resolved/.test(oq),
    "branch 1: the written-back decision renders status: resolved",
  );
  assert(!/status: open/.test(oq), "branch 1: no status: open bullet for a written-back decision");
  // The round-2 gate prompt is built from the re-drafted body: the reviewer
  // sees the applied resolution (not just the round-1 body).
  const r2 = gatePrompts[1] ?? "";
  assert(
    r2.includes(RETRY_STATEMENT),
    "branch 1: round-2 gate prompt contains the written-back resolution (built from the re-drafted body)",
  );
  assert(
    r2.includes("status: resolved"),
    "branch 1: round-2 gate prompt renders the carried gap as status: resolved",
  );

  setPlanDispatch(null);
}

// ------------------- branch 1b: instruction-form resolution is NOT spliced (#1111)

{
  // "(b) add acceptance criteria for …" is an instruction to the author, not
  // a criterion. Even though it names the Acceptance criteria section, its
  // declared type is `instruction`, so nothing lands in any body section.
  const replies = [
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: (b) add acceptance criteria for the retry path to the Acceptance criteria section — resolution-type: instruction\nVERDICT: NEEDS_ITERATION",
    "GAP: LOW cosmetic nit — proposed resolution: retitle — resolution-type: concrete\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(replies) as never);

  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );

  const body = r.spec;
  const ac = sectionOf(body, "Acceptance criteria", "References");
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    !body.includes("(gate resolution)"),
    "#1111 instruction: no gate-resolution bullet lands in ANY body section",
  );
  assert(
    !ac.includes("add acceptance criteria for the retry path"),
    "#1111 instruction: the instruction text is not in Acceptance criteria",
  );
  assert(
    /status: open/.test(oq) && /decision owner: operator/.test(oq),
    "#1111 instruction: the decision stays status: open, owner operator",
  );
  assert(
    oq.includes("add acceptance criteria for the retry path"),
    "#1111 instruction: the resolution stays visible in Open Questions",
  );

  setPlanDispatch(null);
}

// ------------------- branch 1c: either/or operator-decision is NOT spliced (#1111)

{
  const replies = [
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: either add an acceptance criterion for the retry path or narrow the scope to the first attempt — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION",
    "GAP: LOW cosmetic nit — proposed resolution: retitle — resolution-type: concrete\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(replies) as never);

  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );

  const body = r.spec;
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    !body.includes("(gate resolution)"),
    "#1111 either/or: no gate-resolution bullet lands in any body section",
  );
  assert(
    !/either|\(b\)|\(c\)/.test(sectionOf(body, "Acceptance criteria", "References")),
    "#1111 either/or: no either/(b)/(c) text in Acceptance criteria",
  );
  assert(
    /status: open/.test(oq) && /decision owner: operator/.test(oq),
    "#1111 either/or: the decision stays status: open, owner operator",
  );

  setPlanDispatch(null);
}

// ------------------- branch 1d: missing or unparseable type is never spliced (#1111)

{
  const missing = parseGaps(
    `GAP: CRITICAL no failure-mode criterion — proposed resolution: ${RETRY_STATEMENT}\nVERDICT: NEEDS_ITERATION`,
  );
  assert(
    missing.gaps[0]?.resolutionType === undefined,
    "#1111 parse: a missing resolution-type parses as undefined",
  );
  const bogus = parseGaps(
    `GAP: CRITICAL no failure-mode criterion — proposed resolution: ${RETRY_STATEMENT} — resolution-type: probably\nVERDICT: NEEDS_ITERATION`,
  );
  assert(
    bogus.gaps[0]?.resolutionType === undefined,
    "#1111 parse: an unrecognised resolution-type parses as undefined",
  );
  assert(
    bogus.gaps[0]?.resolution === RETRY_STATEMENT,
    "#1111 parse: the type segment is not left dangling in the resolution text",
  );
  const concrete = parseGaps(
    `GAP: CRITICAL no failure-mode criterion — proposed resolution: ${RETRY_STATEMENT} — resolution-type: concrete\nVERDICT: NEEDS_ITERATION`,
  );
  assert(
    concrete.gaps[0]?.resolutionType === "concrete",
    "#1111 parse: resolution-type: concrete is read",
  );
  assert(
    concrete.gaps[0]?.resolution === RETRY_STATEMENT,
    "#1111 parse: the resolution text excludes the type segment",
  );

  const untyped: PlanGap = {
    severity: "CRITICAL",
    description: "no failure-mode criterion",
    resolution: RETRY_STATEMENT,
  };
  const noType = buildResolvedDecisions([untyped], "feature");
  assert(noType.writebackMap.size === 0, "#1111 untyped: a gap with no type is never spliced");
  assert(
    noType.decisions[0]?.writebackHeading === undefined,
    "#1111 untyped: no destination recorded",
  );
}

{
  // #1111: a leftover (a)/(b)/(c) label mid-text, or either/or, never splices
  // even when the type is concrete (the type is the reviewer's claim; the
  // text is checked too).
  const labelled = buildResolvedDecisions(
    [
      {
        severity: "CRITICAL",
        description: "missing retry criterion",
        resolution: "(a) the retry path stops after three attempts (Acceptance criteria)",
        resolutionType: "concrete",
      },
    ],
    "feature",
  );
  assert(
    labelled.writebackMap.get("Acceptance criteria")?.[0] ===
      "(gate resolution) the retry path stops after three attempts (Acceptance criteria)",
    "#1111 label: a concrete resolution is spliced without its (a) label",
  );
}

// ------------------- #1111: a CRITICAL quoting a gate bullet is re-routed

{
  const carried: PlanGap[] = [
    {
      severity: "CRITICAL",
      description: "no failure-mode criterion",
      resolution: RETRY_STATEMENT,
      resolutionType: "concrete",
    },
  ];
  const quoting = parseGaps(
    `GAP: CRITICAL — the bullet "(gate resolution) ${RETRY_STATEMENT}" does not state a behaviour — proposed resolution: restate it — resolution-type: concrete\nVERDICT: NEEDS_ITERATION`,
  );
  const { kept, rerouted } = rerouteGateQuotes(quoting.gaps, carried);
  assert(
    kept.length === 0,
    "#1111 re-route: a CRITICAL quoting a gate-spliced bullet is not kept as blocking",
  );
  assert(
    rerouted.length === 1 && rerouted[0]?.severity === "CRITICAL",
    "#1111 re-route: it is carried to the residual disclosure at the originating gap's severity",
  );
  // A quoted marker with no spliced origin (no carried round, or only a
  // non-concrete carried gap) is not a gate bullet: the CRITICAL stays blocking.
  const unorigined = rerouteGateQuotes(quoting.gaps, []);
  assert(
    unorigined.kept.length === 1 && unorigined.rerouted.length === 0,
    "#1111 re-route: a marker quote with no spliced origin stays blocking",
  );
  const nonConcreteOrigin: PlanGap = { ...carried[0], resolutionType: "operator-decision" } as PlanGap;
  const nonConcrete = rerouteGateQuotes(quoting.gaps, [nonConcreteOrigin]);
  assert(
    nonConcrete.kept.length === 1 && nonConcrete.rerouted.length === 0,
    "#1111 re-route: a non-concrete carried gap is never a splice origin",
  );
  const genuine = parseGaps(
    "GAP: CRITICAL — the retry cap contradicts the quota rule — proposed resolution: name which wins — resolution-type: operator-decision\nVERDICT: NEEDS_ITERATION",
  );
  const g2 = rerouteGateQuotes(genuine.gaps, carried);
  assert(
    g2.kept.length === 1 && g2.rerouted.length === 0,
    "#1111 re-route: a genuine CRITICAL is still blocking",
  );
}

// ------------------- #1111 round 2: READY with a re-routed CRITICAL is disclosed

{
  // Round 2 says READY, but its only CRITICAL quotes the gate's spliced bullet:
  // it is re-routed, and must still reach the residual disclosure (no silent drop).
  const replies = [
    `GAP: CRITICAL — the retry criterion is missing — proposed resolution: ${RETRY_STATEMENT} — resolution-type: concrete\nVERDICT: NEEDS_ITERATION`,
    `GAP: CRITICAL — the bullet "(gate resolution) ${RETRY_STATEMENT}" is vague — proposed resolution: restate it — resolution-type: concrete\nVERDICT: READY`,
  ];
  setPlanDispatch(makeDispatchStub(replies) as never);
  const r = await runPlanPipeline(
    {} as never,
    { descriptor: DESCRIPTOR, dryRun: true },
    process.cwd(),
  );
  assert(
    r.spec.includes("## Residual gap-gate findings") && r.spec.includes("is vague"),
    "#1111 READY: a re-routed CRITICAL on a READY verdict is disclosed in the residual section",
  );
  setPlanDispatch(null);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
