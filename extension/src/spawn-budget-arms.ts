/**
 * spawn-budget-arms — a child's own bounds, armed as one thing (#1560, #1991).
 *
 * `spawnSpecialist` gives a child two kinds of bound and they must be armed
 * from one place, because a child that can see its deadline and a deadline that
 * ends it are the same number read twice:
 *
 *   - the per-child RUN BOUND (`armChildBound`, spawn-child-bound.ts): the wall
 *     clock that steers the child to wrap up and then ends it. The child never
 *     sees this one coming; it just arrives.
 *   - the budget-PROGRESS steer (#1991, budget-progress.ts): the same bound
 *     announced in advance, at half ("turn 20 of 40") and again at close-out
 *     ("commit your work now" / "report your findings now"). This is the half of
 *     the fix that costs the child nothing — a child told where it stands stops
 *     overrunning it, which is what the corpus of overrunners never did.
 *
 * Arming them together is what keeps the pair honest. Both read the same
 * `childBoundSchedule`, anchored at the spawn's `start`, so the minutes the
 * child reads are the minutes the bound will actually grant — including under a
 * cycle-deadline clamp, which shortens both or neither. And both decide "can
 * this child commit?" from the same `(role, cwd)` pair, so the close-out steer
 * never tells a child to commit into a tree it does not own, and the run bound's
 * done-signal never credits a commit it could not have made.
 *
 * The steer is ON whenever a bound is armed, whatever the role and whatever the
 * path: the motivating overrunners were lens children burning twenty minutes on
 * a 20-line diff and a build child killed at 401/400 turns, and neither is a
 * developer with a driver-supplied bound. A caller that already paces a child
 * some other way (a deck-steered driver child) passes `budgetProgress: false`.
 *
 * Split out of `spawn.ts` for the §12 size cap, which that file sits against.
 */

import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { type BudgetProgressSteer, budgetProgressClock, createBudgetProgressSteer } from "./budget-progress.ts";
import type { SteerSource } from "./dispatch-steer.ts";
import { type ChildBound, armChildBound, childBoundGraceMs, childBoundSchedule } from "./spawn-child-bound.ts";
import { childHasExited } from "./spawn-support.ts";

/** The bound options the two arms read, as `SpawnOptions` declares them. */
export interface SpawnBudgetOpts {
  /** #1991 — the denominator the progress steer reports against. A turns
   *  breach is ended by the caller's abort, not here, so this lever paces. */
  budgetTurns?: number;
  /** #1560 — the run bound's ms. The lever that both paces and stops. */
  childBoundMs?: number;
  /** The registry id the progress steer delivers through when the caller has no
   *  steer seam of its own but registered a handle (a lens child's deck key). */
  budgetSteerDeckKey?: string;
  /** False stands the progress steer off for a child the caller paces some
   *  other way. Absent means ON, which is the point of #1991. */
  budgetProgress?: boolean;
  /** The driver's steer seam; without one both advisories go to `stdin`. */
  onSteer?: (message: string, source: SteerSource) => void;
}

export interface ChildBounds {
  /** The run bound: wrap-up steer, then the end. `stop()` in the spawn's `finally`. */
  childBound: ChildBound;
  /** The progress steer. `stop()` in the spawn's `finally`. */
  budgetProgress: BudgetProgressSteer & {
    /** True when this spawn armed at least one lever, i.e. the #546 nudge is off. */
    armed: () => boolean;
  };
}

/** A child that can commit: a developer with a tree of its own. One definition,
 * read by both arms — the wrap-up steer's done-signal and the close-out
 * instruction must agree or one of them lies. */
function commitsWork(spec: { role: string; cwd?: string }): boolean {
  return spec.role === "developer" && spec.cwd !== undefined;
}

/**
 * Arm both of a child's bounds. Cheap and side-effect-free apart from the
 * timers `armChildBound` starts, all of which the returned `stop()` clears.
 */
export function armChildBounds(o: {
  spec: { role: string; cwd?: string };
  opts: SpawnBudgetOpts;
  child: ChildProcess;
  /** The spawn's shared supervisor flags — the object every watcher of this
   *  child reads, so all of them agree on whether it still lives. */
  flags: {
    childExited: () => boolean;
    aborted: () => boolean;
    timedOut: () => boolean;
    inactivityKilled: () => boolean;
    toolInactivityKilled: () => boolean;
  };
  /** The spawn's effective cwd, which the run bound shells out to for its
   *  committed-work check (it is NOT `spec.cwd`, which may be unset). */
  cwd: string;
  stdin: Writable;
  /** The spawn's start, so both bounds count the child's whole life. */
  start: number;
  /** #1827 — true once a DIFFERENT killing bound has armed. Both advisories
   *  stand down on it: a child that is already being ended needs no advice. */
  boundArmed: () => boolean;
  /** The prompt's `agent_end` arrived (the spawn's `promptCompleted`). */
  reported: () => boolean;
  onSteer?: (message: string, source: SteerSource) => void;
}): ChildBounds {
  const childBound = armChildBound({
    child: o.child,
    boundMs: o.opts.childBoundMs,
    cwd: o.cwd,
    onSteer: o.onSteer,
    stdin: o.stdin,
    reported: o.reported,
    childExited: o.flags.childExited, // #1847 — the same seam every supervisor uses.
    preempted: () =>
      o.flags.aborted() ||
      o.flags.timedOut() ||
      o.flags.inactivityKilled() ||
      o.flags.toolInactivityKilled(),
    commits: commitsWork(o.spec),
    boundArmed: o.boundArmed,
  });

  const turns = o.opts.budgetTurns;
  const boundMs = o.opts.budgetProgress === false ? undefined : o.opts.childBoundMs;
  const turnsArmed = o.opts.budgetProgress === false ? false : turns !== undefined && turns > 0;
  const minutesArmed = boundMs !== undefined && boundMs > 0;
  // The minutes lever comes from the run bound's OWN schedule function, asked
  // at the spawn's `start` — the same call `armChildBound` makes. Asking it at
  // any later instant would shorten the child's bound by the time between spawn
  // and here, and a bound clamped to a deadline the run no longer has makes the
  // advice lie about the time left: the exact failure #1991 exists to close, in
  // its worst form, because the child would then trust the number.
  const clock = minutesArmed
    ? budgetProgressClock(childBoundSchedule(boundMs ?? 0, childBoundGraceMs(), o.start), o.start)
    : undefined;

  const steer = createBudgetProgressSteer({
    role: o.spec.role,
    commits: commitsWork(o.spec),
    ...(turnsArmed ? { turns } : {}),
    ...(clock === undefined ? {} : { clock }),
    ...(o.opts.onSteer ? { onSteer: o.opts.onSteer } : {}),
    ...(o.opts.budgetSteerDeckKey ? { deckKey: o.opts.budgetSteerDeckKey } : {}),
    stdin: o.stdin,
    boundArmed: o.boundArmed,
    // The project's ONE liveness predicate, asked the way every other
    // supervisor of this child asks it. Advice to a child that is already gone
    // is noise written to a pipe nobody is reading.
    exited: () => childHasExited(o.flags, o.child),
  });
  const active = turnsArmed || minutesArmed;
  return {
    childBound,
    budgetProgress: { ...steer, armed: () => active },
  };
}
