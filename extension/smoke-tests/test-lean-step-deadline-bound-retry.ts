#!/usr/bin/env bun
import { stepDispatchArms } from "../src/lean-step-bound.ts";
/**
 * lean #2660 — a RE-DISPATCHED child is bounded from the instant it is armed, not from the
 * step's original start.
 *
 * `build` re-arms inside its own retry loop (`lean/build.ts`'s `for (let tries…)`): a child
 * that provably did no work gets one free re-dispatch, and below the attempt cap a ceiling
 * stop buys another child. Each of those re-arms asked `stepDispatchArms`, which derived the
 * deadline's room from the step entry's **durable `startedAt`** — so a child dispatched 300 s
 * after the step began was handed the SAME full window as the first one, and its kill landed
 * at (retry start + bound + grace), past deadline + the handoff allowance. That is the field
 * defect this issue exists for, one retry deep.
 *
 * The decision states the bound as the smaller of the configured minutes and the time LEFT
 * to the deadline less the allowance — LEFT, measured at the dispatch instant. These cases
 * drive the REAL step through the REAL fixture with a scripted clock that ADVANCES between
 * dispatches, and score the pair each dispatch actually received (`lib/lean-arms-recorder`
 * captures the opts at the fixture's seam; `test-lean-step-deadline-bound-seams.ts` proves
 * the production seam forwards the same pair to `spawnSpecialist`).
 *
 * The row: a 4200 s cell whose build step opened 978 s before the deadline, an 8 min handoff
 * allowance and the shipped 600 s grace — the panel's shape. `PANEL_LATE_MS` is that step 300 s
 * into its own life, which is where the retry lands.
 */
import { defaultConfig } from "../src/lean/config.ts";
import { __setLeanSleepFn } from "../src/lean/provider-wait.ts";
import { armBudget } from "../src/lean/step-budget.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { childBoundScheduleFor } from "../src/spawn-budget-arms.ts";
import { childBoundGraceMs } from "../src/spawn-child-bound.ts";
import type { DispatchResult } from "../src/types.ts";
import { withEnv } from "./lib/env-scope.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { GOLDEN_ALLOWANCE_MS, GOLDEN_GRACE_MS } from "./lib/lean-step-deadline-bound-off-arm.ts";

const { assert, failures } = makeAssert();

const MINUTE = 60_000;
const CELL_START = 1_700_000_000_000;
const CELL_MS = 4200_000;
const DEADLINE = CELL_START + CELL_MS;
/** The field's row: the build step opened 978 s before the deadline. */
const STEP_START = DEADLINE - 978_000;
/** The retry's instant: 300 s into the same step's life. */
const RETRY_AT = STEP_START + 300_000;
const ALLOWANCE = GOLDEN_ALLOWANCE_MS;
const GRACE = GOLDEN_GRACE_MS;
/** The kill's latest instant: the deadline plus the allowance the handback still owns. */
const LATEST_KILL = DEADLINE + ALLOWANCE;
const ROW_MINUTES = 45;

const env = {
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(ALLOWANCE),
  PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(GRACE),
  PI_ENSEMBLE_DISPATCH_CAPS: "1",
  PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "1",
  // The no-work retry sits out a provider fault before re-dispatching, and the wait reads
  // the SAME scripted clock. Zero the ladder and keep the re-dispatch (`transientRetryEnabled`
  // only refuses at `=0`/`false`), and record rather than take any sleep — so the only thing
  // that moves the clock here is this case's own rule, and no test sleeps.
  PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS: "0",
  PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS: "0",
};

/** Never sleep for real: the offline convention every no-work-retry case already keeps. */
__setLeanSleepFn(async () => true);

const config = { ...defaultConfig(), budgets: { ...defaultConfig().budgets } };
for (const k of Object.keys(config.budgets))
  config.budgets[k] = { minutes: ROW_MINUTES, turns: 0, tokens: 0 };

/** What the rule owes one dispatch, stated at the instant that dispatch is armed.
 *
 * `at` is where the CLOCK stood when the step armed the child — what the step read through
 * `ctx.now()` — and `childMs` is what the SPAWN's clock will read when it builds the child's
 * timers. They differ by exactly the defect: the bound was measured from the step's durable
 * `startedAt` while the child's `wrapAtMs`/`killAtMs` are placed from the spawn's own
 * `Date.now()` (`spawn-child-bound.ts`'s `childBoundSchedule(bound, grace, Date.now())`).
 * A child armed 300 s into a step whose bound was computed from the step's start is therefore
 * killed 300 s later than the deadline's arithmetic intended — past deadline + allowance —
 * and no assertion stated on the step's instant alone can see it. So both are stated here:
 * the kill's absolute instant, and the bound's length from the CHILD's own clock. */
