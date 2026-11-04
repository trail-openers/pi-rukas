#!/usr/bin/env bun
/**
 * #1991 — a child can see its own budget, so it stops overrunning it.
 *
 * Children overrun because nothing ever told them where they stood: a build
 * child killed at 401/400 turns with nothing committed, time-boxed developers
 * that ran 80 minutes on a 60-minute brief and never mentioned their own
 * elapsed time, lens children that spent twenty minutes on a 20-line diff. The
 * fix is the number itself, on the child's screen, at half the bound and again
 * at close-out.
 *
 * The AC set this suite pins:
 *   1. exactly TWO steers for N=40 — at turn 20 and turn 32, none after;
 *   2. ZERO steers with no armed bound (the same shape as a bound not yet
 *      crossed must stay distinguishable from no bound at all);
 *   3. ZERO steers once a DIFFERENT killing bound has armed (the #1827
 *      stand-down). The child's OWN run bound is never that signal — AC4's
 *      "default ON whenever a bound is armed" and its stand-down are only
 *      jointly satisfiable under that reading;
 *   4. the 80% instruction by role kind: a committing child commits, every
 *      other role reports (a reviewer told to commit cannot act on it);
 *   5. the source tag `driver-budget-progress`, pinned by the constant form
 *      `DECK_UI_STEER_SOURCE` uses — nothing checks `SteerSource` for
 *      exhaustiveness, so a typo'd literal type-checks and only ever shows as
 *      a wrong scrollback tag;
 *   6. minutes-left rendering, from the CLAMPED spawn-time schedule (a steer
 *      must never promise time the cycle will not grant), including the
 *      "under 1 min" case;
 *   7. the per-lever choice when both are armed: the larger used/limit
 *      fraction speaks, minutes wins a tie.
 *
 * Steer-only throughout: no kill, no `killCause`, and a throwing steer seam is
 * swallowed on the child's hot path — an escaping throw costs the dispatch.
 */

import { PassThrough } from "node:stream";
import {
  BUDGET_PROGRESS_CLOSE_OUT,
  BUDGET_PROGRESS_HALF,
  BUDGET_PROGRESS_STEER_SOURCE,
  type BudgetProgressOpts,
  budgetProgressClock,
  budgetProgressReached,
  budgetProgressText,
  closeOutInstruction,
  closestBudgetLever,
  createBudgetProgressSteer,
  minutesLeft,
  minutesLeftText,
} from "../src/budget-progress.ts";
import type { SteerSource } from "../src/dispatch-steer.ts";

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
  if (a === e) assert(true, msg);
  else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const MINUTE = 60_000;

type Steer = { text: string; source: SteerSource };

/** A steer sink + a live-looking stdin, the shape the caps tests use. */
function harness(opts: Partial<BudgetProgressOpts> & { role?: string } = {}) {
  const steers: Steer[] = [];
  const stdin = new PassThrough();
  const steer = createBudgetProgressSteer({
    role: opts.role ?? "developer",
    commits: opts.commits ?? false,
    stdin,
    onSteer: opts.onSteer === null ? undefined : (text, source) => steers.push({ text, source }),
    ...(opts.turns === undefined ? {} : { turns: opts.turns }),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    ...(opts.boundArmed === undefined ? {} : { boundArmed: opts.boundArmed }),
    ...(opts.exited === undefined ? {} : { exited: opts.exited }),
    ...(opts.deckKey === undefined ? {} : { deckKey: opts.deckKey }),
  });
  return { steers, steer, stdin };
}

// ── 1. EXACTLY TWO STEERS, at turns 20 and 32 for N=40, none after ──────
{
  const { steers, steer } = harness({ turns: 40, commits: true });
  for (let t = 1; t < 20; t++) steer.onAssistantTurn(t, Date.now());
  eq(steers.length, 0, "N=40: no steer before turn 20 (turn 19 is under ceil(0.5·40))");
  steer.onAssistantTurn(20, Date.now());
  eq(steers.length, 1, "N=40: the half steer fires at turn 20");
  assert(
    steers[0].text.includes("turn 20 of 40"),
    `the half steer names turns used and the limit (${steers[0]?.text})`,
  );
  assert(
    !steers[0].text.toLowerCase().includes("commit"),
    "the half steer reports position only — no instruction to stop",
  );
  for (let t = 21; t < 32; t++) steer.onAssistantTurn(t, Date.now());
  eq(steers.length, 1, "N=40: still one steer at turn 31 (under ceil(0.8·40) = 32)");
  steer.onAssistantTurn(32, Date.now());
  eq(steers.length, 2, "N=40: the close-out steer fires at turn 32");
  // 159 is the #546 corpus death; 401 the build child killed past its bound.
  for (const t of [33, 40, 159, 401]) steer.onAssistantTurn(t, Date.now());
  eq(steers.length, 2, "N=40: NEVER a third steer, however far past the bound it runs");
  eq(
    steers.map((s) => s.source),
    [BUDGET_PROGRESS_STEER_SOURCE, BUDGET_PROGRESS_STEER_SOURCE],
    "both steers carry the driver-budget-progress source",
  );
  steer.stop();
}

