#!/usr/bin/env bun
/**
 * lean/ci — the tier's TIME: what the full verify tier may be given, and when it
 * may not be given anything at all.
 *
 * `ci` spends up to TWO `ci` budgets in one step: the forge wait, then the full
 * tier, sequentially (the wait's own cases are `test-lean-ci-poll.ts`). The
 * engine consults the run's whole-cycle deadline only BETWEEN steps, so a tier
 * armed after a long wait can run its full bound past the host's deadline and
 * the container dies mid-tier with no result document — which is the defect
 * (w)/(x) hold shut. (y) holds the other one: a `budgets.ci.minutes` of `0`
 * means "no bound" everywhere else in a budget, and here the same number is two
 * timeouts, so read literally it is a wait that expired before it started.
 *
 *   (w) the tier's bound is CLAMPED to what the cycle deadline still leaves
 *   (x) a wait that ate the deadline's margin -> the tier never starts, and the
 *        handback names the cycle deadline
 *   (y) `budgets.ci.minutes: 0` is the shipped default, not a bound of zero
 *
 * Same recorder as the other two suites (`lib/lean-ci-recorder.ts`), so the
 * tier is an `sh` command and no PR or merge exists. Every case here bounds its
 * own clock: the fixture's clock moves only through the injected `sleep`, so a
 * case that waits without asking for a moving clock hangs rather than burning a
 * real minute per poll.
 */

import { CI_POLL_MS } from "../src/lean/ci.ts";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { cleanUp, run, viewAt } from "./lib/lean-ci-recorder.ts";
import { VerifyInfraError } from "../src/lean/verify-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (w) the tier's bound is CLAMPED to the time the cycle deadline leaves ──
{
  // Without a clamp this run is given the shipped 30 minutes of tier after
  // already spending a minute waiting, and a host deadline that leaves less
  // kills the container mid-tier with no result document. The clamp is
  // `deadline - now - the handoff allowance`, and the allowance is the number
  // `deadlineStopsSteps` itself applies — so the case pins it to the same
  // helper rather than to a copy of the constant.
  const start = 1_000;
  // The wait spends one poll (`CI_POLL_MS`) before the tier is armed, and the
  // clamp is computed at that moment on the context's clock. The case leaves
  // the deadline room for a whole tier PLUS that minute, so the min lands on
  // the clamp side and a bound read from the budget alone would be larger.
  const waited = CI_POLL_MS;
  const room = 29 * 60_000;
  const deadline = start + handoffAllowanceMs() + waited + room;
  const r = await run({
    full: "true",
    clockMs: start,
    deadlineMs: deadline,
    tierTimeoutMs: null,
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h)],
    checksSeq: [
      [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
      [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
    ],
  });
  assert(
    r.outcome?.kind === "green",
    `(w) a run with room left still gets its tier (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
  );
  assert(
    r.tierTimeoutMs === deadline - start - waited - handoffAllowanceMs(),
    `(w) the tier got what the deadline still left once the wait had spent its minute, MINUS the handoff allowance, not the full 30 min (${String(r.tierTimeoutMs)}, expected ${String(deadline - start - waited - handoffAllowanceMs())}, allowance ${String(handoffAllowanceMs())})`,
  );
  assert(
    r.tierTimeoutMs !== 30 * 60_000,
    `(w) which is not the un-clamped budget (${String(r.tierTimeoutMs)})`,
  );
  // No deadline at all, same clock and same wait: the clamp is a deadline rule
  // and must not touch a run that has none.
  const unbounded = await run({
    full: "true",
    clockMs: start,
    tierTimeoutMs: null,
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h)],
    checksSeq: [
      [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
      [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
    ],
  });
  assert(
    unbounded.tierTimeoutMs === 30 * 60_000,
    `(w) and with no cycle deadline the tier keeps its full bound (${String(unbounded.tierTimeoutMs)})`,
  );
  assert(r.slept.length === 1, `(w) after one wait out (${JSON.stringify(r.slept)})`);
}

// ── (x) a wait that ate the deadline's margin -> the tier never starts ────
{
  // The poll's own cycle check fires only while a row is still WAITING. Here
  // every row is terminal from the first read, so the poll exits clean with
  // the clock unmoved, and the only thing standing between this run and a
  // 30-minute tier inside a deadline already past its handoff allowance is the
  // re-check the step makes before it starts the command. The tier must never
  // be started, and the handback must name the deadline that stopped it.
  const start = 1_000;
  const deadline = start + handoffAllowanceMs() - 30_000;
  const r = await run({
    full: "true",
    clockMs: start,
    deadlineMs: deadline,
    tierTimeoutMs: null,
  });
  assert(
    r.threw instanceof VerifyInfraError,
    `(x) a tier with no room left inside the deadline THROWS infra (${String(r.threw?.message)})`,
  );
  assert(
    (r.threw?.message ?? "").includes("cycle deadline"),
    `(x) and the handback NAMES the cycle deadline (${String(r.threw?.message)})`,
  );
  assert(r.outcome === undefined, "(x) no verdict the machine could route to a fix round");
  assert(!r.cmds.includes("true"), "(x) the full tier never started");
  assert(
    r.slept.length === 0,
    `(x) the poll never waited — the tier re-check is the gate (${JSON.stringify(r.slept)})`,
  );

  // The other arm, which only the pre-start re-check reaches: the wait spent
  // enough of the cycle that the run is now INSIDE the handoff allowance, but
  // the tier's own budget is small enough that a clamp alone would still hand
  // it a positive timeout. Deleting the re-check and keeping only the clamp
  // starts a tier the engine would never have started a step for, and the run
  // reports nothing. So the tier must not start AND the message must be the
  // in-the-allowance one, not the no-room-outside-it one.
  const inside = await run({
    full: "true",
    clockMs: 0,
    // One poll of waiting, and the deadline left just inside the allowance.
    deadlineMs: CI_POLL_MS + handoffAllowanceMs() - 30_000,
    ciBudget: { turns: 0, tokens: 0, minutes: 2 },
    viewAt: (h) => [viewAt(h, { mergeStateStatus: "UNSTABLE" }), viewAt(h)],
    checksSeq: [
      [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
      [{ name: "quality-gate", bucket: "pass", state: "SUCCESS" }],
    ],
  });
  assert(
    inside.threw instanceof VerifyInfraError &&
      (inside.threw?.message ?? "").includes("inside the handoff allowance"),
    `(x) a wait that ran INTO the allowance hands back naming it, rather than arming a tier (${String(inside.threw?.message)})`,
  );
  assert(
    inside.slept.length === 1,
    `(x) the poll itself stayed legal (its bound is the 2-min budget), so this is the tier's own re-check (${JSON.stringify(inside.slept)})`,
  );
  assert(!inside.cmds.includes("true"), "(x) and that tier never started");
}

