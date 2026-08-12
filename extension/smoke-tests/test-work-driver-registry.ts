#!/usr/bin/env bun
/**
 * Two `/work` cycles in one process must not both proceed.
 *
 * The on-disk owner check cannot catch this, by design: `classifyRunningState`
 * refuses only when `owner.pid !== selfPid`, because a driver resuming its own
 * crashed state file must not refuse itself. So two cycles started from the
 * SAME process see a matching pid and neither refuses.
 *
 * That was unreachable while `/work` was only a slash command — you cannot type
 * two at once. It becomes reachable the moment a tool can start a cycle, which
 * is exactly what `start_work_driver` does. Two drivers on one branch interleave
 * commits and produce a PR nobody can review.
 */

import { claimCycle, liveCycles, resetRegistry } from "../src/work-driver-registry.ts";
import { classifyRunningState } from "../src/work-driver-resume.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------- the hole this exists to close

{
  // A running state file owned by THIS process — the shape a second
  // tool-launched cycle would find.
  const state = {
    issue: 664,
    owner: { pid: process.pid, at: 1 },
    pipelineState: { status: "running", currentStep: "develop", inFlightJobIds: [] },
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  } as any as WorkState;

  const verdict = classifyRunningState(state);
  assert(
    verdict.action !== "refuse",
    "canary: the on-disk check does NOT refuse a same-process cycle — the exclusion is deliberate, so the registry must cover it",
  );

  // ...and it must still refuse a genuinely foreign owner. pid 1 is always live.
  const foreign = { ...state, owner: { pid: 1, at: 1 } };
  assert(
    classifyRunningState(foreign).action === "refuse",
    "the cross-process refusal is untouched",
  );
}

// ------------------------------------------------------ the registry itself

{
  resetRegistry();
  const first = claimCycle(664);
  assert(first.ok, "a first cycle claims its issue");

  const second = claimCycle(664);
  assert(!second.ok, "a second cycle for the same issue is refused");
  if (!second.ok) {
    assert(second.conflictIssue === 664, "...naming the issue that collided");
    assert(second.heldByCycle === 664, "...and the cycle holding it");
  }

  if (first.ok) first.claim.release();
  assert(claimCycle(664).ok, "after release, the issue can be claimed again");
  resetRegistry();
}

// ------------------------------- grouped cycles are keyed by EVERY issue

{
  resetRegistry();
  // The primary-only bug: a group for #10+#11 must collide with a later
  // single cycle for #11, which keying on the primary alone would miss.
  const group = claimCycle(10, [10, 11, 12]);
  assert(group.ok, "a grouped cycle claims all of its issues");

  const overlap = claimCycle(11);
  assert(!overlap.ok, "a later cycle for a NON-primary member of the group is refused");
  if (!overlap.ok) {
    assert(overlap.heldByCycle === 10, "...pointing at the group's primary, #10");
  }

  assert(claimCycle(13).ok, "an unrelated issue is unaffected");
  resetRegistry();
}

// ------------------------------------------------- release is well-behaved

{
  resetRegistry();
  const a = claimCycle(20, [20, 21]);
  assert(a.ok, "claim taken");
  if (a.ok) {
    a.claim.release();
    a.claim.release();
    assert(liveCycles().length === 0, "release is idempotent — a double release is safe");
  }

  // A stale release must not delete a LATER cycle's claim on the same issue.
  const b = claimCycle(30);
  if (b.ok) b.claim.release();
  const c = claimCycle(30);
  if (b.ok) b.claim.release(); // stale, already released
  assert(c.ok, "the later claim exists");
  assert(
    liveCycles().includes(30),
    "a stale release does not drop a later cycle's claim on the same issue",
  );
  resetRegistry();
}

// -------------------------------------- an all-or-nothing partial claim

{
  resetRegistry();
  const held = claimCycle(41);
  assert(held.ok, "issue 41 is held");
  const partial = claimCycle(40, [40, 41, 42]);
  assert(!partial.ok, "a group overlapping a held issue is refused whole");
  assert(
    claimCycle(42).ok,
    "...and claims nothing: #42 is still free, so a refused group leaves no partial lock",
  );
  resetRegistry();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
