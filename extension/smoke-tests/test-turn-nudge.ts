#!/usr/bin/env bun
/**
 * #546 AC4 — the opt-in soft turn-count nudge (~80 turns).
 *
 * A long dispatch dying mid-stream is cheap to recover from IF the child
 * wrote a status summary first: recovery is "survey disk + resume dispatch
 * with the full contract", not a blind re-run. The nudge exists so that at
 * the turn count where a mid-stream death stops being surprising, the child
 * is reminded to keep its status current.
 *
 * Design (matches the AC): STEER-ONLY — no killCause, no kill, no cap
 * interaction. It rides the existing #543 F2 `onSteer` seam (the same seam
 * the F1 loop detector and F6 token budget use) and fires at most once per
 * dispatch. It is DEFAULT-OFF: `PI_ENSEMBLE_TURN_NUDGE` unset/`0`/garbage →
 * inert; `1` → on at the module constant `TURN_NUDGE_AT = 80`.
 *
 * Why 80: the #546 corpus of long-dispatch mid-stream deaths (95-min silent
 * solo reviewer, 159-turn fix developer, 231-turn lens-mediums fix
 * developer) all sit above it, and every healthy short run in the same
 * corpus ends with a structured summary well below it — so the nudge is a
 * no-op for the runs that were never at risk, and lands with margin before
 * the smallest observed death.
 *
 * Why steer-only / no cap coupling: the nudge is a REMINDER, not a bound.
 * Gating it on `PI_ENSEMBLE_DISPATCH_CAPS` or the ops-role exemption would
 * conflate a courtesy with a kill authority; a long ops run is precisely
 * where a status line is cheapest to write, so ops children get it too
 * (when a job is attached to carry the lifecycle line).
 */

import type { SteerSource } from "../src/dispatch-steer.ts";
import { createCapSession } from "../src/spawn-caps.ts";
import { TURN_NUDGE_AT, turnNudgeAt, turnNudgeEnabled, turnNudgeText } from "../src/turn-nudge.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    assert(true, msg);
  } else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// 1. Module constant: the calibration threshold is 80, and it is what the
//    enabled reader returns when the env asks for "on".
{
  eq(TURN_NUDGE_AT, 80, "TURN_NUDGE_AT is the #546 calibration constant 80");
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => turnNudgeEnabled()),
    "turnNudgeEnabled: PI_ENSEMBLE_TURN_NUDGE=1 → on",
  );
}

// 2. turnNudgeAt: SHIPS DEFAULT-OFF. Unset / "0" / garbage → 0 (off);
//    "1" → the constant; an explicit number → that number (operator tuning).
{
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: undefined }, () => turnNudgeAt()) === 0,
    "turnNudgeAt: unset → 0 (off — ships default-off per the AC)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: "0" }, () => turnNudgeAt()) === 0,
    "turnNudgeAt: '0' → 0 (explicit off)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: "off" }, () => turnNudgeAt()) === 0,
    "turnNudgeAt: non-numeric, non-'1' → 0 (garbage is off, never NaN)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => turnNudgeAt()) === TURN_NUDGE_AT,
    "turnNudgeAt: '1' → TURN_NUDGE_AT (the calibrated default)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_TURN_NUDGE: "50" }, () => turnNudgeAt()) === 50,
    "turnNudgeAt: explicit number → that number (operator override)",
  );
}

// 3. turnNudgeText: soft phrasing. It asks the child to write its status
//    NOW — it does not tell it to stop working (that is the budget steer's
//    message) and does not claim the work is complete (the #299 note: the
//    assistant turn carrying a toolCall completes BEFORE the tool executes).
{
  const t = turnNudgeText(TURN_NUDGE_AT);
  assert(t.includes("80"), "steer text names the turn count");
  assert(/status/i.test(t) && /now/i.test(t), "steer text asks for a status write NOW");
  assert(/close to done/i.test(t), "steer text is conditional ('if you are close to done')");
  assert(
    !/stop what you are doing/i.test(t),
    "steer text does NOT tell the child to stop (that is the budget)",
  );
  assert(
    !/do not start new work/i.test(t),
    "steer text does NOT forbid continuing (it is a reminder, not a cap)",
  );
  assert(
    !/(^|[^a-z])complete([^a-z]|$)/i.test(t),
    "steer text does not claim the work is complete (as a verdict)",
  );
  const t120 = turnNudgeText(120);
  assert(
    t120.includes("120"),
    "steer text uses the ACTUAL turn count when the threshold is overridden",
  );
}

// 4. CapSession: with the nudge OFF (ship default), the nudge is inert even
//    when driven past the threshold — an 119-turn stream produces no steer of
//    any kind and no killCause. (The fn is still exposed when the seams are
//    present; OFF is the per-call `turnNudgeAt()` read returning 0 — the same
//    shape as `loopDetectorEnabled()`, and it lets an env set between
//    construction and turn 80 take effect.)
{
  const steers: Array<{ text: string; source: SteerSource }> = [];
  let turn = 0;
  let session: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: undefined }, () => {
    session = createCapSession({
      role: "developer",
      child: { kill: () => {} } as never,
      onSteer: (text, source) => steers.push({ text, source }),
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 60_000,
      childExited: () => false,
      turns: () => turn,
    });
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: undefined }, () => {
    for (let i = 1; i <= 119; i++) {
      turn = i;
      session?.turnNudge?.(turn);
    }
  });
  assert(steers.length === 0, "inertness: no steer emitted while off (119 turns)");
  assert(session?.killCause() === undefined, "inertness: no killCause while off");
  session?.cleanup();
}

