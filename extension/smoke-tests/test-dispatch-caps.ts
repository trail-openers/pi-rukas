#!/usr/bin/env bun
/**
 * #543 F6 — token budget (secondary cost bound, SHIPS DEFAULT-OFF).
 *
 * The budget is on CUMULATIVE tokens (input + output + cacheRead + cacheWrite
 * per message_end — the same accumulation progress.ts tracks). When the
 * running total crosses PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>, spawn steers the child
 * to wrap up, then kills after the grace window with killCause "token-budget".
 *
 * The offline test asserts the pure seams (budget reader, cumulative
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
import type { PiContentBlock } from "../src/pi-event-shapes.ts";
import { createCapSession, resolveKillCause } from "../src/spawn-caps.ts";
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
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    assert(true, msg);
  } else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
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
      { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined },
      () => tokenBudgetFor("code-review-specialist") === 0,
    ),
    "tokenBudgetFor: unset → 0 (off) for a reviewer role",
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
      () => inactivityTimeoutMs() === 25 * 60_000 && spawnBackstopMs() === 2 * 60 * 60_000,
    ),
    "inertness: inactivity (25m) and backstop (2h) budgets are unchanged",
  );
}


// ---------------------------------------------------------------------------
// #543 C1 — killCause priority: a budget-killed child that ALSO tripped the
// wall-clock backstop is a token-budget kill, NOT a timeout. The attribution
// drives retry semantics AND the env override the operator reads.
// ---------------------------------------------------------------------------
{
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
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
      timedOut: true,
      tokenBudgetKilled: false,
      aborted: false,
    }) === "timeout",
    "C1: timedOut alone → 'timeout' (the #296 semantics are untouched)",
  );
  // full priority order: loop > inactivity > timeout > token-budget > abort
  assert(
    resolveKillCause({
      loopKilled: true,
      inactivityKilled: true,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: true,
    }) === "loop",
    "C1: all five facts → 'loop' wins",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: true,
      timedOut: true,
      tokenBudgetKilled: true,
      aborted: true,
    }) === "inactivity",
    "C1: inactivity beats timeout + token-budget + abort",
  );
  assert(
    resolveKillCause({
      loopKilled: false,
      inactivityKilled: false,
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
      timedOut: false,
      tokenBudgetKilled: false,
      aborted: false,
    }) === undefined,
    "C1: no facts → undefined (no kill)",
  );
}

// ---------------------------------------------------------------------------
// #543 H1 — grace-window kill race: the child exits on its own between the
// poll's grace check and killChild. The kill is a no-op on a dead process,
// but without the exited guard loopKilled / the tracker's killed flag would
// flip and mark a normally-completed child as a cap failure.
// ---------------------------------------------------------------------------
{
  const child = { killed: [] as string[], kill: (sig: string) => child.killed.push(sig) } as never;
  let exited = false;
  const session = createCapSession({
    role: "developer",
    child,
    onSteer: () => {},
    totalTokens: () => 1_000_000, // over budget — check() will trigger
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => false,
    capKillGraceMs: 600,
    childExited: () => exited,
  });
  process.env.PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER = "100";
  try {
    // The tracker triggers at the first message_end (1_000_000 >= 100).
    session.tokenBudgetTracker?.check(Date.now());
    // The child exits on its own BEFORE the grace window elapses.
    exited = true;
    // Wait for the 500ms poll to fire.
    await new Promise((r) => setTimeout(r, 700));
    assert(!session.tokenBudgetTracker?.killed, "H1: child self-exited before grace → tracker NOT killed");
    eq(child.killed, [], "H1: no kill signal sent to a self-exiting child");
    assert(session.killCause() === undefined, "H1: killCause stays undefined (ok=true semantics)");
  } finally {
    delete process.env.PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER;
    session.cleanup();
  }
}

// ---------------------------------------------------------------------------
// #543 H2 — F7e INERTNESS: with PI_ENSEMBLE_DISPATCH_CAPS=0 (master switch),
// createCapSession creates NO loop observer, NO token-budget tracker, and NO
// new timer. A 20-repeat identical stream through the session produces no
// steer, no killCause, and no setInterval call from the session.
// ---------------------------------------------------------------------------
{
  let timersCreated = 0;
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    timersCreated += 1;
    return origSetInterval(fn, ms, ...args);
  }) as typeof setInterval;
  let session: ReturnType<typeof createCapSession>;
  process.env.PI_ENSEMBLE_DISPATCH_CAPS = "0";
  try {
    session = createCapSession({
      role: "developer",
      child: { killed: [] as string[], kill: () => {} } as never,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 1000,
      childExited: () => false,
    });
  } finally {
    globalThis.setInterval = origSetInterval;
    delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  }
  assert(session.loopObserver === undefined, "H2: master switch off → no loop observer");
  assert(session.tokenBudgetTracker === undefined, "H2: master switch off → no token-budget tracker");
  assert(timersCreated === 0, `H2: master switch off → NO new setInterval (got ${timersCreated})`);
  // Feed a 20-repeat identical stream through the session's ingest path.
  // loopObserver is undefined so observe is a no-op; assert nothing changed.
  const blocks: PiContentBlock[] = [{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"git log"}' }];
  for (let turn = 0; turn < 20; turn++) session.loopObserver?.(blocks, turn);
  assert(!session.loopKilled(), "H2: 20-repeats through an inert session → not loop-killed");
  assert(session.killCause() === undefined, "H2: 20-repeats through an inert session → no killCause");
}

// ---------------------------------------------------------------------------
// #543 spawn#6 — a DISTINCT fingerprint arriving after kill-trigger resets
// the grace clock (aligning with the budget tracker's onMessageEnd reset).
// The spec's deferral is "while no new message_end has arrived since
// trigger"; a different call is new work the in-flight kill would discard.
// ---------------------------------------------------------------------------
{
  const child = { killed: [] as string[], kill: (sig: string) => child.killed.push(sig) } as never;
  let session: ReturnType<typeof createCapSession>;
  process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS = "30000"; // long window
  try {
    session = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 30_000,
      childExited: () => false,
    });
    // biome-ignore lint/style/noNonNullAssertion: caps are on by default in this test scope
    const observe = session.loopObserver!;
    // 10 identical calls → kill arms (count reaches LOOP_KILL_AT=10).
    for (let turn = 0; turn < 10; turn++) {
      observe([{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"git log --oneline"}' }], turn);
    }
    assert(!session.loopKilled(), "spawn#6: kill armed but grace window open");
    eq(child.killed, [], "spawn#6: no signal before grace elapses");
    // A DISTINCT message_end arrives (the loop ended).
    observe([{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"cargo test"}' }], 10);
    // Wait 700ms (the poll fires at 500ms) — the grace clock was reset by
    // the distinct fingerprint, so the kill must NOT fire.
    await new Promise((r) => setTimeout(r, 700));
    assert(!session.loopKilled(), "spawn#6: distinct message_end reset the grace clock — kill deferred");
    eq(child.killed, [], "spawn#6: no kill signal after the distinct message_end");
    session.cleanup();
  } finally {
    delete process.env.PI_ENSEMBLE_CAP_KILL_GRACE_MS;
    session?.cleanup();
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
