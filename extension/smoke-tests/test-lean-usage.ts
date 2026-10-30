#!/usr/bin/env bun
/**
 * lean/usage-sum — what a lean run's children cost, in total and per role
 * (#1920 slice A).
 *
 * The step log now carries one cost row per dispatch on the three dispatching
 * steps, and `leanUsage` folds them into the shape the headless `work` result
 * reports (`usage` / `usage.byRole`) so a host comparing the two engines reads
 * one definition of cost. The two properties that make the fold worth trusting
 * are asserted here, and both are properties of the FOLD, not of any one step:
 *
 *   (1) `byRole` sums to `total` — a role that quietly dropped a row, or a row
 *       counted twice, breaks the invariant the host's cost comparison rests on;
 *   (2) a FAILED dispatch is counted — a child the budget stopped or the
 *       provider killed spent its tokens before anybody knew, so discounting
 *       `ok: false` would report the most expensive failures a run has as free.
 *       This mirrors `usageOf` in `headless/result.ts`, which counts a
 *       `dispatch-failed` event for exactly the same reason.
 *
 * The rows are built by hand here rather than by running a step: the steps' own
 * dispatch sites are pinned in the build / challenge / specify suites, and this
 * file's subject is the arithmetic over whatever the log holds — including a
 * log written by an older run, and one a hand-edit produced.
 */

import type { Step } from "../src/lean/state.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { type LeanUsageTotals, leanUsage } from "../src/lean/usage-sum.ts";
import { decided } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A usage report with recognizable numbers, so a sum that mixed rows is visible. */
function usage(n: number) {
  return { input: n * 10, output: n, cacheRead: n * 2, cacheWrite: n, cost: n / 8, turns: n };
}

function row(role: string, n: number, ok = true): DispatchUsageRow {
  return { role, ms: n * 1000, ok, usage: usage(n) };
}

// ------------------------------------------------------- (1) the empty log
{
  const u = leanUsage([]);
  assert(
    u.total.dispatches === 0 && u.total.input === 0 && Object.keys(u.byRole).length === 0,
    "(1) a log with no dispatches reports zero, not undefined",
  );
  assert(
    u.total.cost === 0 && u.total.turns === 0,
    "(1) every field is a number a JSON document can carry",
  );
}

// --------------------------------- (2) steps with no `dispatches` key are skipped
{
  const steps = [decided("ready", { kind: "ok" }), decided("verify", { kind: "green" })];
  const u = leanUsage(steps);
  assert(u.total.dispatches === 0, "(2) steps that dispatch nothing contribute nothing");
}

// ------------------------------- (3) byRole sums to total, across steps and roles
{
  const steps = [
    decided("specify", { kind: "ok", dispatches: [row("developer", 1)] }),
    decided("build", {
      kind: "ok",
      // Two children in one step's row list: a fold that overwrote the role row
      // instead of adding to it would report one dispatch here.
      dispatches: [row("developer", 2), row("adversary", 3)],
    }),
    decided("challenge", { kind: "none", dispatches: [row("developer", 4)] }),
  ];
  const u = leanUsage(steps);
  assert(u.total.dispatches === 4, `(3) every dispatch is counted (got ${u.total.dispatches})`);
  const summed = (field: keyof LeanUsageTotals): number =>
    Object.values(u.byRole).reduce((a, r) => a + r[field], 0);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
    assert(
      summed(field) === u.total[field],
      `(3) byRole sums to total for ${field} (roles ${String(summed(field))}, total ${String(u.total[field])})`,
    );
  }
  assert(
    Object.values(u.byRole).reduce((a, r) => a + r.dispatches, 0) === u.total.dispatches,
    "(3) the per-role dispatch counts sum to the total count too",
  );
  assert(
    u.byRole.developer?.dispatches === 3 && u.byRole.adversary?.dispatches === 1,
    `(3) each role counts only its own rows (developer ${String(u.byRole.developer?.dispatches)}, adversary ${String(u.byRole.adversary?.dispatches)})`,
  );
  assert(
    u.byRole.developer?.input === 70,
    `(3) a role's usage is the sum over its steps, not one step's (got ${String(u.byRole.developer?.input)})`,
  );
}

// --------------------------- (4) a FAILED dispatch counts, and so does a stopped one
{
  const steps = [
    decided("build", {
      kind: "exhausted",
      reason: "the developer produced no change",
      dispatches: [row("developer", 5, false)],
    }),
    decided("challenge", {
      kind: "budget",
      limit: "minutes",
      value: 20,
      used: 21,
      dispatches: [row("developer", 6, false)],
    }),
  ];
  const u = leanUsage(steps);
  assert(
    u.total.dispatches === 2 && u.total.input === 110,
    `(4) a failed or budget-stopped child is counted, not discounted (got ${u.total.dispatches} dispatches, input ${u.total.input})`,
  );
  assert(
    u.byRole.developer?.dispatches === 2,
    `(4) and it lands in its role's row (got ${String(u.byRole.developer?.dispatches)})`,
  );
}

// --------------------- (5) the fold reads the LOG, so a resumed run totals once
{
  // A resumed run re-uses the log: an earlier `build:0` outcome and the re-run's
  // `build:1` are both entries, and each records its own child. Discounting one
  // would tell the host the run paid for one round when it paid for two.
  const steps = [
    decided("build", { kind: "exhausted", dispatches: [row("developer", 1)] }, 0),
    decided("build", { kind: "ok", dispatches: [row("developer", 1)] }, 1),
  ];
  const u = leanUsage(steps);
  assert(
    u.total.dispatches === 2 && u.total.input === 20,
    `(5) every logged attempt of one state counts (got ${u.total.dispatches}, input ${u.total.input})`,
  );
}

process.exit(exit);