function assertKillInsideLine(
  label: string,
  at: number,
  o: BudgetOpts | undefined,
  childMs: number = at,
): void {
  const bound = o?.childBoundMs ?? 0;
  const grace = o?.childBoundGraceMs ?? GRACE;
  assert(bound > 0, `${label}: a bound was armed at all (captured ${String(o?.childBoundMs)})`);
  assert(
    bound <= ROW_MINUTES * MINUTE,
    `${label}: the bound never exceeds the configured row (${String(bound)} <= ${String(ROW_MINUTES * MINUTE)})`,
  );
  assert(
    childMs + bound + grace <= LATEST_KILL,
    `${label}: the child's kill lands inside deadline + the handoff allowance — the child was armed at +${String(
      childMs - CELL_START,
    )} of the cell, its bound ${String(bound)} + grace ${String(grace)} puts the kill at +${String(
      childMs + bound + grace - CELL_START,
    )} against the ${String(LATEST_KILL - CELL_START)} the cell may spend (deadline + ${String(
      ALLOWANCE,
    )})`,
  );
}

/** A child that did nothing and died: the free re-dispatch's trigger (`didNoWork` +
 *  `providerFaultOf` in `lean/build-dispatch.ts`). No `killCause` — a killed child is not
 *  an endpoint fault — and an errorStop the taxonomy calls transient. */
const NO_WORK_FAULT: DispatchResult = {
  role: "developer",
  ok: false,
  text: "",
  toolUses: [],
  ms: 1,
  exitCode: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  errorStop: { reason: "error", message: "HTTP 503 model is still loading" },
};
const GOOD: DispatchResult = {
  role: "developer",
  ok: true,
  text: "implemented",
  toolUses: [],
  ms: 1,
  exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
};

// ── (1) the control: two dispatches armed at the SAME instant get the SAME pair ─
// The negative control for (2): an advanceable clock that never advances must NOT shorten
// the second dispatch. Without it, (2) would pass for a case that armed nothing.
{
  const armed: BudgetOpts[] = [];
  let r!: Awaited<ReturnType<typeof runBuild>>;
  await withEnv(env, async () => {
    r = await runBuild({
      issue: 2664,
      config,
      buildStartedAt: STEP_START,
      clock: { deadlineMs: DEADLINE, now: () => STEP_START },
      child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
      dispatchResults: (n) => (n === 0 ? NO_WORK_FAULT : GOOD),
      armedOpts: armed,
    });
  });
  assert(
    r.dispatched === 2,
    `(1) precondition: the step re-dispatched a no-work child (${String(r.dispatched)})`,
  );
  assert(
    r.threw === undefined,
    `(1) precondition: the step ended in a verdict, not a throw (${String(r.threw?.message)})`,
  );
  const first = armed[0] ?? {};
  const second = armed[1] ?? {};
  assertKillInsideLine("(1) first dispatch", STEP_START, first);
  assertKillInsideLine("(1) retry dispatch", STEP_START, second);
  assert(
    second.childBoundMs === first.childBoundMs &&
      second.childBoundGraceMs === first.childBoundGraceMs,
    `(1) a clock that never advanced arms the SAME pair twice (${String(first.childBoundMs)}+${String(first.childBoundGraceMs)} vs ${String(second.childBoundMs)}+${String(second.childBoundGraceMs)})`,
  );
}

// ── (2) THE DEFECT: a retry armed 300 s into the step keeps the first window ───
// The same run, with the clock advanced between the two dispatches: the first child is
// armed at the step's start, the retry at +300 s. The retry's kill must still land inside
// deadline + the allowance; measuring from `startedAt` puts it 300 s past the line.
{
  const armed: BudgetOpts[] = [];
  let answered = 0;
  let r!: Awaited<ReturnType<typeof runBuild>>;
  await withEnv(env, async () => {
    r = await runBuild({
      issue: 2665,
      config,
      buildStartedAt: STEP_START,
      clock: {
        deadlineMs: DEADLINE,
        // The first dispatch is armed while no child has ANSWERED, so it reads the step's
        // start; the retry is armed after the first child returned, so it reads +300 s.
        // Keyed on the answer count and not on a call counter, because the engine reads the
        // clock for its own bookkeeping too — the arming instant is the only thing that moves.
        now: () => (answered === 0 ? STEP_START : RETRY_AT),
      },
      child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 1;\n"),
      dispatchResults: (n) => {
        // The fixture arms dispatch n while `answered` still reads n, then calls this when
        // the child answers — so the first child's answer is what advances the clock the
        // retry is armed at.
        if (n === 0) answered = 1;
        return n === 0 ? NO_WORK_FAULT : GOOD;
      },
      armedOpts: armed,
    });
  });
  assert(
    r.dispatched === 2,
    `(2) precondition: the step re-dispatched a no-work child (${String(r.dispatched)})`,
  );
  const first = armed[0] ?? {};
  const retry = armed[1] ?? {};
  assertKillInsideLine("(2) first dispatch", STEP_START, first);
  // The CHILD's clock: the retry's own dispatch happened at +3522 s of the cell, and the
  // spawn places its timers from that instant, not from the step entry's start.
  assertKillInsideLine("(2) retry dispatch (armed 300 s later)", RETRY_AT, retry, RETRY_AT);
  assert(
    (retry.childBoundMs ?? 0) < (first.childBoundMs ?? 0),
    `(2) the retry did NOT get the first dispatch's window: bound ${String(retry.childBoundMs)} vs ${String(first.childBoundMs)} — equal values mean the room was measured from the step's original start, so the retry's kill lands ${String(
      RETRY_AT - STEP_START,
    )} s past where the deadline put it`,
  );
  // The exact guarantee, on the schedule the production arms module builds from the retry's
  // own arms at the retry's own instant: the steer and the kill the CHILD gets.
  const sched = childBoundScheduleFor(retry, RETRY_AT);
  assert(
    sched.wrapAtMs === retry.childBoundMs,
    `(2) the child is steered to wrap up at its bound (+${String(sched.wrapAtMs)} from the retry's start, bound ${String(retry.childBoundMs)})`,
  );
  assert(
    sched.killAtMs !== undefined && RETRY_AT + sched.killAtMs <= LATEST_KILL,
    `(2) and the child's kill is placed at +${String(
      sched.killAtMs === undefined ? Number.NaN : RETRY_AT + sched.killAtMs - CELL_START,
    )} of the cell, inside the ${String(LATEST_KILL - CELL_START)} the cell may spend`,
  );
}

