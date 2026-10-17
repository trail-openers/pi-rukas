#!/usr/bin/env bun
/**
 * #639 DEFECT 2 — Decision-A writeback pipeline tests.
 *
 * Decision A makes the gap-gate writeback real and three-branch:
 *   1. body-applicable resolution (no section named, or the default AC
 *      section) → appended as a NEW bullet there (with the provenance
 *      marker), Open Questions renders `status: resolved` (owner PM).
 *   2. a resolution naming a DIFFERENT section → the bullet goes there.
 *   3. placeholder, unrenderable section, or an EDIT-IMPERATIVE resolution
 *      (delete/remove/replace/reword/rewrite/instead — vipune rounds 8+9)
 *      → `status: open`, `decision owner: operator`, body NOT modified.
 *
 * #1111 tightens branch 1 and 2: only a CONCRETE resolution (the reviewer's
 * `resolution-type: concrete`) may be spliced. Instruction-form, research and
 * operator-decision (either/or) resolutions, and a missing or unparseable
 * type, stay in Open Questions with `status: open`. A spliced concrete
 * statement carries no (a)/(b)/(c) label.
 *
 * The round-2 gate prompt must be built from the RE-DRAFTED body (the
 * makeGatePrompt thunk closes over the reassigned `body` in onCorrective).
 * Single-round corrective shape only (GAP_GATE_MAX_ITERATIONS = 2). Seam
 * wiring lives in the shared plan-test-stubs.ts.
 *
 * The ERROR_HANDLING block below reads source text, so it names the file the
 * code lives in. The corrective re-draft was extracted from plan-driver.ts to
 * plan-driver-redraft.ts (#1044's §12 split) — the widened try/catch and its
 * disclosure call are asserted there, and the disclosure text itself in
 * plan-driver-halt.ts.
 */
