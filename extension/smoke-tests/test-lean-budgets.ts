#!/usr/bin/env bun
/**
 * lean/step-budget — the `.pi/work.json` ceilings actually bind a step (#1883).
 *
 * `WorkConfig.budgets` was read by nothing until #1883, so every budget in this
 * file is a regression test against that silence: a case that would pass with
 * the module deleted is a case that proves nothing.
 *
 * Two layers.
 *
 *   1. `armBudget` alone — the three levers and the reader. `turns` and `tokens`
 *      are seen through `onProgress` (the same callback `spawn.ts` calls once per
 *      child turn) and are asserted to have ABORTED the signal, not merely
 *      recorded a number: an armed budget that never aborts is a stopwatch.
 *      `minutes` is seen through the `killCause` the wall clock leaves behind,
 *      because that lever is enforced by the child-bound machinery and not here.
 *   2. The `build` STEP — one case through the real fixture, where the fake
 *      child calls `onProgress` past its ceiling and the step must return
 *      `{kind: "budget"}` instead of throwing the infra throw every other dead
 *      child earns, and must commit nothing.
 *
 * The config half matters as much as the enforcement half: `budgetFor` is the
 * only reader of `WorkConfig.budgets`, so a `.pi/work.json` override that never
 * reaches `armBudget` is the same bug as `armBudget` ignoring it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunningState } from "../src/progress.ts";
import { defaultConfig } from "../src/lean/config.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import type { Budget } from "../src/lean/config.ts";
import { armBudget, budgetFor } from "../src/lean/step-budget.ts";
import type { DispatchResult } from "../src/types.ts";
import { buildFixture, configWithRunner, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A result carrying only what the reader looks at. */
function resultWith(over: Partial<DispatchResult>): DispatchResult {
  return { role: "developer", ok: true, text: "", toolUses: [], ms: 0, exitCode: 0, ...over };
}

/** The progress snapshot `spawn.ts` would hand `onProgress` at one turn end. */
function progress(over: Partial<RunningState>): RunningState {
  return {
    role: "developer",
    turns: 0,
    toolUses: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    totalTokens: 0,
    elapsedMs: 0,
    done: false,
    ...over,
  };
}

// ── (1) a turns breach stops the child, not just the record ────────────────
{
  const b = armBudget({ turns: 5, tokens: 0, minutes: 0 });
  assert(b.opts.onProgress !== undefined, "a turns budget arms an onProgress");
  assert(b.opts.signal !== undefined, "a turns budget arms a signal");
  assert(b.opts.childBoundMs === undefined, "a turns budget with minutes 0 sets no wall clock");
  b.opts.onProgress?.(progress({ turns: 3 }));
  assert(b.fired(resultWith({})) === undefined, "3 turns under a 5-turn ceiling has not fired");
  assert(b.opts.signal?.aborted === false, "and the child is not aborted");
  b.opts.onProgress?.(progress({ turns: 6 }));
  const fired = b.fired(resultWith({}));
  assert(fired?.limit === "turns", `the breach reads back as turns (got ${fired?.limit})`);
  assert(fired?.value === 5, `the value is the ceiling (got ${fired?.value})`);
  assert(fired?.used === 6, `the used amount is what the child reported (got ${fired?.used})`);
  assert(b.opts.signal?.aborted === true, "the breach aborts the child's signal");
}

// ── (2) a tokens breach ─────────────────────────────────────────────────────
{
  const b = armBudget({ turns: 0, tokens: 1_000_000, minutes: 0 });
  b.opts.onProgress?.(progress({ turns: 1, totalTokens: 900_000 }));
  assert(b.fired(resultWith({})) === undefined, "under the token ceiling has not fired");
  b.opts.onProgress?.(progress({ turns: 2, totalTokens: 1_500_000 }));
  const fired = b.fired(resultWith({}));
  assert(fired?.limit === "tokens", `the breach reads back as tokens (got ${fired?.limit})`);
  assert(fired?.value === 1_000_000, `the value is the ceiling (got ${fired?.value})`);
  assert(fired?.used === 1_500_000, `the used amount is cumulative (got ${fired?.used})`);
  assert(b.opts.signal?.aborted === true, "the breach aborts the child's signal");
}

