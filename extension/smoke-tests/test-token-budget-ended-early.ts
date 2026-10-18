#!/usr/bin/env bun
/**
 * #1569 — a child that crossed its token budget is never a completed dispatch.
 *
 * The budget kill is deferred by a grace window after the wrap-up steer. A
 * child that heeds the steer and ends inside that window exits 0 before
 * `poll()` kills it, so `tracker.killed` stays false. Attribution read only
 * `killed`, so the dispatch came back `ok:true` with no killCause and the
 * driver advanced on a half-done step. Tokens counted from toolResult usage
 * can also cross the budget with no `message_end` left to call `check()`.
 * Both now attribute "token-budget"; an under-budget or budget-off child is
 * untouched.
 */
import { capKillAttribution, createCapSession } from "../src/spawn-caps.ts";
import type { DispatchResult } from "../src/types.ts";
import { buildCompletionEvent } from "../src/work-driver-completion-event.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const completed = (): DispatchResult => ({
  role: "developer",
  ok: true,
  text: "I'll start by reading the issue body.",
  toolUses: [],
  ms: 7_663,
  exitCode: 0,
});

function session(tokens: number, aborted = false) {
  let kills = 0;
  const child = {
    pid: 4242,
    once: () => {},
    kill: () => {
      kills += 1;
      return true;
    },
  } as never;
  const caps = createCapSession({
    role: "developer",
    child,
    onSteer: () => {},
    totalTokens: () => tokens,
    capKillGraceMs: 60_000,
    timedOut: () => false,
    inactivityKilled: () => false,
    aborted: () => aborted,
    childExited: () => true,
  });
  return { caps, kills: () => kills };
}

/** What spawn.ts does after the child's exit (spawn.ts: "A killed child never completed"). */
function attribute(caps: ReturnType<typeof session>["caps"], tokens: number, exitCode = 0) {
  const result = { ...completed(), exitCode, ok: exitCode === 0 };
  let stderr = "";
  capKillAttribution(
    caps,
    { role: "developer" },
    tokens,
    (s) => {
      stderr += s;
    },
    result,
  );
  if (result.killCause) result.ok = false;
  return { result, stderr };
}

await withEnv(
  { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "100", PI_ENSEMBLE_DISPATCH_CAPS: undefined },
  async () => {
    // (a) crossed, steered, ended inside the grace window — the incident shape.
    {
      const { caps, kills } = session(200);
      caps.tokenBudgetTracker?.check(Date.now());
      assert(
        caps.tokenBudgetTracker?.killed === false && kills() === 0,
        "(a) the kill never landed",
      );
      const { result, stderr } = attribute(caps, 200);
      assert(
        result.killCause === "token-budget",
        `(a) killCause is token-budget (got ${result.killCause})`,
      );
      assert(result.ok === false, "(a) the dispatch is not ok");
      assert(
        result.tokenBudget?.budget === 100 && result.tokenBudget?.used === 200,
        "(a) the budget/used pair is recorded",
      );
      assert(
        /exited before the kill/.test(stderr),
        "(a) stderr says the child exited before the kill",
      );
      const ev = await buildCompletionEvent(
        // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only read fields matter
        { repoRoot: "/repo", issue: 1391 } as any,
        "develop",
        "developer",
        "developer",
        result,
      );
      assert(
        ev.kind === "dispatch-failed",
        `(a) the step records dispatch-failed (got ${ev.kind})`,
      );
      caps.cleanup();
    }
    // (b) crossed through toolResult usage, no message_end afterwards: check() never ran.
    {
      const { caps } = session(200);
      const { result } = attribute(caps, 200);
      assert(
        result.killCause === "token-budget" && !result.ok,
        "(b) crossed without a check() is token-budget",
      );
      caps.cleanup();
    }
    // (e) over budget but aborted: the abort keeps its own cause.
    {
      const { caps } = session(200, true);
      const { result } = attribute(caps, 200);
      assert(
        result.killCause === "abort",
        `(e) an aborted over-budget child stays abort (got ${result.killCause})`,
      );
      caps.cleanup();
    }
    // (f) over budget but crashed (non-zero exit): not relabelled a budget cap.
    {
      const { caps } = session(200);
      const { result } = attribute(caps, 200, 1);
      assert(
        result.killCause === undefined,
        `(f) a crashed over-budget child keeps no budget cause (got ${result.killCause})`,
      );
      caps.cleanup();
    }
    // (c) under budget: a short legitimate completion stays ok.
    {
      const { caps } = session(50);
      caps.tokenBudgetTracker?.check(Date.now());
      const { result } = attribute(caps, 50);
      assert(
        result.killCause === undefined && result.ok,
        "(c) an under-budget two-turn child stays ok",
      );
      caps.cleanup();
    }
  },
);

// (d) budget off (the developer default): no amount of tokens makes it a kill.
await withEnv({ PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: undefined }, async () => {
  const { caps } = session(50_000_000);
  const { result } = attribute(caps, 50_000_000);
  assert(result.killCause === undefined && result.ok, "(d) with the budget off the child stays ok");
  caps.cleanup();
});

process.exit(exit);
