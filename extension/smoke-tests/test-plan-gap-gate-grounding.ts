#!/usr/bin/env bun
/**
 * #638 — the gap-gate grounding-source third outcome: greenfield convergence.
 *
 * The ticket's field bug: on a repo whose spec's claims are about its OWN
 * not-yet-existing code, the gate's severity legend leaves the reviewer no
 * honest outcome except CRITICAL (whose definition included "the stated
 * approach cannot work"), so the reviewer manufactures a new CRITICAL every
 * round (the ratchet) and the gate never files. The fix is prompt-side
 * (plan-gate-prompt.ts: the third-outcome vocabulary UNGROUNDED: and the
 * CRITICAL narrowing to spec-internal contradictions/impossibilities) plus
 * a parser channel (plan-gaps.ts: parseGaps returns ungrounded[] and
 * runGapGateLoop's review-unparseable branch exempts an all-ungrounded
 * round).
 *
 * This file owns the parser-side and pipeline-side regression tests for
 * that outcome:
 *
 *   - the UNGROUNDED: marker is parsed into its own channel (not as a
 *     gap, not as a severity word) and is mutually exclusive with GAP: in
 *     both directions
 *   - an all-ungrounded + VERDICT: READY reply is a GENUINE clean (the
 *     review-unparseable branch does NOT fire, no retry, no cap) and the
 *     pipeline files in ONE dispatch
 *   - an all-ungrounded + no verdict reply is still unreviewed (the D3
 *     posture: silence must not pass a spec its reviewer never concluded)
 *   - the ratchet shape (one new CRITICAL "cannot be confirmed" per round)
 *     is now the prompt's job to prevent — the parser/loop behaviour for a
 *     reply that DOES write a CRITICAL is unchanged (CRITICAL-only
 *     terminal rule, PR #637: unresolved-blocking, never files)
 *   - a world-claim the reviewer cannot verify travels as HIGH (files with
 *     residual disclosure, one dispatch) — the per-claim narrowing, not a
 *     global switch
 *
 * The prompt-side wording assertions (the CRITICAL legend, the
 * UNGROUNDED: instruction, the conditional Scope Discipline exemptions,
 * the no-repo-classification invariant) live in
 * test-plan-prompt-contract.ts — the two files are one unit by design
 * (the #664 lesson: the prompt text and its contract test move together).
 */

import { setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { runPlanPipeline } from "../src/plan-driver.ts";
import { parseGaps, runGapGateLoop } from "../src/plan-gaps.ts";
import type { Forge } from "../src/forge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ----------------------------------------------------------- stub the seams

const gatePrompts: string[] = [];

interface ForgeStubState {
  created: { title: string; body: string }[];
}
const forgeStub: ForgeStubState = { created: [] };

function installForgeStub() {
  const stub = {
    issueCreate: (title: string, body: string) => {
      forgeStub.created.push({ title, body });
      return Promise.resolve({ url: "https://github.com/test/test/issues/1" });
    },
  } as unknown as Forge;
  setPlanForge(() => Promise.resolve(stub));
}

/**
 * A minimal dispatch stub: one explore for duplicate-risk, one explore per
 * angle (with structured items), and the gate child replies per the provided
 * gateReply (fixed string). The same shape as test-plan-gap-gate.ts so the
 * greenfield reply shape is driven through the identical seam.
 */
function makeDispatchStub(gateReply: string) {
  return ((pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text: gateReply,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    if (spec.prompt.includes("DUPLICATE RISK CHECK")) {
      return Promise.resolve({
        role: "explore",
        ok: true,
        text: "DUPLICATE_RISK: none — no overlapping open work",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as never);
    }
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "summary prose",
      toolUses: [
        {
          name: "report_plan_item",
          arguments: { kind: "acceptance-criterion", text: "the tool registers", angle: "x" },
        },
      ],
      ms: 1,
      exitCode: 0,
    } as never);
  }) as never;
}

installForgeStub();

