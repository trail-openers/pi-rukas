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
import { handbackBody } from "../src/lean/handback.ts";
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

// ── a handback report written after a breach does not hide it ────────────
{
  const needed = neededFromLog([
    decided("verify", { kind: "red", reason: "an earlier red" }),
    decided("build", breach("build")),
    decided("handback", { kind: "done", reason: "handback comment posted" }),
  ]);
  assert(
    needed.includes("minutes budget 15"),
    `a handback entry after a build breach does not hide the breach (got ${needed})`,
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

// ── a blocked build outranks the budget AND a stale red (the run-5 shape) ──
{
  // The post-mortem this rule exists for: the child hit the turn kill, and the
  // run's log carried a breach and an older red. The operator's line has to name
  // the CONFLICT, because that is the only thing in the record a developer can
  // act on — and it is typed, so unlike a breach it is not position gated.
  const steps = [
    decided("verify", { kind: "red", reason: "AC1 exited 1 — an earlier round's red" }),
    decided("build", breach("build")),
    decided("build", {
      kind: "blocked",
      blockedBy: {
        "tests/AC1-identity.test.ts": "case 2 needs the array mutable, case 3 mutates it in place",
      },
    }),
  ];
  const needed = neededFromLog(steps);
  assert(
    needed.includes("tests/AC1-identity.test.ts") && needed.includes("case 3 mutates it in place"),
    `the conflict is the cause line (got ${needed})`,
  );
  assert(
    !needed.includes("minutes budget 15"),
    `the breach the run survived does not bury the conflict (got ${needed})`,
  );
  assert(
    !needed.includes("an earlier round's red"),
    `and neither does a stale red (got ${needed})`,
  );
}

// ── the blocked cause is the comment's fenced line, not just an outcome ───
{
  const longReason = "z".repeat(400);
  const body = handbackBody(9, {
    needed: neededFromLog([
      decided("build", {
        kind: "blocked",
        blockedBy: {
          "tests/a.test.ts": "### INJECTED HEADING\n- looks like a bullet",
          "tests/b.test.ts": longReason,
        },
      }),
    ]),
    frozen: ["tests/a.test.ts"],
    branch: "lean/issue-9",
  });
  assert(body.includes("tests/a.test.ts"), `the comment names the conflicting file (got ${body})`);
  assert(
    !/^### INJECTED HEADING$/m.test(body),
    `the child's prose cannot write a heading into the comment (got ${body})`,
  );
  assert(
    body.includes("```text"),
    `the cause is fenced like every other untrusted field (got ${body})`,
  );
  // The record allows 300 characters per reason; the PUBLIC comment does not
  // print that much of the child's prose — it clips to its own, smaller bound.
  assert(
    !body.includes(longReason),
    "a 400-char reason is not printed whole in the public comment",
  );
  assert(body.includes(`${"z".repeat(160)}…`), "and the clip is marked rather than silent");
}

// ── a blocked step the run carried past is NOT the cause ─────────────────
{
  // Position is the only true test of "this is why the run ended", and
  // `blockedCause` applies it the way `budgetCause` does. The engine itself never
  // writes this log — `next()` routes `build + blocked` straight to `handback` —
  // so this is the resumed / hand-edited shape, where a stale blockedBy must not
  // outrank the verdict that actually ended the run.
  const needed = neededFromLog([
    decided("build", {
      kind: "blocked",
      blockedBy: { "tests/a.test.ts": "a conflict from a round the run carried past" },
    }),
    decided("build", { kind: "ok", reason: "implemented" }),
    decided("verify", { kind: "red", reason: "AC1 exited 1 — the newest verdict" }),
  ]);
  assert(
    needed.includes("the newest verdict"),
    `a carried-past blocked verdict does not bury the newest red (got ${needed})`,
  );
  assert(
    !needed.includes("round the run carried past"),
    `and its stale map is not printed (got ${needed})`,
  );
}

// ── the newest working step may be a later report-free step, but a REPORT is not ─
{
  // A `handback` step newer than the blocked verdict is the run REPORTING how it
  // ended, not work it went on to do — the same exclusion `budgetCause` makes, so
  // the cause still speaks.
  const needed = neededFromLog([
    decided("build", {
      kind: "blocked",
      blockedBy: { "tests/a.test.ts": "case 2 and case 3 contradict" },
    }),
    decided("handback", { kind: "done", reason: "handback comment posted" }),
  ]);
  assert(
    needed.includes("case 2 and case 3 contradict"),
    `a reporting step after the blocked verdict does not hide it (got ${needed})`,
  );
}

// ── a blocked step with no typed map is not a sentence this prints ────────
{
  // Same rule as the budget trio: a half-record falls through rather than
  // printing "cannot all pass together:" with nothing after it.
  const needed = neededFromLog([
    decided("verify", { kind: "red", reason: "AC2 exited 1 — the real reason" }),
    decided("build", { kind: "blocked" }),
  ]);
  assert(
    needed.includes("the real reason"),
    `a blocked step with no blockedBy falls through to the red (got ${needed})`,
  );
}

process.exit(exit);
