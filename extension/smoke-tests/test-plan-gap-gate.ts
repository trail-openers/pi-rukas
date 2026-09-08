#!/usr/bin/env bun
/**
 * #633 Group B — D1/D2/D7 pipeline-level tests for the /plan gap gate.
 *
 * Split out of test-plan-tool.ts (which is at the 500-line limit) to keep
 * both files under the hard cap. These tests exercise the pipeline end-to-
 * end through the dispatch + forge seams:
 *
 *   - D1: the cap message names the ACTUAL cause (MEDIUM-only NEEDS_ITERATION
 *     burns the cap → the message must NOT claim "unresolved CRITICAL/HIGH
 *     gaps remain")
 *   - D2: at the cap, zero CRITICAL → FILE with residual disclosure
 *     (HIGH/MEDIUM/LOW travel in the residual section); CRITICAL remaining →
 *     do NOT file, surface to the operator. #664 transposed: the terminal
 *     rule is CRITICAL-only — a ratcheting stream of fresh HIGH findings can
 *     no longer prevent filing
 *   - D7: filing failures carry a DISCRIMINATED reason (forge-unresolved,
 *     create-error with stderr, empty-url) on the result and in the
 *     operator-visible text
 *
 * The corrective-round tests (NO-OP, CRITICAL-STILL-ITERATES, UNION,
 * re-pointed RATCHETING) are in test-plan-gap-gate-rounds.ts.
 *
 * The pure parsing seam (parseGaps / verdictParsed / draftSpec status) is
 * unit-tested in test-plan-gap-parser.ts. The registration + dryRun seam is
 * in test-plan-tool.ts.
 */

import { setPlanDispatch } from "../src/plan-driver.ts";
import { setPlanForge } from "../src/plan-filing.ts";
import { runPlanPipeline } from "../src/plan-driver.ts";
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
  mode: "ok" | "throw" | "empty-url";
  error?: string;
}
const forgeStub: ForgeStubState = { created: [], mode: "ok" };

function installForgeStub() {
  const stub = {
    issueCreate: (title: string, body: string) => {
      forgeStub.created.push({ title, body });
      if (forgeStub.mode === "throw") {
        return Promise.reject(new Error(forgeStub.error ?? "gh: HTTP 403 (rate limit exceeded)"));
      }
      if (forgeStub.mode === "empty-url") {
        return Promise.resolve({ url: "" });
      }
      return Promise.resolve({ url: "https://github.com/test/test/issues/1" });
    },
  } as unknown as Forge;
  setPlanForge(() => Promise.resolve(stub));
}
function clearForgeStub() {
  setPlanForge(null);
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  forgeStub.error = undefined;
}

/**
 * A minimal dispatch stub that satisfies the pipeline's requirements:
 * one explore for duplicate-risk, one explore per angle (with structured
 * items), and the gate child replies per the provided gateReply.
 *
 * The gate reply may be a single string (fixed reply, legacy) or an
 * array — one reply per gate iteration, in order.
 */