// ── (y) `budgets.ci.minutes: 0` is the shipped default, not a bound of 0 ──
{
  // Elsewhere in a budget `0` means "no bound" (`armBudget` arms no wall clock
  // at all). Here the same number becomes two timeouts, so taken literally a
  // `0` is a wait that expired before it ran and a tier of no time — every run
  // handing back at once, the opposite of what a generous 0 says everywhere
  // else. So the step must read the shipped 30 minutes instead. The wait bound
  // is left to the budget (no `waitTimeoutMs`) and the clock only the injected
  // sleep moves: a literal `0` expires on the first read, with no poll at all
  // and a message that says "after 0 min".
  const r = await run({
    full: "true",
    clockMs: 0,
    tierTimeoutMs: null,
    ciBudget: { turns: 0, tokens: 0, minutes: 0 },
    viewAt: (h) => viewAt(h, { mergeStateStatus: "UNSTABLE" }),
    checks: [{ name: "quality-gate", bucket: "pending", state: "PENDING" }],
  });
  assert(
    r.threw instanceof VerifyInfraError &&
      (r.threw?.message ?? "").includes("still pending after 30 min"),
    `(y) minutes: 0 waits the shipped default (30 min), not zero (${String(r.threw?.message)})`,
  );
  assert(
    r.slept.length === 30,
    `(y) thirty polls of the shipped bound, where a literal 0 would poll not at all (${String(r.slept.length)})`,
  );
  // And the rule must be the row's, not a hard-coded 30: a config that names a
  // real number still gets that number, so the default cannot be a constant the
  // step prefers over `.pi/work.json`.
  const named = await run({
    full: "true",
    tierTimeoutMs: null,
    ciBudget: { turns: 0, tokens: 0, minutes: 7 },
  });
  assert(
    named.outcome?.kind === "green" && named.tierTimeoutMs === 7 * 60_000,
    `(y) a configured 7 still means 7, so the rule is only the zero (${String(named.tierTimeoutMs)}, ${JSON.stringify(named.outcome ?? named.threw?.message)})`,
  );
  const clean = await run({
    full: "true",
    tierTimeoutMs: null,
    ciBudget: { turns: 0, tokens: 0, minutes: 0 },
  });
  assert(
    clean.outcome?.kind === "green" && clean.tierTimeoutMs === 30 * 60_000,
    `(y) with no deadline to clamp by, a zero row got the shipped 30 min, not zero (${String(clean.tierTimeoutMs)}, ${JSON.stringify(clean.outcome ?? clean.threw?.message)})`,
  );
}

cleanUp();
process.exit(exit);
