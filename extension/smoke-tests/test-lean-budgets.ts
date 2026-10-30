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
import { DEFAULT_BUDGETS, defaultConfig } from "../src/lean/config.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import type { Budget } from "../src/lean/config.ts";
import type { RunCounters } from "../src/lean/state.ts";
import { armBudget, budgetFor, budgetStop, readDispatched } from "../src/lean/step-budget.ts";
import type { BudgetStop } from "../src/lean/step-budget.ts";
import type { RunningState } from "../src/progress.ts";
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
  // The hook never throws into spawn's stdout path: an internal failure is
  // swallowed after one trace line, because a budget that cannot report itself
  // must not take the child down with it — and it must NOT abort either, since
  // nothing proved the child was over its ceiling.
  let ticks = 0;
  const guarded = armBudget({ turns: 1, tokens: 0, minutes: 0 });
  let hookThrew = false;
  try {
    // A `RunningState` whose comparison throws (a getter-backed snapshot from a
    // malformed child line) is the failure this guards.
    guarded.opts.onProgress?.({
      ...progress({}),
      get turns(): number {
        ticks++;
        throw new Error("bad child line");
      },
    } as RunningState);
  } catch {
    hookThrew = true;
  }
  assert(hookThrew === false, "a throwing progress hook does not propagate to the caller");
  assert(ticks > 0, "and the hook was actually entered");
  assert(
    guarded.opts.signal?.aborted === false,
    "a hook that threw while READING the snapshot did not abort the child",
  );
}

// ── (1b) a real breach still aborts when the trace sink itself throws ───────
{
  const b = armBudget({ turns: 2, tokens: 0, minutes: 0 });
  const originalWrite = process.stderr.write;
  // The sink itself is the probe: while the hook is inside its trace call it has
  // already aborted, and the only way to read the signal AT that moment is from
  // the sink. If that state were wrong, the hook's own catch would be writing
  // this line — so the probe also proves the abort precedes the trace.
  let abortedInsideTrace: boolean | undefined;
  let reachedSink = 0;
  let escaped = false;
  try {
    process.stderr.write = ((chunk: unknown): boolean => {
      if (typeof chunk !== "string" || !chunk.includes("lean budget:")) return true;
      reachedSink++;
      abortedInsideTrace = b.opts.signal?.aborted;
      throw new Error("stderr is closed");
    }) as typeof process.stderr.write;
    // The breach is real (3 turns against a ceiling of 2).
    try {
      b.opts.onProgress?.(progress({ turns: 3 }));
    } catch {
      escaped = true;
    }
    assert(reachedSink > 0, "and the case really reached a throwing trace sink");
    assert(
      abortedInsideTrace === true,
      `the child was already aborted INSIDE the trace call (got ${String(abortedInsideTrace)})`,
    );
    assert(escaped === false, "a breach whose trace line throws does not escape the hook");
    assert(b.opts.signal?.aborted === true, "and the breach still aborted the child");
    const fired = b.fired(resultWith({}));
    assert(fired?.limit === "turns", `the breach still reads back as turns (got ${fired?.limit})`);
  } finally {
    process.stderr.write = originalWrite;
  }
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
  assert(
    b.opts.childBoundMs === 1_200_000,
    `20 minutes is 1_200_000ms (got ${b.opts.childBoundMs})`,
  );
  assert(b.opts.onProgress === undefined, "a minutes-only budget needs no progress hook");
  assert(b.opts.signal === undefined, "and no abort signal — the bound is the child's own");
  const killed = resultWith({ killCause: "child-bound", ok: false, ms: 20 * 60_000 + 9_000 });
  const fired = b.fired(killed);
  assert(fired?.limit === "minutes", `the bound's kill reads as minutes (got ${fired?.limit})`);
  assert(fired?.value === 20, `the value is the configured minutes (got ${fired?.value})`);
  assert(
    fired?.used === 21,
    `the used amount is the elapsed minutes rounded UP, never short (got ${fired?.used})`,
  );
  const justOver = armBudget({ turns: 0, tokens: 0, minutes: 20 }).fired(
    resultWith({ killCause: "child-bound", ok: false, ms: 19 * 60_000 + 59_000 }),
  );
  assert(
    justOver?.used === 20,
    `a kill at 19:59 reports 20 minutes used, not 19 (got ${justOver?.used})`,
  );
  const noMs = armBudget({ turns: 0, tokens: 0, minutes: 20 }).fired(
    resultWith({ killCause: "child-bound", ok: false }),
  );
  assert(noMs?.used === 1, `a kill with no ms never reports 0 (got ${noMs?.used})`);
}

