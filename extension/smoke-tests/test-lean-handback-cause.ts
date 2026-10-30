#!/usr/bin/env bun
/**
 * lean/handback — which cause a handback comment reports (#1883).
 *
 * Split from `test-lean-budgets.ts` for the 500-line gate (AGENTS.md §12).
 * `test-lean-budgets.ts` owns the ARMING of the three levers; this file owns
 * what the record says afterwards, which is a different module
 * (`handback.neededFromLog`) and a different claim: the comment must name the
 * reason the RUN ended, not merely the newest ceiling any step crossed.
 *
 * The distinction the epic turned up: a `budget` outcome is a step's own
 * verdict, and since #1883 a `challenge` breach is a CONTINUATION (the table
 * sends the run to `verify`, which still runs every frozen test). So a breach
 * whose verdict the table carried past cannot be why the run ended. Position is
 * the only honest test of that — nothing DECIDED may be newer than the breach —
 * because prose is whatever the handler wrote and a step's name is not enough
 * once one budget edge stops routing to `handback`.
 */

import { neededFromLog } from "../src/lean/handback.ts";
import { decided } from "./lib/lean-verify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A budget outcome with the typed trio `handback` renders from. */
function breach(state: "build" | "challenge") {
  return {
    kind: "budget" as const,
    limit: "minutes" as const,
    value: 15,
    used: 26,
    reason: `${state} stopped: minutes budget 15 exceeded (used 26)`,
  };
}

// ── a breach newer than every verdict owns the line ────────────────────────
{
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

// ── a challenge breach the table carried past is not the run's cause ──────
{
  const continued = [
    decided("verify", { kind: "red", reason: "an earlier red the fix round cleared" }),
    decided("challenge", breach("challenge")),
    decided("verify", { kind: "red", reason: "AC1 exited 1 — the retry test never passed" }),
  ];
  const needed = neededFromLog(continued);
  assert(
    needed.includes("the retry test never passed"),
    `a red verify after a challenge budget stop reports the red (got ${needed})`,
  );
  assert(
    !needed.includes("minutes budget 15"),
    `and not the ceiling that stopped the optional round (got ${needed})`,
  );
}

// ── with nothing decided after it, the breach is still the newest true cause ─
{
  const needed = neededFromLog([
    decided("verify", { kind: "green", reason: "all frozen tests passed" }),
    decided("challenge", breach("challenge")),
  ]);
  assert(
    needed.includes("minutes budget 15"),
    `a challenge breach with nothing decided after it still reports the breach (got ${needed})`,
  );
}

// ── a build breach ends the run, so nothing is newer and it stays the headline ─
{
  const needed = neededFromLog([
    decided("verify", { kind: "red", reason: "an earlier red" }),
    decided("build", breach("build")),
  ]);
  assert(
    needed.includes("minutes budget 15"),
    `a build breach that ends the run still reports the ceiling (got ${needed})`,
  );
}

// ── a breach missing its typed trio is not a sentence this prints ─────────
{
  // The renderer reads `limit`/`value`/`used`, the fields `assertRun` validated
  // on load. A half-record must fall through to the next cause rather than
  // print a fragment the operator cannot act on.
  const needed = neededFromLog([
    decided("verify", { kind: "red", reason: "AC2 exited 1 — the real reason" }),
    decided("build", { kind: "budget", limit: "minutes" } as never),
  ]);
  assert(
    needed.includes("the real reason"),
    `a breach with no value or used falls through to the red (got ${needed})`,
  );
}

process.exit(exit);
