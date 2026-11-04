/**
 * #1991 — the harness both `armChildBounds` wiring suites share.
 *
 * `test-budget-progress-wiring.ts` pins the tool boundary (validation, the
 * schemas, and the source-text assertions that the levers really reach the
 * spawn); `test-budget-progress-arm.ts` pins the arm's runtime behaviour on a
 * live child. Both call `armChildBounds` exactly the way `spawnSpecialist`
 * does, and getting that call shape wrong is the one way a wiring suite can
 * pass while steering nothing — so it lives here, once.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BudgetProgressSteer } from "../../src/budget-progress.ts";
import type { SteerDelivery, SteerSource } from "../../src/dispatch-steer.ts";
import { type SpawnBudgetOpts, armChildBounds } from "../../src/spawn-budget-arms.ts";

export type { SteerSource };

/** Collect everything a PassThrough has been written. */
export function capture(): { stdin: PassThrough; text: () => string; lines: () => string[] } {
  const stdin = new PassThrough();
  let text = "";
  stdin.on("data", (d) => {
    text += String(d);
  });
  return {
    stdin,
    text: () => text,
    lines: () => text.split("\n").filter(Boolean),
  };
}

export interface ArmArgs {
  role: string;
  cwd?: string;
  stdin: PassThrough;
  start?: number;
  deckKey?: string;
  boundArmed?: () => boolean;
  exited?: boolean;
  /** The caller's steer seam. `spawnSpecialist` hands the SAME seam at the top
   *  level and inside `opts` (spawn.ts passes `opts` plus `onSteer: opts.onSteer`);
   *  the arm reads the one in `opts`, `armChildBound` the top one, so a harness
   *  that set only one of them would silently exercise the wrong delivery path. */
  onSteer?: SteerDelivery;
  opts: SpawnBudgetOpts;
}

/** The arm, called the way `spawnSpecialist` calls it: a spec, a live child, the
 * shared liveness flags, the stdin, and the caller's bound options. A child with
 * no exit state and no flag set is alive, which is the state every steer in
 * these suites is asserted against. */
export function armChild(o: ArmArgs): BudgetProgressSteer & { armed: () => boolean } {
  const child = new EventEmitter() as never;
  const opts: SpawnBudgetOpts =
    o.deckKey === undefined
      ? o.opts
      : // The arm reads its registry id out of the caller's options, the same
        // shape `SpawnOptions` declares, because that is where a lens child's
        // deck key lives.
        { ...o.opts, budgetSteerDeckKey: o.deckKey };
  return armChildBounds({
    spec: o.cwd === undefined ? { role: o.role } : { role: o.role, cwd: o.cwd },
    opts: o.onSteer === undefined ? opts : { ...opts, onSteer: o.onSteer },
    ...(o.onSteer === undefined ? {} : { onSteer: o.onSteer }),
    child,
    flags: {
      childExited: () => o.exited === true,
      aborted: () => false,
      timedOut: () => false,
      inactivityKilled: () => false,
      toolInactivityKilled: () => false,
    },
    cwd: o.cwd ?? process.cwd(),
    stdin: o.stdin,
    start: o.start ?? 0,
    boundArmed: o.boundArmed ?? (() => false),
    reported: () => false,
  }).budgetProgress;
}

/** Pin env vars for a synchronous body, restoring exactly what was there
 *  (an absent variable is deleted again). The caps master switch is read per
 *  call, so a block that needs it off must not leak it into the next one. */
export const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
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

/** A tiny assert/eq pair, so each suite reports its own failures under its own
 *  exit code rather than sharing a runner. */
export function makeCheck(): {
  assert: (cond: boolean, msg: string) => void;
  eq: (actual: unknown, expected: unknown, msg: string) => void;
  exitCode: () => number;
} {
  let exit = 0;
  const assert = (cond: boolean, msg: string): void => {
    if (cond) console.log(`✓ ${msg}`);
    else {
      console.error(`✗ ${msg}`);
      exit = 1;
    }
  };
  return {
    assert,
    eq: (actual, expected, msg) => {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a === e) assert(true, msg);
      else {
        console.error(`  expected: ${e}\n  actual:   ${a}`);
        assert(false, msg);
      }
    },
    exitCode: () => exit,
  };
}
