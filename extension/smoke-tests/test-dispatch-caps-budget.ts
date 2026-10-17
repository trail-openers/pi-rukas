#!/usr/bin/env bun
/**
 * #543 F6 — token budget: the PURE seam (secondary cost bound, SHIPS DEFAULT-OFF).
 *
 * Split out of `test-dispatch-caps.ts` to keep both files under the 500-line
 * hard limit (AGENTS.md §12). That file keeps the `createCapSession` race
 * cases (H1 grace-window, chatty-child kill, H2 master-switch inertness,
 * spawn#6 fingerprint reset); this one keeps the pure arithmetic and the
 * budget/env readers. No assertion was weakened or dropped in the move.
 *
 * The budget is on CUMULATIVE tokens (input + output + cacheRead + cacheWrite
 * per message_end — the same accumulation progress.ts tracks). When the
 * running total crosses PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>, spawn steers the child
 * to wrap up, then kills after the grace window with killCause "token-budget".
 *
 * These offline assertions cover the pure seams (budget reader, cumulative
 * accumulation, steer-text shape, the kill-cause env-name mapping) and the
 * F7e inertness canary: with every budget at 0 (the ship default), the budget
 * machinery is inert — no killCause outside timeout/inactivity/abort, no steer
 * written, no new behavior on a healthy stream.
 *
 * The steer-then-kill live path (a scripted usage stream crossing an explicit
 * budget) is exercised in the live spawn test (test-dispatch-caps-live.ts,
 * out of scope for the offline pre-push set) because it needs a real child to
 * receive the steer and observe the SIGTERM. The offline suite proves the
 * arithmetic and the inertness; the live suite proves the end-to-end kill.
 */

import { budgetSteerText, emptyRunningState, formatTokens, ingestEvent } from "../src/progress.ts";
import { resolveKillCause } from "../src/spawn-caps.ts";
import {
  capKillGraceMs,
  inactivityTimeoutMs,
  spawnBackstopMs,
  tokenBudgetFor,
} from "../src/spawn-support.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
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

// 1. tokenBudgetFor: default-OFF (0) for every role at ship.
// biome-ignore lint/complexity/noUselessLoneBlockStatements: fixture scope (shared `exit`/`assert` across the file)
{
  assert(
    withEnv(
      {
        PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined,
        PI_ENSEMBLE_TOKEN_BUDGET_EXPLORER: undefined,
      },
      () => tokenBudgetFor("developer") === 0,
    ),
    "tokenBudgetFor: unset → 0 (off) for developer",
  );
  assert(
    withEnv(
      { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "500000" },
      () => tokenBudgetFor("developer") === 500_000,
    ),
    "tokenBudgetFor: explicit budget is read from the env (role upper-cased)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "0" }, () => tokenBudgetFor("developer") === 0),
    "tokenBudgetFor: 0 = off",
  );
  assert(
    withEnv(
      { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "not-a-number" },
      () => tokenBudgetFor("developer") === 0,
    ),
    "tokenBudgetFor: non-numeric → 0 (off), never NaN",
  );
}

// 2. The BUDGET QUANTITY is the cumulative token sum (not cost.total).
{
  const state = emptyRunningState("developer");
  const msgEnd = (u: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }): object => ({
    type: "message_end",
    message: {
      role: "assistant",
      usage: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        cost: { total: u.cost },
      },
    },
  });
  // Turn 1: 1000 in, 100 out, 500 read, 50 write, $0.01 cost.
  ingestEvent(
    state,
    msgEnd({ input: 1000, output: 100, cacheRead: 500, cacheWrite: 50, cost: 0.01 }) as never,
    0,
  );
  // Turn 2: 2000 in, 200 out, 0, 0, $0.02 cost.
  ingestEvent(
    state,
    msgEnd({ input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.02 }) as never,
    0,
  );
  // Cumulative = (1000+100+500+50) + (2000+200) = 3850. Cost = 0.03 (NOT the budget).
  assert(
    state.totalTokens === 3_850,
    "totalTokens accumulates input+output+cacheRead+cacheWrite per turn",
  );
  assert(
    state.usage.cost === 0.03,
    "cost.total is tracked separately and is NOT the budget quantity",
  );
  assert(state.turns === 2, "turn count advances per assistant message_end");
}

// 3. budgetSteerText names the used and budget figures and does not claim work
//    is complete.
{
  const t = budgetSteerText(1_500_000, 1_000_000);
  assert(t.includes(formatTokens(1_500_000)), "steer text names the used token count");
  assert(t.includes(formatTokens(1_000_000)), "steer text names the budget");
  assert(/stop what you are doing/i.test(t), "steer text tells the child to stop new work");
  assert(/final report/i.test(t), "steer text asks for a final status report");
  assert(!/complete/i.test(t), "steer text does NOT claim in-flight work is complete");
}