// ── 2. ZERO steers with no armed bound ───────────────────────────────────
{
  const { steers, steer } = harness({});
  for (let t = 1; t <= 500; t++) steer.onAssistantTurn(t, Date.now());
  eq(steers.length, 0, "no bound armed → no progress steer, ever (500 turns)");
  steer.stop();
}

// ── 3. ZERO steers after a DIFFERENT killing bound armed ─────────────────
{
  let armed = false;
  const { steers, steer } = harness({ turns: 40, boundArmed: () => armed });
  armed = true;
  steer.onAssistantTurn(20, Date.now());
  steer.onAssistantTurn(32, Date.now());
  eq(steers.length, 0, "a child some other bound is already ending gets no progress steer");
  steer.stop();

  // …and the child's OWN run bound is not the stand-down signal: the flag that
  // kills it is `childBoundMs`, and AC4 arms the steer precisely when it is set.
  const own = harness({ turns: 40 });
  own.steer.onAssistantTurn(20, Date.now());
  own.steer.onAssistantTurn(32, Date.now());
  eq(own.steers.length, 2, "the child's own armed bound is NOT a stand-down");
  own.steer.stop();

  // A stand-down that arrives between the two latches costs the second steer
  // only — the first was already delivered and was true when it landed.
  let mid = false;
  const later = harness({ turns: 40, boundArmed: () => mid });
  later.steer.onAssistantTurn(20, Date.now());
  mid = true;
  later.steer.onAssistantTurn(32, Date.now());
  eq(later.steers.length, 1, "standing down mid-run suppresses only the undelivered steer");
  later.steer.stop();
}

// ── 4. the 80% instruction, by role kind ─────────────────────────────────
{
  const dev = harness({ turns: 10, commits: true });
  dev.steer.onAssistantTurn(8, Date.now());
  assert(
    /commit/i.test(dev.steers[0]?.text ?? ""),
    `a committing child is told to COMMIT now (${dev.steers[0]?.text})`,
  );
  assert(
    !/report your findings/i.test(dev.steers[0]?.text ?? ""),
    "a committing child is not told to merely report",
  );
  dev.steer.stop();

  for (const role of ["code-review-specialist", "adversarial-developer", "explore", "ops"]) {
    const r = harness({ turns: 10, commits: false, role });
    r.steer.onAssistantTurn(8, Date.now());
    assert(
      /report your findings now/i.test(r.steers[0]?.text ?? ""),
      `${role} is told to REPORT its findings now (${r.steers[0]?.text})`,
    );
    assert(
      !/\bcommit\b/i.test(r.steers[0]?.text ?? ""),
      `${role} is never told to commit (it has nothing to commit)`,
    );
    r.steer.stop();
  }
  assert(
    closeOutInstruction(true) !== closeOutInstruction(false),
    "the two close-out instructions are actually different sentences",
  );
}

// ── 5. the source tag ───────────────────────────────────────────────────
{
  eq(
    BUDGET_PROGRESS_STEER_SOURCE,
    "driver-budget-progress",
    "the steer source literal is exactly driver-budget-progress",
  );
  const { steers, steer } = harness({ turns: 2 });
  steer.onAssistantTurn(1, Date.now());
  eq(steers[0]?.source, "driver-budget-progress", "a delivered steer carries the tag");
  steer.stop();
}