import { draftSpec } from "../src/plan-draft.ts";
import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gap-parse.ts";
import {
  appendBulletsToSection,
  applyWritebackToBody,
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

function sectionOf(body: string, heading: string, nextHeading: string): string {
  const start = body.indexOf(`## ${heading}`);
  const end = body.indexOf(`## ${nextHeading}`, start);
  return body.slice(start, end === -1 ? body.length : end);
}

const RETRY_STATEMENT =
  "in the Acceptance criteria section, the retry path stops after three attempts";

// ------------------------------ branch 2: resolution names a different section

{
  // A CRITICAL whose resolution explicitly names the Edge cases section →
  // the bullet is written back THERE, not to Acceptance criteria.
  const replies = [
    "GAP: CRITICAL the boundary condition is unnamed — proposed resolution: document the boundary in the Edge cases section — resolution-type: concrete\nVERDICT: NEEDS_ITERATION",
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
  const edge = sectionOf(body, "Edge cases & pitfalls", "Open Questions");
  const ac = sectionOf(body, "Acceptance criteria", "References");
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    edge.includes("- (gate resolution) document the boundary in the Edge cases section"),
    "branch 2: the named-section resolution is written to that section (Edge cases, marked)",
  );
  assert(
    !ac.includes("- (gate resolution) document the boundary in the Edge cases section"),
    "branch 2: the named-section resolution is NOT also written to Acceptance criteria",
  );
  assert(
    /status: resolved/.test(oq) && !/status: open/.test(oq),
    "branch 2: the written-back (named section) decision renders status: resolved, not open",
  );

  setPlanDispatch(null);
}

// ------------------------------ branch 3: placeholder → open, body unmodified

{
  // A CRITICAL whose resolution is the parseGaps placeholder (no
  // "proposed resolution:" segment on the GAP: line) → NOT written back:
  // the bullet renders status: open with decision owner operator, and the
  // body sections are NOT modified (no resolution text injected anywhere).
  const replies = [
    "GAP: CRITICAL the boundary condition is unnamed\nVERDICT: NEEDS_ITERATION",
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
    !ac.includes(GAP_RESOLUTION_PLACEHOLDER),
    "branch 3: the placeholder resolution is NOT written back to Acceptance criteria",
  );
  assert(
    /status: open/.test(oq),
    "branch 3: the unwritten (placeholder) decision renders status: open",
  );
  assert(
    /decision owner: operator/.test(oq),
    "branch 3: the unwritten decision names the operator as decision owner",
  );
  // The bullet still shows the resolution so the operator can see it
  // (residual finding 2).
  assert(
    oq.includes(GAP_RESOLUTION_PLACEHOLDER),
    "branch 3: the bullet names the placeholder resolution so the operator can see it was not applied",
  );
  assert(
    !/status: resolved/.test(oq),
    "branch 3: no status: rendered resolved for an unwritten decision",
  );

  setPlanDispatch(null);
}

// ------------------------- branch 3b: real resolution naming no section

{
  // A real, non-placeholder resolution that names NO renderable section →
  // also falls to branch 3 (open, decision owner operator, body unmodified).
  // The resolution text must still be visible in the bullet.
  const replies = [
    "GAP: CRITICAL the approach cannot work — proposed resolution: revisit the architecture before building — resolution-type: concrete\nVERDICT: NEEDS_ITERATION",
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
    !ac.includes("- revisit the architecture before building"),
    "branch 3b: a no-section real resolution is NOT written back (no fabricated destination)",
  );
  assert(
    /status: open/.test(oq) && /decision owner: operator/.test(oq),
    "branch 3b: a no-section real resolution renders status: open, decision owner operator",
  );
  assert(
    oq.includes("revisit the architecture before building"),
    "branch 3b: the bullet names the (unapplied) resolution so the operator can see it",
  );

  setPlanDispatch(null);
}

// ------------------------------ spike: default destination is Expected deliverable

{
  // Residual finding 3: for type spike the default writeback destination is
  // the "Expected deliverable" section (the spike analogue of Acceptance
  // criteria — spikes render no "Acceptance criteria" heading).
  //
  // Spikes no longer dispatch the gap gate at all (deterministic validation
  // is their gate — the chore/spike no-gate policy), so the corrective round
  // cannot be driven through the pipeline for a spike. The invariant being
  // pinned is the writeback DESTINATION, which lives in plan-writeback.ts +
  // draftSpec — drive those directly with a CRITICAL gap shaped like the
  // old gate reply.
  const { decisions, writebackMap } = buildResolvedDecisions(
    [
      {
        severity: "CRITICAL",
        description: "the deliverable is undefined",
        resolution: "name the decision the spike must reach in the Expected deliverable section",
        resolutionType: "concrete",
      },
    ],
    "spike",
  );
  const redraft = draftSpec(
    "spike",
    "investigate the feasibility of a new sandbox approach",
    [
      {
        name: "scoping",
        ok: true,
        text: "scoped the spike",
        toolUses: [
          { kind: "acceptance-criterion", text: "a decision by Friday", angle: "scoping" },
        ],
      },
    ],
    [],
    [],
    [],
    0,
    { acceptanceCriteria: [], pitfalls: [], outOfScope: [] },
    decisions,
    writebackMap,
  );

  const body = redraft.body;
  const edge = sectionOf(body, "Expected deliverable", "References");
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    edge.includes(
      "- (gate resolution) name the decision the spike must reach in the Expected deliverable section",
    ),
    "spike branch: the writeback goes to the Expected deliverable section (not the absent Acceptance criteria)",
  );
  assert(
    !body.includes("## Acceptance criteria"),
    "spike branch: the spike body has no Acceptance criteria heading (the writeback cannot go there)",
  );
  assert(
    /status: resolved/.test(oq),
    "spike branch: the written-back (spike) decision renders status: resolved",
  );
}

// ------------------- unit: the shared splice helper (single implementation)

