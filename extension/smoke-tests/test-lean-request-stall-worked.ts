#!/usr/bin/env bun
/**
 * lean: the two rules around the #2644 stall, pinned without the guard that got them wrong.
 *
 * The lever once exempted a child that had completed a turn or spent a token, which exempted
 * every cell from the field: a developer works for dozens of turns before its request hangs. These
 * cases drive the REAL poll and the REAL arm over a child that had worked (the fixture hands the
 * progress hook the child's actual counts, not zeros), and pin the three rules the zero guard was
 * imitating — a tool in flight, progress inside the window, a ceiling that is exceeded outranking
 * the stall, and a turn tick after a long quiet never freezing a stall verdict.
 */

import { budgetTrio } from "../src/lean/step-budget.ts";
import { stallBreach } from "../src/request-stall-policy.ts";
import type { Outcome } from "../src/lean/state.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "../src/lean/review-bound.ts";
import { MINUTE_MS } from "../src/lean/deadline.ts";
import { withEnv } from "./lib/env-scope.ts";
import {
  HUNG_REQUEST_MS,
  PANEL_CELL_S,
  PANEL_START_MS,
  cellAt,
  stallEnv,
} from "./lib/lean-request-stall-fixture.ts";
import { runBuild } from "./lib/lean-build-fixture.ts";
import { put } from "./lib/lean-build-artifacts.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { defaultConfig } from "../src/lean/config.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

/** The build config with its own ceiling levers off — the stall is the only lever. */
function stallOnlyConfig() {
  return {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: 0, tokens: 0, minutes: 0 } },
  };
}

const PANEL_NOW = cellAt(PANEL_CELL_S - 60);

/** The child's own stream stamp: how long the fake child has been quiet. */
function silent(ms: number): number {
  return ms;
}

// ── (b4) THE FIELD SHAPE: a child that already worked is still stallable ─────
// Three cells died with a developer that had written code, run tests and spent tokens for
// dozens of turns BEFORE its request hung. An arm that decides off the child's turn or token
// count is an arm that only ever catches a child that died before its first turn — which is no
// cell from the field. The progress snapshot here carries the child's REAL counts (the fixture
// hands over what the case declares), so the lever is judged on the reading a real spawn gives it.
{
  /** A developer that did real work: turns and tokens, then silence. */
  const WORKED = { turns: 14, totalTokens: 250_000 };
  let hung: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    hung = await runBuild({
      issue: 2648,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });
  assert(
    hung?.outcome?.kind === "budget",
    `(b4) a child that had completed turns and spent tokens is still ended as a stall, the field shape (got ${String(hung!.outcome?.kind)})`,
  );
  const b4 = budgetTrio(hung!.outcome as Outcome | undefined);
  assert(
    b4?.limit === "stall",
    `(b4) and the trio names the stall rather than nothing (got ${JSON.stringify(b4)})`,
  );
  assert(
    hung!.headAfter !== hung!.headBefore,
    "(b4) the worked child's patch is kept, like the panel row",
  );

  // …and the two exemptions still hold for THAT child, not only for a pristine one.
  let live: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    live = await runBuild({
      issue: 2649,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      toolInFlight: true,
      silentMs: silent(HUNG_REQUEST_MS),
    });
  });
  assert(
    live?.outcome?.kind === "ok",
    `(b4) the same worked child with a tool in flight is not a stall (got ${String(live.outcome?.kind)})`,
  );
  let quick: Awaited<ReturnType<typeof runBuild>> | undefined;
  await withEnv(stallEnv(), async () => {
    quick = await runBuild({
      issue: 2650,
      config: stallOnlyConfig(),
      clock: { deadlineMs: PANEL_START_MS + PANEL_CELL_S * MINUTE_MS, now: () => PANEL_NOW },
      child: (wt) => put(wt, "src/stall.ts", "export const stall = () => 1;\n"),
      worked: WORKED,
      // Half the window: inside it the lever holds its fire whatever the child did before.
      silentMs: silent(Math.floor(HUNG_REQUEST_MS / 2)),
    });
  });
  assert(
    quick?.outcome?.kind === "ok",
    `(b4) the same worked child, quiet inside the window, finishes (got ${String(quick.outcome?.kind)})`,
  );
}

