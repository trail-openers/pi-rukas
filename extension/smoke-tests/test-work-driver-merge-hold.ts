#!/usr/bin/env bun
/**
 * A merge-hold must reach its declared handoff.
 *
 * Measured (census of all 240 work-state files on this host, 2026-09-09):
 * 25 cycles (10.4%) ended with `cap-hit{awaiting-human-merge,
 * nextStep:"handoff"}` as the last event, currentStep "merged", and status
 * stuck at "running" forever — no handoff step, no comment, no label, no
 * operator notification, and the queue read them as "still running". Root
 * cause: `nextStep()` checked the terminal short-circuit
 * (`currentStep === "merged" → done`) BEFORE the cap-hit routing branch,
 * and runMerged's hold state sets currentStep="merged" in the same
 * transition that appends the cap-hit. 0 of 221 post-schema cycles ever
 * terminalized cleanly through the merge gate.
 *
 * Per this suite's own doctrine (test-round-cap-routes-to-ci.ts header): a
 * hand-built state proves nothing about the emission — so alongside the
 * nextStep pins, source canaries tie the fixture to runMerged's actual
 * emission shape and pin the branch ORDER in work-driver-context.ts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { nextStep } from "../src/work-driver-context.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function stepOf(s: WorkState): string {
  const d = nextStep(s);
  return d.kind === "step" ? d.step : d.kind;
}

const NOW = 1_700_000_000_000;

/** The EXACT shape runMerged emits on a merge hold (see source canary below). */
function mergeHoldState(): WorkState {
  const base = initialState(42, NOW);
  const held: WorkState = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "merged", status: "running" },
  };
  return appendEvent(held, {
    kind: "cap-hit",
    at: NOW + 1,
    cap: "awaiting-human-merge",
    reviewRound: 0,
    nextStep: "handoff",
  } as WorkEvent);
}

{
  // THE regression pin: the merge hold routes to handoff, never "done".
  const d = nextStep(mergeHoldState());
  assert(
    d.kind === "step" && d.step === "handoff",
    `merge hold routes to handoff (got ${JSON.stringify(d)}) — the old order answered "done" and stranded the cycle at status "running"`,
  );
}

{
  // A GENUINE terminal at merged (last event is the merged record, not a
  // cap-hit) still short-circuits to done.
  const base = initialState(42, NOW);
  const merged: WorkState = appendEvent(
    {
      ...base,
      pipelineState: { ...base.pipelineState, currentStep: "merged", status: "running" },
    },
    { kind: "merged", at: NOW + 1, prNumber: 7, method: "squash" } as unknown as WorkEvent,
  );
  assert(
    stepOf(merged) === "done",
    "genuine merged terminal (non-cap last event) still answers done",
  );
}

{
  // Terminal STATUS always wins (post-handoff states end via status).
  const base = initialState(42, NOW);
  const done: WorkState = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "handoff", status: "handoff" },
  };
  assert(stepOf(done) === "done", "terminal status handoff answers done");
}

{
  // Cap routing to non-handoff destinations is untouched: a round cap
  // routed to ci still goes to ci.
  const base = initialState(42, NOW);
  const routed: WorkState = appendEvent(
    {
      ...base,
      pipelineState: { ...base.pipelineState, currentStep: "lens-review", status: "running" },
    },
    {
      kind: "cap-hit",
      at: NOW + 1,
      cap: "round-cap",
      reviewRound: 3,
      nextStep: "ci",
    } as WorkEvent,
  );
  assert(stepOf(routed) === "ci", "cap-hit routing to ci unchanged");
}

// ---------------------------------------------------------- source canaries

{
  const merged = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-merged.ts"),
    "utf8",
  );
  assert(
    /currentStep:\s*"merged"/.test(merged) && /cap:\s*"awaiting-human-merge"/.test(merged),
    "canary: runMerged still emits the fixture's shape (currentStep merged + awaiting-human-merge cap) — if this moves, move the fixture with it",
  );
  const ctx = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver-context.ts"),
    "utf8",
  );
  const capIdx = ctx.indexOf('lastEvent?.kind === "cap-hit"');
  const terminalIdx = ctx.indexOf('ps.currentStep === "merged" || ps.currentStep === "handoff"');
  assert(
    capIdx > 0 && terminalIdx > 0 && capIdx < terminalIdx,
    `canary: the cap-hit routing branch stays BEFORE the terminal short-circuit (cap=${capIdx}, terminal=${terminalIdx}) — reversing them re-strands merge holds at status "running"`,
  );
  const driver = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "work-driver.ts"),
    "utf8",
  );
  assert(
    /status still "running"/.test(driver),
    'canary: the post-loop anomaly guard exists (a loop ending at status "running" must never again be silent)',
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