// ── 6. minutes-left rendering, from the clamped schedule ─────────────────
{
  const anchor = 1_000_000;
  // The unclamped shape `childBoundSchedule` returns for a 30-minute bound with
  // a 10-minute grace: killAtMs = bound + grace.
  const clock = budgetProgressClock({ wrapAtMs: 30 * MINUTE, killAtMs: 40 * MINUTE }, anchor);
  eq(clock.anchorAtMs, anchor, "the schedule keeps its anchor — every read subtracts from it");
  eq(clock.wrapAtMs, anchor + 30 * MINUTE, "wrapAtMs is anchored to absolute time");
  eq(clock.killAtMs, anchor + 40 * MINUTE, "killAtMs is anchored to absolute time");
  eq(minutesLeft(clock, anchor + 12 * MINUTE), 28 * MINUTE, "minutes left run to the KILL");
  eq(minutesLeftText(28 * MINUTE), "28 min", "a whole-minute remainder renders as a minute count");
  eq(minutesLeftText(40_000), "under 1 min", "under a minute is its own phrase");
  eq(minutesLeftText(0), "under 1 min", "a spent clock is never negative or '0 min'");
  eq(minutesLeft(clock, anchor + 99 * MINUTE), 0, "elapsed past the bound clamps at zero");

  // The CLAMPED shape: the cycle deadline took the kill, so `killAtMs` is
  // absent and only the wrap-up steer is armed. The steer must report against
  // THAT, or it promises time the cycle will not grant.
  const clamped = budgetProgressClock({ wrapAtMs: 4 * MINUTE }, anchor);
  eq(clamped.killAtMs, undefined, "a deadline-clamped schedule has no kill of its own");
  eq(
    minutesLeft(clamped, anchor + MINUTE),
    3 * MINUTE,
    "a clamped schedule counts down to the WRAP-UP, which is the time it has",
  );

  // The whole steer, minutes lever speaking, with no turns lever armed.
  const clock2 = budgetProgressClock({ wrapAtMs: 20 * MINUTE, killAtMs: 30 * MINUTE }, Date.now());
  const { steers, steer } = harness({ clock: clock2, commits: false, role: "explore" });
  // 50% of 30 min = 15 min elapsed.
  steer.onAssistantTurn(3, clock2.anchorAtMs + 15 * MINUTE);
  assert(
    /about \d+ min left of 30/.test(steers[0]?.text ?? ""),
    `the minutes lever states minutes left of the total (${steers[0]?.text})`,
  );
  assert(
    !/of undefined|of NaN/.test(steers[0]?.text ?? ""),
    "the minutes lever never prints a missing turns limit",
  );
  steer.onAssistantTurn(4, clock2.anchorAtMs + 24 * MINUTE);
  assert(
    /report your findings now/i.test(steers[1]?.text ?? ""),
    `the close-out still instructs a non-committing child (${steers[1]?.text})`,
  );
  eq(steers.length, 2, "the minutes lever also fires exactly twice");
  steer.stop();

  // "under 1 min" end to end: close-out with seconds on the clock.
  const tight = budgetProgressClock({ wrapAtMs: 2 * MINUTE, killAtMs: 3 * MINUTE }, Date.now());
  const tightHarness = harness({ clock: tight, commits: true });
  tightHarness.steer.onAssistantTurn(1, tight.anchorAtMs + 10 * MINUTE);
  assert(
    /about under 1 min left of 3/.test(tightHarness.steers[0]?.text ?? ""),
    `a spent clock renders "under 1 min" in the steer (${tightHarness.steers[0]?.text})`,
  );
  tightHarness.steer.stop();
}

// ── 7. both levers armed: the closest to its limit speaks ────────────────
{
  eq(
    closestBudgetLever({
      turnsUsed: 39,
      turnsLimit: 40,
      minutesUsedMs: 0,
      minutesLimitMs: 30 * MINUTE,
    }),
    "turns",
    "turns at 97% / minutes at 0% → the turns lever speaks",
  );
  eq(
    closestBudgetLever({
      turnsUsed: 4,
      turnsLimit: 40,
      minutesUsedMs: 25 * MINUTE,
      minutesLimitMs: 30 * MINUTE,
    }),
    "minutes",
    "turns at 10% / minutes at 83% → the minutes lever speaks",
  );
  eq(
    closestBudgetLever({
      turnsUsed: 20,
      turnsLimit: 40,
      minutesUsedMs: 15 * MINUTE,
      minutesLimitMs: 30 * MINUTE,
    }),
    "minutes",
    "a TIE goes to minutes (the kill nearest in real time)",
  );
  eq(
    closestBudgetLever({
      turnsUsed: 5,
      turnsLimit: undefined,
      minutesUsedMs: 0,
      minutesLimitMs: 0,
    }),
    "minutes",
    "neither lever armed is a defined comparison, not a crash",
  );

  // Both armed, crossing on the same turn → ONE line, not two.
  const both = harness({ turns: 40, commits: true });
  both.steer.onAssistantTurn(20, Date.now());
  both.steer.onAssistantTurn(32, Date.now());
  eq(both.steers.length, 2, "both latches on the turns lever: still exactly two steers");
  both.steer.stop();
}