{
  // The two splice paths (inline writeback + re-draft re-apply) were
  // collapsed into ONE shared helper (plan-writeback.ts:
  // appendBulletsToSection). These unit cases pin the parenthetical
  // heading behaviour directly (lens finding: the old second implementation
  // had a lookahead-less heading regex — the spike's "Expected deliverable
  // (NOT code — …)" line was matched differently by the two paths, and no
  // test called the re-apply path in isolation). The prefix-match with the
  // parenthetical lookahead is what the shared helper must keep.
  const body =
    "## Expected deliverable (NOT code — a decision or proof of concept)\n\n- the decision to make\n\n## References\n\n- (none)\n";
  const out = appendBulletsToSection(body, "Expected deliverable", [
    "the new deliverable criterion",
  ]);
  assert(
    out !== null,
    "shared helper: a parenthetical heading matches by prefix (the lookahead keeps the trailing text)",
  );
  assert(
    out?.includes("- the decision to make\n- the new deliverable criterion\n\n## References") ??
      false,
    "shared helper: the new bullet is appended AFTER the last bullet, and the next heading keeps its blank line",
  );
  // applyWritebackToBody delegates to the same helper (one splice
  // implementation, one heading regex — a divergent re-implementation is
  // gone): the map-driven path reaches the same parenthetical heading.
  // (Six-lens re-review, PR #640: buildWritebackMap is deleted — the map is
  // built by buildResolvedDecisions in plan-writeback.ts; this unit test
  // constructs the map directly to pin the splice behaviour in isolation.)
  const map = new Map<string, string[]>([["Expected deliverable", ["the re-applied criterion"]]]);
  const { body: out2, outcomes } = applyWritebackToBody(body, map);
  assert(
    out2.includes("- the decision to make\n- the re-applied criterion"),
    "shared helper: applyWritebackToBody (the re-draft re-apply path) hits the parenthetical heading via the shared splice",
  );
  assert(
    outcomes.length === 1 &&
      outcomes[0]?.applied === true &&
      outcomes[0]?.heading === "Expected deliverable",
    "shared helper: the SpliceOutcome list reports the applied bullet (the flag is produced by the write)",
  );
  // A heading that did not survive rendering is reported as not applied (the
  // decision record then renders status open — the loss is visible, never a
  // predicted status: resolved). The lower-level appendBulletsToSection
  // returns null for the same case; applyWritebackToBody converts that to a
  // SpliceOutcome with applied: false.
  const missing = applyWritebackToBody(body, new Map([["Acceptance criteria", ["x"]]]));
  assert(
    missing.outcomes.length === 1 && missing.outcomes[0]?.applied === false,
    "shared helper: an absent heading is reported as not applied (SpliceOutcome.applied = false)",
  );
  const missingRaw = appendBulletsToSection(body, "Acceptance criteria", ["x"]);
  assert(
    missingRaw === null,
    "shared helper: appendBulletsToSection returns null for an absent heading (no fabricated section)",
  );
}

// ------- ERROR_HANDLING (six-lens re-review, PR #640): re-draft throw disclosure