// ── (3) minutes, via the child-bound kill cause ────────────────────────────
{
  const b = armBudget({ turns: 0, tokens: 0, minutes: 20 });
  assert(b.opts.childBoundMs === 1_200_000, `20 minutes is 1_200_000ms (got ${b.opts.childBoundMs})`);
  assert(b.opts.onProgress === undefined, "a minutes-only budget needs no progress hook");
  assert(b.opts.signal === undefined, "and no abort signal — the bound is the child's own");
  const killed = resultWith({ killCause: "child-bound", ok: false, ms: 20 * 60_000 + 9_000 });
  const fired = b.fired(killed);
  assert(fired?.limit === "minutes", `the bound's kill reads as minutes (got ${fired?.limit})`);
  assert(fired?.value === 20, `the value is the configured minutes (got ${fired?.value})`);
  assert(fired?.used === 20, `the used amount is the elapsed minutes, rounded (got ${fired?.used})`);
}

// ── (4) no breach: neither a clean result nor another cap reads as the budget
{
  const b = armBudget({ turns: 10, tokens: 1000, minutes: 10 });
  b.opts.onProgress?.(progress({ turns: 2, totalTokens: 10 }));
  assert(b.fired(resultWith({})) === undefined, "a clean child fires nothing");
  assert(
    b.fired(resultWith({ killCause: "timeout", ok: false })) === undefined,
    "someone else's kill cause is not this step's budget",
  );
  assert(b.opts.signal?.aborted === false, "and the signal stays unarmed");
}

// ── (5) a zero budget sets no opts at all ──────────────────────────────────
{
  const zero = armBudget({ turns: 0, tokens: 0, minutes: 0 });
  assert(Object.keys(zero.opts).length === 0, `a zero budget sets no opts (got ${JSON.stringify(zero.opts)})`);
  assert(
    zero.fired(resultWith({ killCause: "child-bound", ok: false })) === undefined,
    "and the child-bound cause is not attributed to a zero-minute budget",
  );
  const none = armBudget(undefined);
  assert(Object.keys(none.opts).length === 0, "a state with no budget sets no opts");
  assert(none.fired(resultWith({ killCause: "child-bound" })) === undefined, "nor a verdict");
}

// ── (6) the FIRST limit wins, and a later tick cannot rewrite it ───────────
{
  const b = armBudget({ turns: 5, tokens: 1000, minutes: 0 });
  // One tick that breaches both ceilings at once: turns is checked first, and
  // which limit fired is the truest fact the step can report.
  b.opts.onProgress?.(progress({ turns: 9, totalTokens: 5000 }));
  assert(b.fired(resultWith({}))?.limit === "turns", "the first limit to fire is the one recorded");
  b.opts.onProgress?.(progress({ turns: 50, totalTokens: 900_000 }));
  assert(b.fired(resultWith({}))?.limit === "turns", "a later tick does not overwrite it");
}