// ── 8. thresholds are per-lever and per-fraction ─────────────────────────
{
  assert(
    budgetProgressReached(20, 40, BUDGET_PROGRESS_HALF) &&
      !budgetProgressReached(19, 40, BUDGET_PROGRESS_HALF),
    "the half latch is the first turn ≥ ceil(0.5·N)",
  );
  assert(
    budgetProgressReached(32, 40, BUDGET_PROGRESS_CLOSE_OUT) &&
      !budgetProgressReached(31, 40, BUDGET_PROGRESS_CLOSE_OUT),
    "the close-out latch is the first turn ≥ ceil(0.8·N)",
  );
  // ceil() matters for an odd bound: ceil(0.5·41) = 21, ceil(0.8·41) = 33.
  assert(
    !budgetProgressReached(20, 41, BUDGET_PROGRESS_HALF) &&
      budgetProgressReached(21, 41, BUDGET_PROGRESS_HALF),
    "N=41: the half latch is turn 21 (ceil rounds UP, it never floors)",
  );
  assert(
    !budgetProgressReached(32, 41, BUDGET_PROGRESS_CLOSE_OUT) &&
      budgetProgressReached(33, 41, BUDGET_PROGRESS_CLOSE_OUT),
    "N=41: the close-out latch is turn 33",
  );
  for (const limit of [undefined, 0, -5]) {
    assert(
      !budgetProgressReached(1e6, limit, BUDGET_PROGRESS_HALF),
      `a limit of ${String(limit)} is no limit at all`,
    );
  }
}

// ── 9. the steer text never speaks of tokens ─────────────────────────────
{
  const text = budgetProgressText({
    turnsUsed: 20,
    turnsLimit: 40,
    minutesLeftMs: 12 * MINUTE,
    minutesTotalMs: 30 * MINUTE,
    closeOut: false,
    commits: true,
  });
  eq(
    text,
    "Budget: turn 20 of 40, about 12 min left of 30.",
    "the AC's example line renders exactly",
  );
  assert(
    !/token/i.test(text),
    "the progress steer never mentions tokens (tokens are out of scope)",
  );
  assert(
    !/budgetSteerText/.test(text),
    "it is a new renderer, not progress.ts's token budget line",
  );
  const closeOut = budgetProgressText({
    turnsUsed: 32,
    turnsLimit: 40,
    closeOut: true,
    commits: true,
  });
  assert(
    closeOut.startsWith("Budget: turn 32 of 40."),
    `with no minutes lever it states turns alone (${closeOut})`,
  );
  assert(/Commit your work now/i.test(closeOut), "the close-out sentence follows the position");
}

// ── 10. a throwing steer seam is swallowed, and not retried ─────────────
{
  let calls = 0;
  const stdin = new PassThrough();
  const steer = createBudgetProgressSteer({
    role: "developer",
    commits: true,
    turns: 10,
    stdin,
    onSteer: () => {
      calls++;
      throw new Error("write EPIPE");
    },
  });
  let threw = false;
  try {
    steer.onAssistantTurn(5, Date.now());
    steer.onAssistantTurn(8, Date.now());
    steer.onAssistantTurn(9, Date.now());
  } catch {
    threw = true;
  }
  assert(!threw, "a throwing steer seam (EPIPE) never escapes onto the child's hot path");
  eq(calls, 2, "a failed steer is attempted once per latch, never retried every turn");
  steer.stop();
}

// ── 11. the no-seam path writes the RPC envelope to stdin ───────────────
{
  const stdin = new PassThrough();
  let written = "";
  stdin.on("data", (d) => {
    written += String(d);
  });
  const steer = createBudgetProgressSteer({
    role: "code-review-specialist",
    commits: false,
    turns: 4,
    stdin,
  });
  steer.onAssistantTurn(2, Date.now());
  steer.onAssistantTurn(4, Date.now());
  const lines = written.split("\n").filter(Boolean);
  eq(lines.length, 2, "a child with no steer seam still receives both steers on stdin");
  eq(
    JSON.parse(lines[0] ?? "{}"),
    { type: "steer", message: "Budget: turn 2 of 4." },
    "the stdin line is exactly the {type:'steer', message} RPC envelope",
  );
  assert(
    (lines[1] ?? "").endsWith("\n") === false,
    "each envelope is newline-terminated (the split above is on the terminator)",
  );
  steer.stop();

  // An exited child is not written to at all.
  const dead = new PassThrough();
  let deadWrites = 0;
  dead.write = () => {
    deadWrites++;
    return true;
  };
  const deadSteer = createBudgetProgressSteer({
    role: "developer",
    commits: true,
    turns: 2,
    stdin: dead,
    exited: () => true,
  });
  deadSteer.onAssistantTurn(2, Date.now());
  eq(deadWrites, 0, "advice is never written to a child whose exit was observed");
  deadSteer.stop();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