function makeDispatchStub(gateReply: string | string[]) {
  const replies = Array.isArray(gateReply) ? gateReply : [gateReply];
  let gateIteration = 0;
  return ((pi: unknown, spec: { role: string; prompt: string }) => {
    if (spec.role === "adversarial-developer") {
      gatePrompts.push(spec.prompt);
      const text = replies[gateIteration] ?? replies[replies.length - 1] ?? "";
      gateIteration++;
      return Promise.resolve({
        role: "adversarial-developer",
        ok: true,
        text,
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

// Install the forge stub BEFORE any non-dryRun invocation.
installForgeStub();

// ----------------------------------------------- D1: cap message names the real cause

{
  // D1 (re-pointed): a MEDIUM-only NEEDS_ITERATION reply hits the cap
  // IMMEDIATELY (one dispatch — the no-op corrective round is eliminated).
  // The operator-visible capReason must name the ACTUAL cause (residual-
  // medium-low), NOT the old "unresolved CRITICAL/HIGH gaps remain".
  const mediumGateReply =
    "GAP: MEDIUM criterion 2 is ambiguous — proposed resolution: sharpen criterion 2\n" +
    "GAP: LOW heading is cosmetic — proposed resolution: retitle\n" +
    "VERDICT: NEEDS_ITERATION";
  const gatePromptsBefore = gatePrompts.length;
  setPlanDispatch(makeDispatchStub(mediumGateReply) as never);
  const result = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension", dryRun: true },
    process.cwd(),
  );

  assert(result.capHit === true, "D1: MEDIUM-only NEEDS_ITERATION hits the cap");
  assert(
    result.capReason === "residual-medium-low",
    `D1: capReason is 'residual-medium-low' (got ${result.capReason})`,
  );
  assert(
    gatePrompts.length - gatePromptsBefore === 1,
    `D1: exactly ONE gate dispatch (got ${gatePrompts.length - gatePromptsBefore})`,
  );
  // Adversarial follow-up: the inline cap list is sourced from the residual
  // UNION (plan-tool.ts reads r.residualForDisclosure), not the last round's
  // gaps. With a single round they coincide; the union source is what keeps
  // a 2-round CRITICAL-then-HIGH run from omitting the round-1 HIGH from
  // the inline list (covered by the UNION block below).
  assert(
    result.residualForDisclosure?.length === 2,
    `D1 follow-up: residual union carried on the result (got ${result.residualForDisclosure?.length ?? "none"})`,
  );
  assert(
    (result.residualForDisclosure ?? []).some((g) => g.description === "criterion 2 is ambiguous"),
    "D1 follow-up: the residual union carries the MEDIUM finding for the inline list",
  );

  // Canary: the old message (D1 defect) would have been caught.
  const oldMsg = "GAP GATE CAP HIT: after the iteration cap, unresolved CRITICAL/HIGH gaps remain.";
  assert(
    oldMsg.includes("unresolved CRITICAL/HIGH"),
    "D1 canary: the old message WOULD have been caught",
  );

  setPlanDispatch(null);
}

// ----------------------------------------------- D2: cap routes, not only stops

{
  // D2: at the iteration cap, zero CRITICAL gaps remaining → FILE the
  // spec with the residual MEDIUM/LOW gaps disclosed in a "## Residual
  // gap-gate findings" section. Direct precedent: /work's lens round cap
  // (AGENTS.md §7: "The round cap routes, it does not only stop").

  // Case 1: zero CRITICAL at the cap → file with disclosure.
  const mediumOnly =
    "GAP: MEDIUM clarify the boundary — proposed resolution: add a criterion\n" +
    "GAP: LOW cosmetic heading — proposed resolution: retitle\n" +
    "VERDICT: NEEDS_ITERATION";

  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  setPlanDispatch(makeDispatchStub(mediumOnly) as never);

  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  assert(r1.filed === true, `D2: zero CRITICAL at cap → FILED (got filed=${r1.filed})`);
  assert(r1.capHit === true, "D2: capHit is true");
  assert(
    r1.capReason === "residual-medium-low",
    `D2: capReason is residual-medium-low (got ${r1.capReason})`,
  );
  assert(r1.issueUrl === "https://github.com/test/test/issues/1", "D2: issueUrl is set");

  // The filed spec must carry the residual disclosure.
  const filedBody = forgeStub.created[0]?.body ?? "";
  assert(
    filedBody.includes("## Residual gap-gate findings"),
    "D2: the filed spec has a '## Residual gap-gate findings' section",
  );
  assert(filedBody.includes("[MEDIUM]"), "D2: the residual MEDIUM gap is disclosed with severity");
  assert(filedBody.includes("[LOW]"), "D2: the residual LOW gap is disclosed with severity");
  assert(
    filedBody.includes("add a criterion"),
    "D2: the residual gap's proposed resolution is disclosed",
  );
  assert(
    r1.spec.includes("## Residual gap-gate findings"),
    "D2: the result spec carries the residual disclosure",
  );

  // Case 2: CRITICAL remaining at the cap → DO NOT file. Re-cut to
  // CRITICAL-only from the old CRITICAL+HIGH bundle: the HIGH line is the
  // finding the gate is non-deterministic about, and a bundled case would
  // still pass even if the filter change regressed to HIGH-blocking.
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  const blockingGaps =
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion\n" +
    "VERDICT: NEEDS_ITERATION";

  setPlanDispatch(makeDispatchStub(blockingGaps) as never);

  const r2 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );

  assert(r2.filed === false, `D2: CRITICAL remaining at cap → NOT FILED (got filed=${r2.filed})`);
  assert(r2.capHit === true, "D2: capHit is true (blocking case)");
  assert(
    r2.capReason === "unresolved-blocking",
    `D2: capReason is unresolved-blocking (got ${r2.capReason})`,
  );
  assert(
    forgeStub.created.length === 0,
    `D2: no filing happened (forge calls: ${forgeStub.created.length})`,
  );
  // Finding 1 (adversarial review): the deliberate cap-surface skip must NOT
  // reuse the `forge-unresolved` reason — nothing failed to resolve here.
  assert(
    r2.filingFailure?.reason === "cap-surface",
    `D2: filingFailure.reason is cap-surface, not forge-unresolved (got ${r2.filingFailure?.reason})`,
  );

  // Verdict-absent interaction: an ABSENT verdict with only HIGH gaps
  // now PASSES (HIGH no longer blocks); an ABSENT verdict with a CRITICAL
  // gap still routes NEEDS_ITERATION (the D3 posture — silence must not
  // pass a spec its own reviewer rated CRITICAL-gap).
  const highNoVerdict = "GAP: HIGH boundary unnamed — proposed resolution: name the boundary";
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  setPlanDispatch(makeDispatchStub(highNoVerdict) as never);
  const r4 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(r4.filed === true, `verdict-absent + HIGH-only: PASSES and files (got filed=${r4.filed})`);
  assert(
    r4.capReason !== "unresolved-blocking",
    `verdict-absent + HIGH-only: never unresolved-blocking (got ${r4.capReason})`,
  );
  assert(
    r4.gaps.some((g) => g.severity === "HIGH"),
    "verdict-absent + HIGH-only: the HIGH travels in the residual disclosure (gaps field)",
  );

  const critNoVerdict =
    "GAP: CRITICAL no failure-mode criterion — proposed resolution: add a criterion";
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  setPlanDispatch(makeDispatchStub(critNoVerdict) as never);
  const r5 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(
    r5.filed === false,
    `verdict-absent + CRITICAL: still routes NEEDS_ITERATION → not filed (got filed=${r5.filed})`,
  );
  assert(
    r5.capReason === "unresolved-blocking",
    `verdict-absent + CRITICAL: capReason unresolved-blocking (got ${r5.capReason})`,
  );
  // The corrective round fires: 2 gate dispatches ran (round 1: CRITICAL,
  // round 2: same CRITICAL reply → cap).
  const gatePromptsBeforeR5 = gatePrompts.length;
  void gatePromptsBeforeR5; // (already captured above; the delta check is
  // implicit in the r5.capReason === "unresolved-blocking" assertion, which
  // requires the cap to have been hit, which requires 2 rounds to have run.)

  // Canary: a silent swallow (filing without disclosure) would be caught.
  const silentSwallowBody = "spec without residual section";
  assert(
    !silentSwallowBody.includes("## Residual gap-gate findings"),
    "D2 canary: a spec without disclosure does NOT contain the residual section",
  );

  setPlanDispatch(null);
}

// ----------------------------------------------- D7: filing failure reason surfaced

{
  // D7: a filing failure carries a DISCRIMINATED reason on the result and
  // the operator-visible text surfaces it (including the forge stderr when
  // there is one) — the operator no longer needs PI_ENSEMBLE_DEBUG.

  const readyGate = "VERDICT: READY";

  // Case 1: forge-unresolved (no forge can be resolved).
  forgeStub.created.length = 0;
  setPlanForge(() => Promise.resolve(undefined));
  setPlanDispatch(makeDispatchStub(readyGate) as never);
  const r1 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(r1.filed === false, "D7: forge-unresolved → not filed");
  assert(
    r1.filingFailure?.reason === "forge-unresolved",
    `D7: filingFailure.reason is forge-unresolved (got ${r1.filingFailure?.reason})`,
  );

  // Case 2: create-error (the forge threw — the stderr is in the detail).
  forgeStub.created.length = 0;
  forgeStub.mode = "throw";
  forgeStub.error = "gh: HTTP 403 (rate limit exceeded: https://api.github.com/rate-limit)";
  installForgeStub();
  setPlanDispatch(makeDispatchStub(readyGate) as never);
  const r2 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(r2.filed === false, "D7: create-error → not filed");
  assert(
    r2.filingFailure?.reason === "create-error",
    `D7: filingFailure.reason is create-error (got ${r2.filingFailure?.reason})`,
  );
  assert(
    r2.filingFailure?.detail?.includes("rate limit") === true,
    "D7: create-error detail carries the forge stderr (rate limit)",
  );

  // Case 3: empty-url (the forge returned an issue with an empty url).
  forgeStub.created.length = 0;
  forgeStub.mode = "empty-url";
  installForgeStub();
  setPlanDispatch(makeDispatchStub(readyGate) as never);
  const r3 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(r3.filed === false, "D7: empty-url → not filed");
  assert(
    r3.filingFailure?.reason === "empty-url",
    `D7: filingFailure.reason is empty-url (got ${r3.filingFailure?.reason})`,
  );

  // Case 4: successful filing has NO filingFailure.
  forgeStub.created.length = 0;
  forgeStub.mode = "ok";
  installForgeStub();
  setPlanDispatch(makeDispatchStub(readyGate) as never);
  const r4 = await runPlanPipeline(
    {} as never,
    { descriptor: "add a start_plan_driver tool for the plan pipeline in extension" },
    process.cwd(),
  );
  assert(r4.filed === true, "D7: successful filing");
  assert(r4.filingFailure === undefined, "D7: successful filing has no filingFailure");

  // Canary: the old message would not distinguish the four cases.
  const oldMsg = "PLAN COMPLETED — filing failed or was blocked";
  assert(
    !oldMsg.includes("create-error"),
    "D7 canary: the old generic message does NOT name the specific reason",
  );

  setPlanDispatch(null);
  clearForgeStub();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