// ── (3) the lever itself, measured at each instant (no fixture, one rule) ──────
// The fixture's clock is one reading per dispatch; this states the rule's own arithmetic at
// both instants AND asks the production arms module where it would place the child's timers,
// from that child's own instant (`childBoundScheduleFor`, the one call `armChildBounds`
// makes). The retry's bound is 168 s — the deadline really does leave only that much from
// +300 s once the allowance and the floored grace are taken out — so an arm that reads the
// step's `startedAt` instead hands the retry the first child's 468 s and puts the kill past
// the line by the drift between the two instants.
for (const [label, at, expectBound] of [
  ["the step's start", STEP_START, 468_000],
  ["300 s into the step", RETRY_AT, 168_000],
] as const) {
  const ctx = {
    repoRoot: "/nowhere",
    issue: 2666,
    run: { schema: 1, issue: 2666, version: "t", models: {}, deadlineMs: DEADLINE },
    steps: [{ key: "2666:build:0", state: "build", startedAt: STEP_START }],
    stepKey: "2666:build:0",
    now: () => at,
  } as never;
  await withEnv(env, async () => {
    const levers = stepDispatchArms(ctx, ROW_MINUTES * MINUTE, "build");
    const a = armBudget({ minutes: ROW_MINUTES, turns: 0, tokens: 0 }, levers.stall, levers.bound);
    assertKillInsideLine(`(3) armed at ${label}`, at, a.opts, at);
    assert(
      a.opts.childBoundGraceMs !== undefined,
      `(3) ${label}: a deadline-derived arm carries its grace (captured ${String(a.opts.childBoundGraceMs)})`,
    );
    assert(
      a.opts.childBoundMs === expectBound,
      `(3) ${label}: the bound is what the deadline leaves FROM THAT INSTANT (${String(expectBound)}), got ${String(a.opts.childBoundMs)} — the step entry sat at +${String(STEP_START - CELL_START)} and the dispatch at +${String(at - CELL_START)}, so the difference is the drift a re-arm must absorb`,
    );
    // The schedule the spawn itself would build from these arms, at the child's own instant.
    const schedule = childBoundScheduleFor(a.opts, at);
    assert(
      schedule.killAtMs !== undefined && at + schedule.killAtMs <= LATEST_KILL,
      `(3) ${label}: the timers the spawn builds from these arms put the kill at +${String(
        schedule.killAtMs === undefined ? Number.NaN : at + schedule.killAtMs - CELL_START,
      )} against the ${String(LATEST_KILL - CELL_START)} the cell may spend`,
    );
  });
}

// ── (4) the off arm at the LATER instant is still the pre-change arm ───────────
{
  const ctx = {
    repoRoot: "/nowhere",
    issue: 2667,
    run: { schema: 1, issue: 2667, version: "t", models: {}, deadlineMs: DEADLINE },
    steps: [{ key: "2667:build:0", state: "build", startedAt: STEP_START }],
    stepKey: "2667:build:0",
    now: () => RETRY_AT,
  } as never;
  await withEnv({ ...env, PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND: "0" }, async () => {
    const levers = stepDispatchArms(ctx, ROW_MINUTES * MINUTE, "build");
    const a = armBudget({ minutes: ROW_MINUTES, turns: 0, tokens: 0 }, levers.stall, levers.bound);
    assert(
      a.opts.childBoundMs === ROW_MINUTES * MINUTE && a.opts.childBoundGraceMs === undefined,
      `(4) switch at 0: the later instant arms the row's own bound and NO grace, byte for byte as before this change (bound ${String(a.opts.childBoundMs)}, grace ${String(a.opts.childBoundGraceMs)})`,
    );
    assert(
      childBoundGraceMs() === GRACE,
      `(4) and the leaf's fallback is the configured ${String(GRACE)}`,
    );
  });
}

for (const dir of ROOTS) {
  try {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp cleanup is best-effort */
  }
}

process.exit(failures() === 0 ? 0 : 1);