// ── (7) the build STEP turns a breach into a verdict, not a throw ──────────
{
  // The default build ceiling is 150 turns, so a case that wants a breach has
  // to say the child went past THAT rather than past a number it chose — which
  // is also the more useful assertion: it proves the step armed the config's
  // own budget and not some other figure.
  // The config is the one the STEP reads, so the number the verdict carries is
  // the one the config set — which is the whole claim of this case.
  const buildTurns = 3;
  assert(defaultConfig().budgets.build?.turns === 150, "the shipped default stays 150 turns");
  const r = await runBuild({
    issue: 201,
    exactConfig: {
      ...configWithRunner(),
      budgets: { ...defaultConfig().budgets, build: { turns: 3, tokens: 0, minutes: 0 } },
    },
    child: (wt) => {
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => 1;\n");
    },
    // The child's own progress feed, driven from the fake dispatch: the same
    // call `spawn.ts` makes at every `message_end`.
    onProgressTick: (onProgress) =>
      onProgress?.(progress({ turns: 999, totalTokens: 0 })),
  });
  assert(r.threw === undefined, `(7) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "budget", `(7) the outcome kind is budget (got ${r.outcome?.kind})`);
  assert(
    (r.outcome?.reason ?? "").includes("turns"),
    `(7) the reason names the limit (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("build stopped"),
    `(7) the reason names the step (got ${r.outcome?.reason})`,
  );
  assert(r.outcome?.limit === "turns", `(7) the limit field is carried (got ${r.outcome?.limit})`);
  assert(
    r.outcome?.value === buildTurns,
    `(7) the value is the CONFIG's ceiling, not an invented one (got ${r.outcome?.value})`,
  );
  assert(r.outcome?.used === 999, `(7) the used amount is what the child hit (got ${r.outcome?.used})`);
  assert(r.dispatched === 1, `(7) the child was dispatched once (got ${r.dispatched})`);
  assert(
    r.headBefore === r.headAfter,
    "(7) nothing was committed after the breach — the tree is left as the child found it",
  );
}

// ── (8) a budget that does not bind the step is not a verdict ──────────────
{
  const r = await runBuild({ issue: 202, child: undefined });
  assert(
    r.outcome?.kind === "exhausted",
    `(8) with no breach the honest child still reports exhausted (got ${r.outcome?.kind})`,
  );
}

// ── (9) a `.pi/work.json` override reaches armBudget through budgetFor ─────
{
  // The whole path a config takes: bytes in `.pi/work.json` → `loadWorkConfig`
  // merges them over the defaults → `budgetFor` picks the state's entry → the
  // numbers that arrive at `armBudget`. Every link is one the step uses; a
  // config the loader dropped or a state name typed wrong ends this assertion
  // red, which is the same failure an operator would otherwise discover as an
  // unbounded child.
  const built = buildFixture(203);
  const cfgPath = path.join(built.repoRoot, ".pi", "work.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({ version: 1, budgets: { build: { turns: 7, tokens: 42, minutes: 3 } } }),
  );
  const onDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as WorkConfig;
  const merged: WorkConfig = {
    ...defaultConfig(),
    budgets: { ...defaultConfig().budgets, ...(onDisk.budgets ?? {}) },
  };
  const b = budgetFor(merged, "build") as Budget;
  assert(b.turns === 7, `the override's turns reach the step (got ${b.turns})`);
  assert(b.tokens === 42, `the override's tokens reach the step (got ${b.tokens})`);
  assert(b.minutes === 3, `the override's minutes reach the step (got ${b.minutes})`);
  const armed = armBudget(b);
  assert(armed.opts.childBoundMs === 180_000, `3 minutes armed as 180000ms (got ${armed.opts.childBoundMs})`);
  armed.opts.onProgress?.(progress({ turns: 8, totalTokens: 0 }));
  assert(
    armed.fired(resultWith({}))?.limit === "turns",
    "and the overridden turns ceiling is the one that fired",
  );
  assert(
    budgetFor(merged, "specify")?.turns === 80,
    "an unoverridden state keeps its default rather than the override",
  );
  assert(budgetFor(merged, "no-such-state") === undefined, "an unknown state has no budget");
}

// ── (10) the machine routes a breach to handback, like an exhausted build ──
{
  const { hasTransition, next } = await import("../src/lean/machine.ts");
  const { INITIAL_COUNTERS } = await import("../src/lean/state.ts");
  const run = (state: string) => ({
    schema: 1 as const,
    issue: 1,
    version: "t",
    models: {},
    baseSha: "s",
    branch: "b",
    state: state as never,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
  });
  for (const state of ["specify", "build", "challenge"]) {
    assert(hasTransition(state as never, "budget"), `${state} + budget is in the table`);
    const moved = next(run(state) as never, { kind: "budget" } as never);
    assert(
      (moved as { state: string }).state === "handback",
      `${state} + budget routes to handback (got ${(moved as { state: string }).state})`,
    );
  }
  const { exitCodeFor } = await import("../src/lean/machine.ts");
  assert(exitCodeFor("handed-back" as never) === 10, "a budget handback exits 10");
}

// ── (11) the handback comment says the budget, not an older red ────────────
{
  const { neededFromLog } = await import("../src/lean/handback.ts");
  const steps = [
    {
      key: "1:verify:0",
      state: "verify" as const,
      startedAt: 1,
      outcome: { kind: "red", reason: "AC1 exited 1 — retry gave up" },
    },
    {
      key: "1:build:0",
      state: "build" as const,
      startedAt: 2,
      outcome: {
        kind: "budget",
        limit: "turns" as const,
        value: 3,
        used: 999,
        reason: "build stopped: turns budget 3 exceeded (used 999)",
      },
    },
  ];
  const needed = neededFromLog(steps);
  assert(needed.includes("turns budget 3"), `the comment names the budget (got ${needed})`);
  assert(
    !needed.includes("retry gave up"),
    `the older red does not drown the budget (got ${needed})`,
  );
}

process.exit(exit);
