/**
 * smoke-tests/lib/lean-step-bound-arms — the arms one lean step handed its dispatch, and
 * the timers the spawn builds from them (#2660).
 *
 * The panel-row shape this issue exists for: a red verify of about 2000 s, then a build
 * child still running when the deadline passes. Pinning that needs three real
 * productions in one line — the step's arms (`armBudget`, fed the `StepBound` its own
 * `stepChildBound` derives from the run record and a scripted clock), the spawn's schedule
 * for those arms (`childBoundScheduleFor`, the one call `armChildBounds` makes), and the
 * step's verdict (`buildOutcome` etc. through the real fixtures). A case that re-derived
 * the bound here would pass with the deadline term deleted from `lean-step-bound.ts`,
 * which is the failure the #2660 review refused.
 *
 * There are NO timers and no child process in this file, deliberately. The kill a bound
 * performs is `setTimeout` + `killProcessTree` on unref'd timers — bun's test runner
 * keeps that unobservable, and an earlier revision of this suite spent five hours trying
 * to watch it. What a case can observe, and what the acceptance criteria are actually
 * stated in, is the pair the step hands the spawn: `childBoundMs` and
 * `childBoundGraceMs`. Their sum IS where the kill lands relative to the step start,
 * because the production arms module builds both timers out of exactly those two numbers
 * (`childBoundScheduleFor`), and `applyChildBound` stamps the result with the bound the
 * step armed — so a verdict read through the fixture's dead-child dispatch carries the
 * deadline's own number, not the configured row.
 */

import type { StepBound } from "../../src/lean-step-bound.ts";
import { stepChildBound } from "../../src/lean-step-bound.ts";
import type { Budget } from "../../src/lean/config.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { BudgetArms, BudgetOpts } from "../../src/lean/step-budget.ts";
import { armBudget } from "../../src/lean/step-budget.ts";
import { childBoundScheduleFor } from "../../src/spawn-budget-arms.ts";
import { childBoundGraceMs } from "../../src/spawn-child-bound.ts";

/** The field's cell: a 4200 s lean deadline, and the red verify that came before the step. */
export const PANEL_START_MS = 1_700_000_000_000;
export const PANEL_CELL_MS = 4200_000;
/** The field's row: the step the cell lost BEGAN 978 s before the deadline. */
export const STEP_START_MS = PANEL_START_MS + PANEL_CELL_MS - 978_000;
/** The panel's handoff allowance, pinned by every case's env so no host default leaks in. */
export const ALLOWANCE_MS = 8 * 60_000;
/** The shipped child grace: what the bound's kill sits behind its steer before #2660. */
export const SHIPPED_GRACE_MS = 600_000;

/** Env pins every bound case runs under: the allowance and the grace it compares against are
 *  the case's numbers, and dispatch caps are on so an armed bound is an armed lever. */
export function panelEnv(over?: Record<string, string | undefined>): Record<string, string> {
  return {
    PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(ALLOWANCE_MS),
    PI_ENSEMBLE_DISPATCH_CAPS: "1",
    PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(SHIPPED_GRACE_MS),
    ...(over ?? {}),
  };
}

/** A budget row with one ceiling. */
export function budgetRow(over: Partial<Budget>): Budget {
  return { minutes: 0, turns: 0, tokens: 0, ...over };
}

/**
 * A run record whose deadline and step starts are what the case states.
 *
 * The two levers measure from different instants and this fixture keeps them distinct on
 * purpose: the child bound measures its room from `now` (the dispatch instant, so a re-arming
 * step re-measures), while the stall lever measures from the durable `startedAt` entry #2644
 * defines its window against. Most cases pass the same instant to both, which is what the
 * shipped numbers assume; a case that wants them apart passes them apart.
 */
export function ctxWith(over: {
  issue: number;
  state: string;
  now: number;
  startedAt: number;
  deadlineMs?: number;
  /** Extra states whose step entries the case wants on the log besides this one. */
  steps?: { state: string; startedAt: number }[];
}): HandlerCtx {
  const entries = [{ state: over.state, startedAt: over.startedAt }, ...(over.steps ?? [])].map(
    (s) => ({ key: `${String(over.issue)}:${s.state}:0`, ...s }),
  );
  return {
    repoRoot: "/nowhere",
    issue: over.issue,
    run: {
      schema: 1,
      issue: over.issue,
      version: "t",
      models: {},
      baseSha: "0".repeat(40),
      branch: `lean/issue-${String(over.issue)}`,
      state: over.state,
      counters: {
        buildAttempts: 0,
        specifyAttempts: 0,
        verifyAttempts: 0,
        reviewRounds: 0,
        ciAttempts: 0,
      },
      steps: entries,
      ...(over.deadlineMs === undefined ? {} : { deadlineMs: over.deadlineMs }),
    },
    steps: entries,
    stepKey: `${String(over.issue)}:${over.state}:0`,
    now: () => over.now,
  } as unknown as HandlerCtx;
}

/** What one arming produced: the arms the dispatch received, the bound's own record, and
 *  the two instants the spawn's schedule puts the steer and the kill at. */
export interface ArmedPair {
  arms: BudgetArms;
  bound: StepBound | undefined;
  /** ms from the arming instant until the child is steered to wrap up. */
  steerAtMs: number;
  /** ms from the arming instant until the child is ended; absent when a cycle clock owns the kill. */
  killAtMs: number | undefined;
  /** ms from the arming instant until the deadline passes. */
  deadlineAtMs: number | undefined;
  /** The grace the arms carry, or the configured one when nothing was derived. */
  graceMs(): number;
}

/**
 * Arm one dispatch of one state through the real `armBudget`, with the real
 * `stepChildBound` reading the real run record, and report the schedule the spawn would
 * build from those arms.
 *
 * Nothing here computes a bound. `arms.opts` is what the step hands `spawnSpecialist` and
 * `schedule` is what `armChildBounds` arms its timers with, from those same opts.
 */
export function armPairFor(
  ctx: HandlerCtx,
  state: "build" | "specify" | "challenge" | "review",
  minutes: number,
  opts?: { stall?: Parameters<typeof armBudget>[1] },
): ArmedPair {
  const full = minutes * 60_000;
  const bound = stepChildBound(ctx, full, state);
  const arms = armBudget(budgetRow({ minutes }), opts?.stall, bound);
  const schedule = childBoundScheduleFor(arms.opts, ctx.now());
  return {
    arms,
    bound,
    steerAtMs: schedule.wrapAtMs,
    killAtMs: schedule.killAtMs,
    deadlineAtMs: ctx.run.deadlineMs === undefined ? undefined : ctx.run.deadlineMs - ctx.now(),
    graceMs: () => arms.opts.childBoundGraceMs ?? childBoundGraceMs(),
  };
}

/**
 * The pair as the step armed it, read off the dispatch options the seam received.
 * `armsFor` is the fixture's recorded opts, so a case scores the deadline's arithmetic on
 * what actually left the step rather than on what the step meant to send.
 */
export function armedPairSummary(opts: BudgetOpts): {
  boundMs: number;
  graceMs: number;
  killRelativeToArmMs: number;
} {
  const boundMs = opts.childBoundMs ?? 0;
  const graceMs = opts.childBoundGraceMs ?? childBoundGraceMs();
  return { boundMs, graceMs, killRelativeToArmMs: boundMs + graceMs };
}
