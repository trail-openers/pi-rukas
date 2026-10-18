#!/usr/bin/env bun
/**
 * #1542 — the deadline cap's evidence line tells the truth about time and step.
 *
 * janit/tehas cycle 54-261017-141513 parked with "-3727975ms remained, within
 * the 480000ms handoff grace — step "develop" not started": a negative number
 * in a field called "remained", next to a step that had completed hours
 * earlier, while the adversarial gate had just asked for a fix pass. The line
 * is the one the handoff, the driver-event and `capReason` all carry.
 */

import { deadlineCheck } from "../src/work-driver-deadline.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string, detail?: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${detail ? `\n  ${detail}` : ""}`);
    exit = 1;
  }
}

const T0 = 1_792_262_713_000;
const GRACE = 8 * 60_000;
const ctx = {
  repoRoot: "/tmp/x",
  issue: 54,
  host: { sendUserMessage: () => {}, sendUserMessageAsync: () => {}, emit: () => {} },
} as unknown as Parameters<typeof deadlineCheck>[0];
Reflect.deleteProperty(process.env, "PI_ENSEMBLE_CYCLE_BUDGET_MS");
Reflect.deleteProperty(process.env, "PI_ENSEMBLE_HANDOFF_TIMEOUT_MS");

/** The cycle-54 log: develop done, the adversarial gate requesting a fix pass. */
function afterAdversarialFix(): WorkState {
  let s = initialState(54, 1) as WorkState;
  s = appendEvent(s, { kind: "step-started", at: 1, step: "develop" });
  s = appendEvent(s, { kind: "step-started", at: 2, step: "adversarial" });
  s = appendEvent(s, {
    kind: "adversarial-fix-requested",
    at: 3,
    workstreamId: "default",
    round: 1,
    findings: "CRITICAL: x",
  });
  return s;
}

async function evidenceAt(state: WorkState, step: "develop" | "lens-fix", now: number) {
  process.env.PI_ENSEMBLE_CYCLE_DEADLINE = String(T0);
  const r = await deadlineCheck(ctx, state, step, now);
  const tail = r.state.eventLog.at(-1);
  return { r, ev: tail?.kind === "cap-hit" ? String(tail.evidence) : "" };
}

{
  // 62 minutes past the deadline, at the fix pass's develop boundary.
  const { r, ev } = await evidenceAt(afterAdversarialFix(), "develop", T0 + 3_727_975);
  assert(r.parked, "an overdue boundary parks");
  assert(!ev.includes("-3727975"), "no negative number is printed", ev);
  assert(!ev.includes("remained"), "an overdue deadline is not described as time remaining", ev);
  assert(
    ev.includes("3727975ms earlier (overdue)"),
    "it says how long ago the deadline passed",
    ev,
  );
  assert(
    ev.includes('adversarial round 1 fix pass ("develop") not started'),
    "the refused step is the adversarial fix pass, not the develop step that finished",
    ev,
  );
  assert(ev.includes('the last step that ran was "adversarial"'), "it names the step that ran", ev);
  const why = explainCap("deadline", r.state);
  assert(
    why.includes("had already passed") && !why.includes("was within the handoff grace"),
    "explainCap does not call an overdue deadline 'within the grace'",
    why,
  );
}

{
  // Time genuinely left, inside the grace: the old wording still applies.
  let s = initialState(54, 1) as WorkState;
  s = appendEvent(s, { kind: "step-started", at: 1, step: "lens-review" });
  const { ev, r } = await evidenceAt(s, "lens-fix", T0 - 60_000);
  assert(
    ev.includes(`60000ms remained, within the ${GRACE}ms handoff grace`),
    "time left inside the grace reads as remaining",
    ev,
  );
  assert(ev.includes('step "lens-fix" not started'), "an ordinary boundary names its step", ev);
  assert(
    explainCap("deadline", r.state).includes("was within the handoff grace"),
    "explainCap keeps the in-grace sentence",
  );
}

Reflect.deleteProperty(process.env, "PI_ENSEMBLE_CYCLE_DEADLINE");
process.exit(exit);