// 4. capKillGraceMs: default 5min, 0 disables, env override (time-injectable).
// biome-ignore lint/complexity/noUselessLoneBlockStatements: fixture scope (shared `exit`/`assert` across the file)
{
  assert(
    withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: undefined }, () => capKillGraceMs() === 5 * 60_000),
    "capKillGraceMs: default 5 minutes",
  );
  assert(
    withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "0" }, () => capKillGraceMs() === 0),
    "capKillGraceMs: 0 disables the deferral (immediate kill)",
  );
  assert(
    withEnv({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "30000" }, () => capKillGraceMs() === 30_000),
    "capKillGraceMs: env override is honoured (tests inject short windows)",
  );
}

// 5. F7e INERTNESS canary: with every budget at 0 (ship default) and a healthy
//    usage stream, the budget machinery produces NO killCause, NO steer, and
//    does not touch the other caps' budgets.
{
  const state = emptyRunningState("developer");
  const msgEnd = (input: number, output: number, cost: number): object => ({
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  });
  // A healthy stream: 119 turns, growing context (each turn's input includes
  // the full context so the sum grows quadratically — the corpus's longest
  // healthy shape), $ cost that would blow a naive cost-based bound.
  let expectedTotal = 0;
  for (let turn = 0; turn < 119; turn++) {
    const input = 1000 + turn * 500; // growing context
    const output = 200;
    expectedTotal += input + output;
    ingestEvent(state, msgEnd(input, output, 0.001) as never, turn * 1000);
  }
  assert(
    state.totalTokens === expectedTotal,
    "inertness: cumulative total accumulates across a healthy stream",
  );
  // The budget is OFF (0), so no budget kill can fire regardless of the total.
  assert(
    withEnv({ PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined }, () =>
      tokenBudgetFor("developer"),
    ) === 0,
    "inertness: with no budget env, the budget is OFF — no kill, no steer",
  );
  // The other caps' budgets are untouched by the F6 additions.
  assert(
    withEnv(
      { PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: undefined, PI_ENSEMBLE_SPAWN_TIMEOUT_MS: undefined },
      // #951 — inactivity default moved 25 → 30 min (the in-flight tool-call
      // exemption now covers the ~15-min long-bash gap this budget once defended).
      () => inactivityTimeoutMs() === 30 * 60_000 && spawnBackstopMs() === 2 * 60 * 60_000,
    ),
    "inertness: inactivity (30m, was 25m pre-#951) and backstop (2h) budgets are unchanged",
  );
}

// ---------------------------------------------------------------------------
// #543 C1 — killCause priority: a budget-killed child that ALSO tripped the
// wall-clock backstop is a token-budget kill, NOT a timeout. The attribution
// drives retry semantics AND the env override the operator reads.
// #951 — tool-inactivity ranks equal with inactivity (both are wall-clock
// silence kills of the same poll; exactly one is set per poll, by construction).
// ---------------------------------------------------------------------------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: fixture scope (shared `exit`/`assert` across the file)
{
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: false,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: false,
    }) === "token-budget",
    "C1: timedOut + tokenBudgetKilled → 'token-budget' (budget is the more specific diagnosis)",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: false,
      timedOut: false,
      tokenBudgetKilled: true,
      aborted: false,
    }) === "token-budget",
    "C1: tokenBudgetKilled alone → 'token-budget'",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: false,
      timedOut: true,
      tokenBudgetKilled: false,
      aborted: false,
    }) === "timeout",
    "C1: timedOut alone → 'timeout' (the #296 semantics are untouched)",
  );
  // #951 — tool-inactivity alone → 'tool-inactivity'
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: true,
      timedOut: false,
      tokenBudgetKilled: false,
      aborted: false,
    }) === "tool-inactivity",
    "C1: toolInactivityKilled alone → 'tool-inactivity' (#951)",
  );
  // full priority order: loop > inactivity = tool-inactivity > token-budget > timeout > abort
  assert(
    resolveKillCause({
      loopKilled: true,
      inactivityKilled: true,
      toolInactivityKilled: true,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: true,
    }) === "loop",
    "C1: all six facts → 'loop' wins",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: true,
      toolInactivityKilled: false,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: true,
    }) === "inactivity",
    "C1: inactivity beats timeout + token-budget + abort",
  );
  // #951 — tool-inactivity also beats timeout + token-budget + abort
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: true,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: true,
    }) === "tool-inactivity",
    "C1: tool-inactivity beats timeout + token-budget + abort (#951)",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: false,
      timedOut: false,
      tokenBudgetKilled: false,
      aborted: true,
    }) === "abort",
    "C1: abort alone → 'abort'",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
      toolInactivityKilled: false,
      timedOut: false,
      tokenBudgetKilled: false,
      aborted: false,
    }) === undefined,
    "C1: no facts → undefined (no kill)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
