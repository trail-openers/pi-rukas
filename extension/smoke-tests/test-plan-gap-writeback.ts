#!/usr/bin/env bun
/**
 * #639 DEFECT 2 — Decision-A writeback pipeline tests.
 *
 * The old onCorrective closure dropped the gap's status, string-prefixed the
 * resolution into openQuestions, and re-drafted; draftSpec then RE-DETERMINED
 * "resolved" via a string-prefix regex — a contradiction (the body still
 * contained the original text while the bullet claimed resolved). Decision A
 * makes the writeback real and three-branch:
 *
 *   1. body-applicable resolution (names no section, or the default
 *      Acceptance criteria) → the resolution text is appended as a NEW
 *      bullet to that section (outside Open Questions), and the Open
 *      Questions bullet renders `status: resolved` (decision owner PM).
 *   2. a resolution that explicitly names a DIFFERENT section → the bullet
 *      goes to that section.
 *   3. the parseGaps placeholder (or a resolution naming no renderable
 *      section) → the bullet renders `status: open` with
 *      `decision owner: operator`, and the body is NOT modified.
 *
 * The round-2 gate prompt must be built from the RE-DRAFTED body (the
 * reviewer sees the applied resolution) — the makeGatePrompt thunk closes
 * over the reassigned `body` binding in onCorrective; a refactor that moved
 * the re-draft into a local variable would silently break this AC.
 *
 * The single-round corrective shape only (GAP_GATE_MAX_ITERATIONS stays 2 —
 * the two-consecutive-corrective shape is unreachable and explicitly not a
 * required case, per the out-of-scope note).
 *
 * The seam wiring (makeDispatchStub / installForgeStub / gatePrompts /
 * forgeStub) lives in the shared plan-test-stubs.ts — the single copy both
 * gap-gate test files import (it used to be copied verbatim here from
 * test-plan-gap-gate-rounds.ts; a dispatch/forge shape change now updates
 * one place).
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "../src/plan-gaps.ts";
import { applyWritebackToBody, appendBulletsToSection } from "../src/plan-writeback.ts";
import {
  forgeStub,
  gatePrompts,
  installForgeStub,
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

// ----------------------------------------------------------- stub the seams
// (see plan-test-stubs.ts for the shared stub harness)

installForgeStub();

const DESCRIPTOR = "add a start_plan_driver tool for the plan pipeline in extension";

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
  const replies = [
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion for the retry path to the Acceptance criteria section\nVERDICT: NEEDS_ITERATION",
    "GAP: MEDIUM minor clarification — proposed resolution: add a note\nVERDICT: READY",
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
    ac.includes("- add a criterion for the retry path to the Acceptance criteria section"),
    "branch 1: the resolution text is a NEW bullet in the Acceptance criteria section",
  );
  assert(
    !oq.includes("- add a criterion for the retry path to the Acceptance criteria section"),
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
  assert(
    !/status: open/.test(oq),
    "branch 1: no status: open bullet for a written-back decision",
  );
  // The round-2 gate prompt is built from the re-drafted body: the reviewer
  // sees the applied resolution (not just the round-1 body).
  const r2 = gatePrompts[1] ?? "";
  assert(
    r2.includes("add a criterion for the retry path to the Acceptance criteria section"),
    "branch 1: round-2 gate prompt contains the written-back resolution (built from the re-drafted body)",
  );
  assert(
    r2.includes("status: resolved"),
    "branch 1: round-2 gate prompt renders the carried gap as status: resolved",
  );

  setPlanDispatch(null);
}

// ------------------------------ branch 2: resolution names a different section

{
  // A CRITICAL whose resolution explicitly names the Edge cases section →
  // the bullet is written back THERE, not to Acceptance criteria.
  const replies = [
    "GAP: CRITICAL the boundary condition is unnamed — proposed resolution: document the boundary in the Edge cases section\nVERDICT: NEEDS_ITERATION",
    "GAP: LOW cosmetic nit — proposed resolution: retitle\nVERDICT: READY",
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
    edge.includes("- document the boundary in the Edge cases section"),
    "branch 2: the named-section resolution is written to that section (Edge cases)",
  );
  assert(
    !ac.includes("- document the boundary in the Edge cases section"),
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
    "GAP: LOW cosmetic nit — proposed resolution: retitle\nVERDICT: READY",
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
    "GAP: CRITICAL the approach cannot work — proposed resolution: revisit the architecture before building\nVERDICT: NEEDS_ITERATION",
    "GAP: LOW cosmetic nit — proposed resolution: retitle\nVERDICT: READY",
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
  const replies = [
    "GAP: CRITICAL the deliverable is undefined — proposed resolution: name the decision the spike must reach in the Expected deliverable section\nVERDICT: NEEDS_ITERATION",
    "GAP: LOW cosmetic nit — proposed resolution: retitle\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(replies) as never);

  const r = await runPlanPipeline(
    {} as never,
    { descriptor: "investigate the feasibility of a new sandbox approach", dryRun: true },
    process.cwd(),
  );

  const body = r.spec;
  assert(r.type === "spike", `spike: classified as spike (got ${r.type})`);
  const edge = sectionOf(body, "Expected deliverable", "References");
  const oq = sectionOf(body, "Open Questions", "Out of scope");
  assert(
    edge.includes("- name the decision the spike must reach in the Expected deliverable section"),
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

  setPlanDispatch(null);
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
  const body = "## Expected deliverable (NOT code — a decision or proof of concept)\n\n- the decision to make\n\n## References\n\n- (none)\n";
  const out = appendBulletsToSection(body, "Expected deliverable", ["the new deliverable criterion"]);
  assert(out !== null, "shared helper: a parenthetical heading matches by prefix (the lookahead keeps the trailing text)");
  assert(
    out?.includes("- the decision to make\n- the new deliverable criterion\n## References") ?? false,
    "shared helper: the new bullet is appended AFTER the section's last existing bullet (before the next heading)",
  );
  // applyWritebackToBody delegates to the same helper (one splice
  // implementation, one heading regex — a divergent re-implementation is
  // gone): the map-driven path reaches the same parenthetical heading.
  // (Six-lens re-review, PR #640: buildWritebackMap is deleted — the map is
  // built by buildResolvedDecisions in plan-writeback.ts; this unit test
  // constructs the map directly to pin the splice behaviour in isolation.)
  const map = new Map<string, string[]>([
    ["Expected deliverable", ["the re-applied criterion"]],
  ]);
  const { body: out2, outcomes } = applyWritebackToBody(body, map);
  assert(
    out2.includes("- the decision to make\n- the re-applied criterion"),
    "shared helper: applyWritebackToBody (the re-draft re-apply path) hits the parenthetical heading via the shared splice",
  );
  assert(
    outcomes.length === 1 && outcomes[0]?.applied === true && outcomes[0]?.heading === "Expected deliverable",
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
  assert(missingRaw === null, "shared helper: appendBulletsToSection returns null for an absent heading (no fabricated section)");
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
  const src = readFileSync(resolve(import.meta.dirname, "..", "src", "plan-driver.ts"), "utf8");
  const buildIdx = src.indexOf("= buildResolvedDecisions(");
  assert(buildIdx > 0, "ERROR_HANDLING: buildResolvedDecisions is called in onCorrective");
  const tryStart = src.lastIndexOf("try {", buildIdx);
  assert(
    tryStart > 0 && tryStart < buildIdx,
    "ERROR_HANDLING: the try block starts before buildResolvedDecisions (widened guard covers the destination-resolution call)",
  );
  const catchIdx = src.indexOf("catch (e) {", buildIdx);
  assert(catchIdx > 0, "ERROR_HANDLING: the catch block exists");
  const catchBlock = src.slice(catchIdx, catchIdx + 2000);
  assert(
    catchBlock.includes("{ cause: err }"),
    "ERROR_HANDLING: the catch uses the Error cause option (original stack preserved)",
  );
  assert(
    catchBlock.includes("carried gap decision(s)"),
    "ERROR_HANDLING: the thrown message names the carried gap decisions (disclosure)",
  );
  // Integration: the corrective round fires and the pipeline completes.
  const replies = [
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion for the retry path to the Acceptance criteria section\nVERDICT: NEEDS_ITERATION",
    "GAP: MEDIUM minor clarification — proposed resolution: add a note\nVERDICT: READY",
  ];
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  gatePrompts.length = 0;
  setPlanDispatch(makeDispatchStub(replies) as never);
  const r = await runPlanPipeline({} as never, { descriptor: DESCRIPTOR, dryRun: true }, process.cwd());
  assert(r.filed === false, "ERROR_HANDLING: dryRun does not file");
  assert(gatePrompts.length === 2, `ERROR_HANDLING: two gate dispatches (got ${gatePrompts.length})`);
  setPlanDispatch(null);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