// ── (b5) a ceiling that is exceeded outranks the stall, and a turn tick is never a stall ─
// The two rules the zero guard was imitating, pinned without the guard: the turns / tokens
// ceilings must still win on the tick that crosses them, and a tick that arrives AFTER a long
// quiet (the first message back, carrying a tool call) must not be read as a stall — the
// progress tracker has not yet seen that line, so the silence the reader reports is stale.
{
  const { armBudget } = await import("../src/lean/step-budget.ts");
  const { emptyRunningState } = await import("../src/progress.ts");
  const deadlineMs = PANEL_START_MS + PANEL_CELL_S * MINUTE_MS;
  const arms = () => ({
    reserveMs: REVIEW_DEADLINE_RESERVE_MS,
    silence: () => ({ sinceMs: HUNG_REQUEST_MS, toolInFlight: false }),
    deadlineMs,
    startedAt: PANEL_START_MS,
  });
  const snapshot = (turns: number, totalTokens: number) => ({
    ...emptyRunningState("developer"),
    turns,
    totalTokens,
  });

  // Turns ceiling exceeded on the same tick the child is also quiet past the window.
  const bothTurns = armBudget({ minutes: 0, turns: 3, tokens: 0 }, arms());
  bothTurns.opts.onProgress?.(snapshot(9, 0));
  const turnsVerdict = bothTurns.fired({ role: "developer", ok: true, ms: 1 });
  assert(
    turnsVerdict?.limit === "turns",
    `(b5) a turns ceiling that is exceeded still wins over the stall (got ${JSON.stringify(turnsVerdict)})`,
  );

  const bothTokens = armBudget({ minutes: 0, turns: 0, tokens: 1000 }, arms());
  bothTokens.opts.onProgress?.(snapshot(2, 9_999));
  const tokensVerdict = bothTokens.fired({ role: "developer", ok: true, ms: 1 });
  assert(
    tokensVerdict?.limit === "tokens",
    `(b5) a tokens ceiling that is exceeded still wins over the stall (got ${JSON.stringify(tokensVerdict)})`,
  );

  // The tick the rule exists for: the child was quiet past the window and then its first
  // message back arrives, carrying a tool call. That tick is not a stall, whatever the reader
  // says, because the tracker has not observed this line yet.
  const turnTick = armBudget({ minutes: 0, turns: 0, tokens: 0 }, arms());
  turnTick.opts.onProgress?.(snapshot(1, 0));
  assert(
    turnTick.fired({ role: "developer", ok: true, ms: 1 }) === undefined,
    `(b5) a turn tick after a long quiet never freezes a stall verdict (got ${JSON.stringify(turnTick.fired({ role: "developer", ok: true, ms: 1 }))})`,
  );
  turnTick.opts.onProgress?.(snapshot(7, 120_000));
  assert(
    turnTick.fired({ role: "developer", ok: true, ms: 1 }) === undefined,
    "(b5) nor does one on a child that had worked for turns and tokens",
  );

  // The decider itself, pinned directly: a silent child past the window breaches whatever it has
  // spent, and the same reading with a call in flight or inside the window breaches nothing. The
  // suite above pins this through the poll; this pins that the decision reads nothing but those two
  // facts — no turns, no tokens, no re-derived window.
  const armAt = (ms: number, toolInFlight: boolean) => ({
    windowMinutes: 23,
    windowMs: ms,
    silence: () => ({ sinceMs: ms, toolInFlight }),
  });
  assert(
    stallBreach(armAt(1_380_000, false))?.limit === "stall",
    "(b5) the poll's decider breaches a silent child at its window, on no reading but the silence",
  );
  assert(
    stallBreach(armAt(1_380_000, true)) === undefined &&
      stallBreach({ ...armAt(1_380_000, false), windowMs: 1_380_000 + 1 }) === undefined &&
      stallBreach(undefined) === undefined,
    "(b5) …and nothing while a tool runs, inside the window, or with no arm",
  );
}


process.exit(failed);
