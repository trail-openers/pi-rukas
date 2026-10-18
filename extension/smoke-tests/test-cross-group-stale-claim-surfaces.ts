#!/usr/bin/env bun
/**
 * #1454 — the operator-facing surfaces of a `cross-group-conflict` park.
 *
 * Six cycles parked on stale path claims and every one of them got the same
 * generic queue action — "inspect .pi/work-state/N.json and re-run /work N
 * --restart" — plus an `explainCap` sentence that called the claim an "active
 * claim" and told the operator to "coordinate with the other cycle's owner".
 * In each park the other cycle had already exited or reached a terminal
 * status, so the advice pointed at a corpse and the re-run re-parked.
 *
 * Asserts the two halves the operator actually sees:
 *   - `parkReason` carries the CLAIMANT's number machine-readably;
 *   - `humanActionFor` names that claimant and the claims file, and does not
 *     advise coordinating with a dead owner;
 *   - `explainCap` states the liveness rule rather than asserting the claim is
 *     active;
 *   - the terminal-status notion the claims gate reads is the one shared
 *     predicate, not a re-derived status string.
 */

import { explainCap } from "../src/work-driver-explain.ts";
import { parkReason } from "../src/work-queue-park-reason.ts";
import { humanActionFor } from "../src/work-queue.ts";
import { initialState } from "../src/workflow-state-update.ts";
import { TERMINAL_STATUSES, isTerminalState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A cycle parked at plan by the claim check against #1421. */
function parkedAgainst1421(): WorkState {
  const s = initialState(1427, 1) as WorkState;
  s.pipelineState.currentStep = "plan";
  s.pipelineState.status = "handoff";
  s.owner = { pid: 3716067, at: 1 };
  s.eventLog = [
    {
      kind: "cap-hit",
      at: 2,
      cap: "cross-group-conflict",
      evidence:
        "claimant1421 issue #1421 claims: extension/src/worktree-provision.ts, extension/src/work-driver-verify-develop-helpers.ts; overlapping: extension/src/work-driver-verify-develop-helpers.ts",
      reviewRound: 0,
      nextStep: "handoff",
    },
  ];
  return s;
}

// ---------------------------------------------------------------- park reason
{
  const { reason, failedStep } = parkReason(parkedAgainst1421());
  assert(
    reason.startsWith("cap cross-group-conflict"),
    `parkReason names the cap (got "${reason}")`,
  );
  assert(
    reason.includes(":claimant1421"),
    `parkReason carries the claimant machine-readably (got "${reason}")`,
  );
  assert(
    failedStep !== "explore",
    `failedStep is not the stale "explore" default (got ${failedStep})`,
  );
}

// ---------------------------------------------------------------- queue action
{
  const reason = parkReason(parkedAgainst1421()).reason;
  const action = humanActionFor(reason, 1427);
  assert(
    action.includes("#1421"),
    "the queue action names the CLAIMANT, not just the parked issue",
  );
  assert(
    action.includes("path-claims.json"),
    "the queue action points at the claims file the operator must actually inspect",
  );
  assert(
    !/coordinate with the other cycle/i.test(action),
    "the queue action does not advise coordinating with a possibly-dead owner",
  );
  // The generic fallback must not be what a cross-group park gets — that was
  // the shape that sent six operators to re-run an unchanged issue.
  const generic = "inspect .pi/work-state/1427.json and re-run `/work 1427 --restart`";
  assert(
    action !== generic,
    "a cross-group park no longer gets the generic inspect-and-restart action",
  );
  // A reason with no claimant suffix (a state file from before this fix) still
  // gets the claims-aware advice rather than the generic one.
  const legacy = humanActionFor("cap cross-group-conflict", 1427);
  assert(
    legacy.includes("path-claims.json") && legacy !== generic,
    "a pre-suffix park still gets claims-aware advice",
  );
}

// ---------------------------------------------------------------- explainCap
{
  const prose = explainCap("cross-group-conflict", parkedAgainst1421());
  assert(prose.includes("#1421"), "explainCap names the claimant");
  assert(!/active claim/i.test(prose), "explainCap no longer asserts the claim is ACTIVE");
  assert(
    /exited|terminal|still running/i.test(prose),
    "explainCap states the liveness rule the operator can act on",
  );
  assert(
    prose.includes(".pi/work-state/1421.json"),
    "explainCap names the claimant's state file to check",
  );
}

// ------------------------------------------------- one shared terminal notion
{
  // The claims gate must not re-derive "is this cycle finished?" from a
  // status string of its own. There is exactly one predicate and one list.
  assert(
    TERMINAL_STATUSES.includes("merged") &&
      TERMINAL_STATUSES.includes("handoff") &&
      TERMINAL_STATUSES.includes("aborted"),
    "the terminal set is merged/handoff/aborted",
  );
  assert(!TERMINAL_STATUSES.includes("running"), "running is not terminal");
  assert(
    !TERMINAL_STATUSES.includes("interrupted"),
    "interrupted is NOT terminal — it is resumable, so its owner still owns its claim",
  );
  for (const status of ["merged", "handoff", "aborted"] as const) {
    const s = initialState(1, 1) as WorkState;
    s.pipelineState.status = status;
    assert(isTerminalState(s), `isTerminalState(${status}) is true`);
  }
  for (const status of ["running", "interrupted"] as const) {
    const s = initialState(1, 1) as WorkState;
    s.pipelineState.status = status;
    assert(!isTerminalState(s), `isTerminalState(${status}) is false`);
  }
  assert(
    !isTerminalState(undefined),
    "an unreadable state file is not terminal — the age bound decides",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