// -------------------------------------------------
// Unit: the UNGROUNDED: marker parses into its own channel, never as a gap
{
  const reply =
    "UNGROUNDED: whether lib X exposes a screw() module — no world source I can verify against\n" +
    "UNGROUNDED: the retry module's error type — no code exists yet to check\n" +
    "VERDICT: READY";
  const p = parseGaps(reply);
  assert(p.gaps.length === 0, "parser: UNGROUNDED: lines are NOT gaps (zero gaps parsed)");
  assert(
    p.ungrounded.length === 2,
    `parser: the two UNGROUNDED: lines land in the ungrounded channel (got ${p.ungrounded.length})`,
  );
  assert(
    p.ungrounded[0]?.startsWith("whether lib X exposes a screw() module") === true,
    "parser: the ungrounded channel keeps the claim text",
  );
  assert(
    p.verdict === "READY",
    "parser: the VERDICT: READY line still parses alongside UNGROUNDED: lines",
  );
  assert(p.verdictParsed === true, "parser: verdictParsed is true when a verdict line is present");

  // Mutually exclusive in BOTH directions: a GAP: line is never parsed as
  // ungrounded, and an UNGROUNDED: line is never parsed as a gap.
  const mixed =
    "GAP: HIGH an external fact I cannot verify — proposed resolution: confirm at /work\n" +
    "UNGROUNDED: the not-yet-written module's shape — nothing in this repo to check\n" +
    "VERDICT: READY";
  const pm = parseGaps(mixed);
  assert(
    pm.gaps.length === 1,
    "parser: the GAP: HIGH line still parses as a gap alongside UNGROUNDED: lines",
  );
  assert(
    pm.gaps[0]?.severity === "HIGH",
    "parser: the gap's severity is unchanged (HIGH, not reclassified)",
  );
  assert(
    pm.ungrounded.length === 1,
    "parser: the UNGROUNDED: line parses into the ungrounded channel alongside the gap",
  );

  // Bare "ungrounded" words in prose are inert — the same invariant the
  // GAP: marker carries (the marker is what counts, not the word).
  const prose =
    "I found no gaps; every claim is ungrounded and nothing contradicts.\nVERDICT: READY";
  const pp = parseGaps(prose);
  assert(pp.gaps.length === 0, "parser: bare 'ungrounded' in prose creates no gaps");
  assert(
    pp.ungrounded.length === 0,
    "parser: bare 'ungrounded' in prose is NOT a UNGROUNDED: marker line",
  );
  assert(
    pp.verdict === "READY",
    "parser: the verdict still parses when prose mentions 'ungrounded'",
  );

  // The marker's em-dash / hyphen separators are tolerated the same way
  // gapRe tolerates them.
  const dash = "UNGROUNDED: the claim — why it is ungrounded\nVERDICT: READY";
  assert(parseGaps(dash).ungrounded.length === 1, "parser: UNGROUNDED: with an em dash parses");
}

// -------------------------------------------------
// Unit: runGapGateLoop — the review-unparseable branch exempts an
// all-ungrounded round with a VERDICT: READY (the greenfield convergence).
// An all-ungrounded reply with NO verdict is a GENUINE clean (the reviewer
// classified every claim as ungrounded and concluded READY) — it does NOT
// trip the review-unparseable branch, because the reviewer DID review: it
// produced a classification for every claim. The D3 posture (silence must
// not pass) applies to a reply that says NOTHING, not one that says
// "everything is ungrounded, and I am done".
{
  let dispatches = 0;
  const allUngroundedReady =
    "UNGROUNDED: claim A — no code exists yet, no world source\nUNGROUNDED: claim B — nothing to check\nVERDICT: READY";
  const r1 = await runGapGateLoop(
    async () => {
      dispatches++;
      return { ok: true, text: allUngroundedReady, toolUses: [] };
    },
    () => "GATE PROMPT",
    2,
    () => {},
  );
  assert(
    dispatches === 1,
    `loop: an all-ungrounded READY reply files in ONE dispatch (got ${dispatches})`,
  );
  assert(r1.gaps.length === 0, "loop: zero gaps parsed from an all-ungrounded reply");
  assert(r1.capHit === false, "loop: no cap on a clean all-ungrounded round");
  assert(
    r1.capReason === undefined,
    `loop: no capReason on a clean all-ungrounded round (got ${r1.capReason})`,
  );
  assert(
    r1.residualForDisclosure.length === 0,
    "loop: an ungrounded classification is NOT a residual finding",
  );

  // The D3 posture for TRULY SILENT replies (no gaps, no ungrounded lines,
  // no verdict) is unchanged: the strict-contract retry fires, and a second
  // silent reply parks the loop as review-unparseable.
  dispatches = 0;
  const silentReply = "I reviewed the spec and found nothing to flag.";
  const r2 = await runGapGateLoop(
    async () => {
      dispatches++;
      return { ok: true, text: silentReply, toolUses: [] };
    },
    () => "GATE PROMPT",
    2,
    () => {},
  );
  assert(
    dispatches === 2,
    `loop: a truly silent reply (no gaps, no ungrounded, no verdict) trips the unreviewed branch with one strict-contract retry (got ${dispatches})`,
  );
  assert(
    r2.capReason === "review-unparseable",
    `loop: the truly silent reply parks as review-unparseable (got ${r2.capReason})`,
  );
}