// 5. CapSession: with the nudge ON, turnNudge exists and fires EXACTLY ONCE,
//    at the first turn ≥ 80 — not on 79, not again at 81/159.
{
  const steers: Array<{ text: string; source: SteerSource }> = [];
  let turn = 0;
  const session = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: (text, source) => steers.push({ text, source }),
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => turn,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    for (let i = 1; i <= 79; i++) {
      turn = i;
      session.turnNudge?.(turn);
    }
    assert(steers.length === 0, "no steer before turn 80");
    turn = 80;
    session.turnNudge?.(turn);
    assert(steers.length === 1, "steer fires at turn 80");
    turn = 81;
    session.turnNudge?.(turn);
    turn = 159; // the 159-turn corpus death
    session.turnNudge?.(turn);
    assert(steers.length === 1, "steer fires at most once per dispatch (not at 81/159)");
  });
  assert(
    steers[0].source === "driver-turn-nudge",
    "steer is tagged with the driver-turn-nudge source (scrollback shows WHY)",
  );
  assert(steers[0].text === turnNudgeText(80), "steer text is turnNudgeText(actual turn)");
  assert(session.killCause() === undefined, "steer-only: the nudge contributes NO killCause");
  session.cleanup();
}

// 6. CapSession: an explicit numeric threshold is honoured (operator tuning
//    below the calibrated 80 without a code change).
{
  const steers: string[] = [];
  const session = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: (text) => steers.push(text),
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 41,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "40" }, () => {
    session.turnNudge?.(39);
    assert(steers.length === 0, "explicit '40': no steer at turn 39");
    session.turnNudge?.(41);
    assert(steers.length === 1, "explicit '40': steer at turn 41 (first ≥ 40)");
    assert(steers[0] === turnNudgeText(41), "explicit '40': text names turn 41");
  });
  session.cleanup();
}

// 7. CapSession: without the `turns` counter or without `onSteer` the nudge
//    is absent even when the env is on — no crash, no steer, and no other
//    cap is disturbed (ops-role children pass through createCapSession with
//    onSteer undefined in some call paths; lens/adversarial bypass the
//    registry entirely).
{
  let steers = 0;
  const noTurns = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: () => steers++,
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    assert(noTurns.turnNudge === undefined, "no `turns` counter → no nudge (even with env on)");
  });
  noTurns.cleanup();

  const noSteer = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 99,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    assert(noSteer.turnNudge === undefined, "no onSteer seam → no nudge (job-less children)");
  });
  noSteer.cleanup();
  eq(steers, 0, "no steer leaked from the no-turns session");
}

// 8. CapSession: an onSteer that throws (EPIPE — the child exited between
//    the turn and the steer) is swallowed; the session stays usable and the
//    killCause remains undefined.
{
  const session = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: () => {
      throw new Error("write EPIPE");
    },
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 80,
  });
  let threw = false;
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    try {
      session.turnNudge?.(80);
    } catch {
      threw = true;
    }
  });
  assert(!threw, "a throwing onSteer (EPIPE) does not propagate");
  assert(session.killCause() === undefined, "EPIPE nudge leaves killCause undefined");
  // The failed steer is not retried on later turns — one attempt, like the
  // loop detector's one-steer-per-dispatch discipline.
  let calls = 0;
  const counting = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: () => {
      calls++;
      throw new Error("write EPIPE");
    },
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 90,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    counting.turnNudge?.(90);
    counting.turnNudge?.(91);
    counting.turnNudge?.(92);
  });
  eq(calls, 1, "a failed nudge is not retried on subsequent turns");
  session.cleanup();
  counting.cleanup();
}

// 9. CapSession: the nudge is NOT gated by the #543 master switch or the
//    ops-role exemption — it is a reminder, not a kill authority, and a long
//    ops run is where a status line is cheapest to write.
{
  let steers = 0;
  const capsOff = createCapSession({
    role: "developer",
    child: { kill: () => {} } as never,
    onSteer: () => steers++,
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 80,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1", PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () => {
    assert(
      capsOff.turnNudge !== undefined,
      "nudge survives PI_ENSEMBLE_DISPATCH_CAPS=0 (it is not a cap)",
    );
    capsOff.turnNudge?.(80);
    assert(steers === 1, "nudge fires with the master switch off");
  });
  capsOff.cleanup();

  steers = 0;
  const opsRole = createCapSession({
    role: "ops",
    child: { kill: () => {} } as never,
    onSteer: () => steers++,
    totalTokens: () => 0,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 60_000,
    childExited: () => false,
    turns: () => 80,
  });
  withEnv({ PI_ENSEMBLE_TURN_NUDGE: "1" }, () => {
    assert(
      opsRole.turnNudge !== undefined,
      "nudge applies to ops-role children too (no cap exemption)",
    );
    opsRole.turnNudge?.(80);
    assert(steers === 1, "nudge fires for an ops-role child");
    assert(
      opsRole.loopObserver === undefined,
      "ops-role still has no loop observer (the #543 exemption is intact)",
    );
  });
  opsRole.cleanup();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
