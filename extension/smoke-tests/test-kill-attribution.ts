#!/usr/bin/env bun
/**
 * An inactivity kill must be diagnosable, not merely tuned.
 *
 * The watchdog SIGTERMs a child after 25 minutes of total silence, and the
 * kill was recorded as a bare cause: `inactivity`, plus the budget. That
 * cannot distinguish two entirely different failures:
 *
 *   - a child that went quiet **after forty tool calls** — a genuine hang,
 *     mid-work, with real output on disk to recover;
 *   - a child that **never said anything at all** — a provider stall, an auth
 *     failure, a bad model id — where there is nothing to recover and the
 *     issue is upstream of the agent entirely.
 *
 * They need opposite responses, and a wall-clock number can tell them apart in
 * neither direction. The standing temptation is to raise the budget; that is
 * precisely the mistake the six per-role timers were deleted for, since each
 * was raised twice and each time the finding was that the number was too small
 * for a HEALTHY child.
 *
 * So this records the SHAPE of the silence — what the child last emitted, how
 * long before the kill, and how many lines it had produced in total.
 * `linesSeen: 0` is the tell.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { buildCompletionEvent } from "../src/work-driver-merged.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: partial fixture; only read fields matter
const ctx = { repoRoot: "/repo", issue: 686 } as any;

const killed = (over: Partial<DispatchResult>): DispatchResult =>
  ({
    role: "explore",
    ok: false,
    text: "",
    toolUses: [],
    ms: 1_868_000,
    exitCode: 143,
    killCause: "inactivity",
    killBudgetMs: 1_500_000,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  }) as any;

// ------------------- the two silences are told apart

{
  const neverSpoke = await buildCompletionEvent(
    ctx,
    "explore",
    "explore",
    "explore",
    killed({ lastActivity: { kind: "nothing yet", agoMs: 1_500_000, linesSeen: 0 } }),
  );
  const tail = neverSpoke.kind === "dispatch-failed" ? (neverSpoke.errorTail ?? "") : "";
  assert(
    /0 line\(s\)/.test(tail),
    `canary: a child that never spoke is recorded as having produced 0 lines (got ${JSON.stringify(tail)})`,
  );
  assert(/nothing yet/.test(tail), "...and says it never emitted an event at all");

  const wentQuiet = await buildCompletionEvent(
    ctx,
    "develop",
    "developer",
    "developer",
    killed({ lastActivity: { kind: "toolCall", agoMs: 1_500_000, linesSeen: 412 } }),
  );
  const tail2 = wentQuiet.kind === "dispatch-failed" ? (wentQuiet.errorTail ?? "") : "";
  assert(
    /412 line\(s\)/.test(tail2) && /toolCall/.test(tail2),
    `canary: a child that went quiet mid-work names its last event and line count (got ${JSON.stringify(tail2)})`,
  );
  // The two must be distinguishable from the text alone — that is the point.
  assert(tail !== tail2, "the two silences produce different text");
}

{
  // The budget and the override knob are still named — this adds to the
  // report rather than replacing what was there.
  const e = await buildCompletionEvent(
    ctx,
    "explore",
    "explore",
    "explore",
    killed({ lastActivity: { kind: "usage", agoMs: 900_000, linesSeen: 3 } }),
  );
  const tail = e.kind === "dispatch-failed" ? (e.errorTail ?? "") : "";
  assert(/1500000ms inactivity/.test(tail), "the expired budget is still reported");
  assert(/PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS/.test(tail), "...and the knob that governs it");
  assert(e.kind === "dispatch-failed" && e.killCause === "inactivity", "...and the cause");
}

{
  // A kill from an older run carries no lastActivity; the report must still
  // render rather than printing `undefined` at an operator.
  const e = await buildCompletionEvent(ctx, "explore", "explore", "explore", killed({}));
  const tail = e.kind === "dispatch-failed" ? (e.errorTail ?? "") : "";
  assert(
    !/undefined/.test(tail),
    `absent attribution renders nothing (got ${JSON.stringify(tail)})`,
  );
  assert(/inactivity/.test(tail), "...while the cause still reports");
}

// ------------- the budget itself is deliberately NOT raised

{
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const support = readFileSync(path.join(SRC, "spawn-support.ts"), "utf8");
  assert(
    /return 25 \* 60_000;/.test(support),
    "canary: the inactivity budget is unchanged — raising a number to cover a cause you have not identified is the mistake the per-role timers were deleted for",
  );
  const spawn = readFileSync(path.join(SRC, "spawn.ts"), "utf8");
  assert(
    /lastActivityKind/.test(spawn) && /stdoutLines/.test(spawn),
    "the shape of the silence is tracked at the spawn seam, where the lines actually arrive",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