{
  // The re-draft guard was widened (LOW ERROR_HANDLING finding) to cover the
  // destination-resolution call AND the re-draft. The thrown message must
  // name the decisions so the operator sees what was computed before the
  // throw. The original stack is preserved via the Error cause option.
  //
  // With valid inputs, draftSpec is effectively unthrowable (all its
  // helpers are defensive: appendBulletsToSection returns null for missing
  // headings, template literals don't throw on string interpolation). The
  // widened guard is a DEFENSIVE measure for the case where a future
  // refactoring makes draftSpec or buildResolvedDecisions throw. The test
  // verifies: (1) the catch block exists and is WIDE (covers
  // buildResolvedDecisions + draftSpec), (2) the catch uses the Error
  // cause option (original stack preserved), (3) the thrown message names
  // the carried gap decisions (disclosure), and (4) the corrective round
  // fires and the pipeline completes normally (the disclosure only fires
  // on throw, which doesn't happen with valid inputs).
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  // The re-draft lives in plan-driver-redraft.ts since the #1044 §12 split
  // (plan-driver.ts now injects it into plan-driver-gate.ts as the
  // correctiveRedraft callback the gate loop calls). The guard's shape is
  // asserted where the try/catch is, not where the callback is threaded.
  const src = readFileSync(
    resolve(import.meta.dirname, "..", "src", "plan-driver-redraft.ts"),
    "utf8",
  );
  const buildIdx = src.indexOf("= buildResolvedDecisions(");
  assert(
    buildIdx > 0,
    "ERROR_HANDLING: buildResolvedDecisions is called inside the gate's corrective re-draft",
  );
  const tryStart = src.lastIndexOf("try {", buildIdx);
  assert(
    tryStart > 0 && tryStart < buildIdx,
    "ERROR_HANDLING: the try block starts before buildResolvedDecisions (widened guard covers the destination-resolution call)",
  );
  const catchIdx = src.indexOf("catch (e) {", buildIdx);
  assert(catchIdx > 0, "ERROR_HANDLING: the catch block exists");
  const catchBlock = src.slice(catchIdx, catchIdx + 2000);
  // The disclosure builder was extracted to plan-driver-halt.ts (body-budget
  // PR, 500-line seam); the driver's catch delegates to it, and the cause +
  // disclosure pins follow the extraction.
  assert(
    catchBlock.includes("throw correctiveRedraftError("),
    "ERROR_HANDLING: the catch throws via the extracted disclosure builder",
  );
  const haltSrc = readFileSync(
    resolve(import.meta.dirname, "..", "src", "plan-driver-halt.ts"),
    "utf8",
  );
  assert(
    haltSrc.includes("{ cause: err }"),
    "ERROR_HANDLING: the catch uses the Error cause option (original stack preserved)",
  );
  assert(
    haltSrc.includes("carried gap decision(s)"),
    "ERROR_HANDLING: the thrown message names the carried gap decisions (disclosure)",
  );
  // Integration: the corrective round fires and the pipeline completes.
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
  assert(r.filed === false, "ERROR_HANDLING: dryRun does not file");
  assert(
    gatePrompts.length === 2,
    `ERROR_HANDLING: two gate dispatches (got ${gatePrompts.length})`,
  );
  setPlanDispatch(null);
}

// ---------------- round-8/9 defects: splice boundary + edit-verb guard

{
  // Round 8: two sequential splices glued "## References" onto the second
  // bullet while reporting applied:true. Boundary is now normalized.
  const body = "## Acceptance criteria\n\n- existing criterion\n\n## References\n\n- (none)\n";
  const twice = applyWritebackToBody(
    body,
    new Map([["Acceptance criteria", ["first appended", "second appended"]]]),
  );
  assert(
    twice.body.includes("- first appended\n- second appended\n\n## References"),
    "splice boundary: two sequential splices keep the next heading intact with its blank line",
  );
  assert(
    twice.outcomes.length === 2 && twice.outcomes.every((o) => o.applied),
    "splice boundary: both splices report applied:true",
  );

  // Rounds 8+9: edit-imperative resolutions ("delete X … instead state Y")
  // are edit instructions, not criteria → Decision-A branch 1, no splice.
  const { decisions, writebackMap } = buildResolvedDecisions(
    [
      {
        severity: "CRITICAL",
        description: "AC4 contradicts the context",
        resolution:
          'delete "reproduce bit-for-bit" from the Acceptance criteria and instead state that rankings shift',
        resolutionType: "concrete",
      },
    ],
    "feature",
  );
  assert(
    writebackMap.size === 0 && decisions[0]?.writebackHeading === undefined,
    "edit-verb guard: an edit-imperative resolution never splices (no destination)",
  );
  const oqRender = renderOpenQuestions([], markWrittenDecisions(decisions, []));
  assert(
    /status: open/.test(oqRender) && /decision owner: operator/.test(oqRender),
    "edit-verb guard: the decision renders status: open, decision owner operator (fail closed to human review)",
  );
  // A plain declarative resolution naming a section still splices.
  const plain = buildResolvedDecisions(
    [
      {
        severity: "CRITICAL",
        description: "missing retry criterion",
        resolution: RETRY_STATEMENT,
        resolutionType: "concrete",
      },
    ],
    "feature",
  );
  assert(
    plain.writebackMap.size === 1,
    "edit-verb guard: plain declarative resolutions still splice (the guard is verb-scoped)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