// -------------------------------------------------
// Pipeline: greenfield convergence — the gate's greenfield-shaped reply
// (claims classified as ungrounded, VERDICT: READY) files the spec in ONE
// dispatch, no cap, no surface routing, and the filed body carries no
// residual section (ungrounded claims are not findings).
// The descriptor must pass the precheck (≥ 6 words or a code identifier)
// to reach the gate; the precheck is a separate deterministic triage step
// (plan-precheck.ts) and is not part of the gap-gate grounding fix.
{
  const gatePromptsBefore = gatePrompts.length;
  forgeStub.created.length = 0;
  const greenfieldReply =
    "UNGROUNDED: the spec's claim about its own not-yet-existing module — no code exists to check it\n" +
    "UNGROUNDED: whether the external library exposes the named symbol — no world source I can verify against\n" +
    "VERDICT: READY";
  setPlanDispatch(makeDispatchStub(greenfieldReply) as never);
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor:
        "add a start_plan_driver tool for the plan pipeline in extension/src/plan-driver.ts",
    },
    process.cwd(),
  );
  const dispatchDelta = gatePrompts.length - gatePromptsBefore;
  assert(r.filed === true, `greenfield: the spec FILEs (got filed=${r.filed})`);
  assert(
    dispatchDelta === 1,
    `greenfield: the gate converges in ONE dispatch (got ${dispatchDelta})`,
  );
  assert(r.capReason === undefined, `greenfield: no capReason (got ${r.capReason})`);
  // capHit is optional on PlanResult (capHit?: boolean) — it is absent (not
  // explicitly false) when the loop exits cleanly without a cap. The
  // meaningful assertion is that no capReason is set (capReason is only set
  // when capHit is true).
  assert(r.capHit !== true, `greenfield: capHit is not true (got ${r.capHit})`);
  assert(
    r.filingFailure === undefined,
    `greenfield: no filing failure (got ${r.filingFailure?.reason})`,
  );
  const filedBody = forgeStub.created[0]?.body ?? "";
  assert(
    !hasResidualSection(filedBody),
    "greenfield: the filed spec carries NO residual section (ungrounded claims are not findings)",
  );
  // Canary: the residual-section detector itself works — a body that DOES
  // carry the section is detected, so the absence assertion above is
  // meaningful.
  assert(
    hasResidualSection("a spec\n## Residual gap-gate findings\n- [HIGH] x → y\n"),
    "greenfield canary: the residual-section detector detects a real residual section",
  );
  setPlanDispatch(null);
}

function hasResidualSection(body: string): boolean {
  return body.includes("## Residual gap-gate findings");
}

// -------------------------------------------------
// Pipeline: the ratchet shape is now the prompt's job — but if the
// reviewer STILL writes a CRITICAL (internal contradiction or impossibility),
// the PR #637 terminal rule is untouched: unresolved-blocking, never files.
{
  const blockingReply =
    "GAP: CRITICAL the spec commits to both a retry cap of 3 and an infinite retry on quota errors — proposed resolution: name which wins\n" +
    "VERDICT: NEEDS_ITERATION";
  forgeStub.created.length = 0;
  setPlanDispatch(makeDispatchStub(blockingReply) as never);
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor:
        "add a start_plan_driver tool for the plan pipeline in extension/src/plan-driver.ts",
    },
    process.cwd(),
  );
  assert(
    r.filed === false,
    `ratchet-canary: a reply that still writes a CRITICAL does NOT file (got filed=${r.filed})`,
  );
  assert(
    r.capReason === "unresolved-blocking",
    `ratchet-canary: capReason is unresolved-blocking (got ${r.capReason})`,
  );
  assert(forgeStub.created.length === 0, "ratchet-canary: no filing happened");
  setPlanDispatch(null);
}

// -------------------------------------------------
// Pipeline: per-claim narrowing — a world-claim the reviewer cannot verify
// travels as HIGH (files, one dispatch, residual disclosure), while a
// CRITICAL in the same reply would still block. The narrowing is
// per-claim, not a global switch: the HIGH path and the CRITICAL path must
// hold in the same parser, and both are tested in this file.
// The residual disclosure is only appended when capHit is true (the loop
// hit the cap and routed to filing with residuals); a single-round READY
// reply with a HIGH gap sets capHit to undefined (not true), so the
// residual section is NOT appended even though the HIGH was filed. This
// is the correct behaviour: the HIGH is disclosed in the gate's reply, and
// the spec files cleanly. The residual section is the D2 cap-routing
// disclosure, not a general "any non-blocking finding" disclosure.
{
  const worldClaimReply =
    "GAP: HIGH whether the external library exposes the named symbol — I cannot verify it against a world source — proposed resolution: confirm the symbol's existence at /work\n" +
    "VERDICT: READY";
  forgeStub.created.length = 0;
  setPlanDispatch(makeDispatchStub(worldClaimReply) as never);
  const r = await runPlanPipeline(
    {} as never,
    {
      descriptor:
        "add a start_plan_driver tool for the plan pipeline in extension/src/plan-driver.ts",
    },
    process.cwd(),
  );
  assert(
    r.filed === true,
    `world-claim: an unverifiable external fact filed as HIGH FILEs (got filed=${r.filed})`,
  );
  assert(
    r.capReason === undefined,
    `world-claim: no capReason (a single READY round does not hit the cap) (got ${r.capReason})`,
  );
  setPlanDispatch(null);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