// ── (3b) one minutes stop is one trace line, however often it is read ──────
{
  const b = armBudget({ turns: 0, tokens: 0, minutes: 20 });
  const originalWrite = process.stderr.write;
  const lines: string[] = [];
  try {
    process.stderr.write = ((chunk: unknown): boolean => {
      if (typeof chunk === "string" && chunk.includes("lean budget: minutes")) lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    const killed = resultWith({ killCause: "child-bound", ok: false, ms: 20 * 60_000 + 9_000 });
    const reads = [b.fired(killed), b.fired(killed)];
    assert(
      reads.every((f) => f?.limit === "minutes") && lines.length === 1,
      `two reads of one minutes stop print exactly one trace line (got ${lines.length})`,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
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
  assert(
    Object.keys(zero.opts).length === 0,
    `a zero budget sets no opts (got ${JSON.stringify(zero.opts)})`,
  );
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
  // The default build ceiling is whatever `DEFAULT_BUDGETS` says, so a case
  // that wants a breach has to say the child went past THAT rather than past a
  // number it chose — which is also the more useful assertion: it proves the
  // step armed the config's own budget and not some other figure.
  // The config is the one the STEP reads, so the number the verdict carries is
  // the one the config set — which is the whole claim of this case.
  const BUILD_TURNS = 3;
  assert(
    defaultConfig().budgets.build?.turns === DEFAULT_BUDGETS.build?.turns,
    "the shipped default is the one DEFAULT_BUDGETS declares",
  );
  const r = await runBuild({
    issue: 201,
    config: {
      ...configWithRunner(),
      budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
    },
    child: (wt) => {
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => 1;\n");
    },
    // The child's own progress feed, driven from the fake dispatch: the same
    // call `spawn.ts` makes at every `message_end`. One turn past the single
    // ceiling this case sets, so no second number can drift from the first.
    onProgressTick: (onProgress) =>
      onProgress?.(progress({ turns: BUILD_TURNS + 1, totalTokens: 0 })),
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
    r.outcome?.value === BUILD_TURNS,
    `(7) the value is the CONFIG's ceiling, not an invented one (got ${r.outcome?.value})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(String(BUILD_TURNS + 1)),
    `(7) the reason carries the overshoot (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.used === BUILD_TURNS + 1,
    `(7) the used amount is what the child hit (got ${r.outcome?.used})`,
  );
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
  assert(
    armed.opts.childBoundMs === 180_000,
    `3 minutes armed as 180000ms (got ${armed.opts.childBoundMs})`,
  );
  armed.opts.onProgress?.(progress({ turns: 8, totalTokens: 0 }));
  assert(
    armed.fired(resultWith({}))?.limit === "turns",
    "and the overridden turns ceiling is the one that fired",
  );
  assert(
    budgetFor(merged, "specify")?.turns === DEFAULT_BUDGETS.specify?.turns,
    "an unoverridden state keeps its default rather than the override",
  );
  // A state the run can sit in but has no budget for: the lookup is keyed on
  // `LeanState`, so an unknown key is a type error rather than a silent `undefined`.
  assert(budgetFor(merged, "verify") === undefined, "a state with no budget entry has none");
}

// ── (10) the machine routes a breach: specify/build hand back, challenge does not ──
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
  // A ceiling hit BEFORE the contract exists, or with the builder's work still
  // in its tree, ends the run: there is nothing verified to hand on.
  for (const state of ["specify", "build"]) {
    assert(hasTransition(state as never, "budget"), `${state} + budget is in the table`);
    const moved = next(run(state) as never, { kind: "budget" } as never);
    assert(
      (moved as { state: string }).state === "handback",
      `${state} + budget routes to handback (got ${(moved as { state: string }).state})`,
    );
  }
  // A ceiling hit in the OPTIONAL challenge round does not: the contract is
  // already frozen and `verify` still runs every test of it (#1883).
  assert(hasTransition("challenge" as never, "budget"), "challenge + budget is in the table");
  const challenged = next(run("challenge") as never, { kind: "budget" } as never) as {
    state: string;
    counters: RunCounters;
  };
  assert(
    challenged.state === "verify",
    `challenge + budget routes to verify, not handback (got ${challenged.state})`,
  );
  assert(
    challenged.counters.challengeDone === true,
    `and the round is spent, exactly as a challenge that added no tests (got ${JSON.stringify(challenged.counters)})`,
  );
  const { exitCodeFor } = await import("../src/lean/machine.ts");
  assert(exitCodeFor("handed-back" as never) === 10, "a budget handback exits 10");
}

// The handback comment's choice of cause — a breach newer than every verdict
// versus one the table carried past — is `handback.ts`'s own claim and lives in
// `test-lean-handback-cause.ts`.

// ── (12) only a stop this module made is a budget verdict ─────────────────
{
  // The stop used to be a plain object with a `leanBudgetStop: true` field, so
  // ANY object carrying that field — a child tool result, a replayed JSON
  // payload, a `JSON.parse` of a stored result — read as this step's verdict and
  // routed the run to handback for a ceiling that never fired. A symbol key
  // cannot be minted from JSON and cannot be forged by a child: only
  // {@link budgetStop} makes one, so the canary is that neither lookalike reads.
  const lookalike = {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 0,
    exitCode: 0,
    fired: { limit: "turns", value: 1, used: 99 },
    leanBudgetStop: true,
  } as unknown as DispatchResult | BudgetStop;
  const forged = JSON.parse(
    '{"fired":{"limit":"turns","value":1,"used":99},"leanBudgetStop":true}',
  ) as unknown as DispatchResult | BudgetStop;
  assert("result" in readDispatched(lookalike), "a plain object carrying `fired` is not a verdict");
  assert(
    "result" in readDispatched(forged),
    "a JSON payload carrying the old tag is not a verdict",
  );
  const real = readDispatched(budgetStop({ limit: "turns", value: 1, used: 99 }));
  assert("stop" in real && real.stop.limit === "turns", "a stop built by the factory reads back");
  const clean = readDispatched(resultWith({ toolUses: [1, 2] }));
  assert(
    "result" in clean && clean.result.toolUses?.length === 2,
    "and a clean result hands back its tool uses through the same reader",
  );
}

// ── (13) an inert minutes lever says so ──────────────────────────────────
{
  // `armChildBound` returns early under `PI_ENSEMBLE_DISPATCH_CAPS=0`, so a
  // minutes budget armed in that environment binds nothing. The step must be
  // TOLD (the `warning` it traces) and must not invent a verdict the disabled
  // runtime could never have produced. Read the switch at ENTRY and restore it
  // on the way out: an inherited value must not linger as the literal string
  // "undefined" and poison the clean assertion below (the env-clear ratchet
  // keeps `delete` as the only correct unset).
  const priorCaps = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  try {
    const b = armBudget({ turns: 0, tokens: 0, minutes: 20 });
    assert(
      b.opts.childBoundMs === 1_200_000,
      "the bound is still armed (the switch is the child's)",
    );
    assert(
      (b.warning ?? "").includes("20-minute budget is inert"),
      `the warning names the inert lever (got ${JSON.stringify(b.warning)})`,
    );
    assert(
      (b.warning ?? "").includes("PI_ENSEMBLE_DISPATCH_CAPS=0"),
      `and the switch that disabled it (got ${JSON.stringify(b.warning)})`,
    );
    assert(
      b.fired(resultWith({ killCause: "timeout", ok: false })) === undefined,
      "a timeout result under the disabled caps still reads as no budget verdict",
    );
    const both = armBudget({ turns: 5, tokens: 0, minutes: 20 });
    assert(
      (both.warning ?? "").includes("inert"),
      "a turns+minutes budget reports the inert minutes lever too",
    );
    const turnsOnly = armBudget({ turns: 5, tokens: 0, minutes: 0 });
    assert(
      turnsOnly.warning === undefined,
      `a budget with no minutes has no warning (got ${JSON.stringify(turnsOnly.warning)})`,
    );
  } finally {
    // `delete` is the correct "reset to unset": assigning `undefined` stores the
    // literal string "undefined" on Bun 1.4 (test-env-clear-gate.ts, #997).
    // biome-ignore lint/performance/noDelete: unset is what this resets.
    if (priorCaps === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
    else process.env.PI_ENSEMBLE_DISPATCH_CAPS = priorCaps;
  }
  const clean = armBudget({ turns: 0, tokens: 0, minutes: 20 });
  assert(
    clean.warning === undefined,
    `without the switch the minutes lever is not reported inert (got ${JSON.stringify(clean.warning)})`,
  );
}

process.exit(exit);
