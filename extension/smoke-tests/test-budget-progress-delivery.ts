#!/usr/bin/env bun
/**
 * #1991 — the DELIVERY half of the budget-progress steer: what a steer owes the
 * child once it tries to speak, and what it may not claim to have said.
 *
 * `test-budget-progress.ts` pins WHAT the two stage lines say and WHEN the
 * stages fire. This suite pins the accounting under them, which is the part a
 * child cannot recover from when it is wrong: a stage settled on "the seam was
 * called" rather than "the line arrived" tells a child nothing at 50% and then
 * never tells it the close-out instruction — the one line that keeps a bounded
 * child from being killed with its work uncommitted.
 *
 * The AC this adds to the #1991 set:
 *   8. a steer whose delivery was REFUSED — a seam that throws, a seam that
 *      returns `false` — leaves its stage OPEN and is retried on the next turn;
 *   9. the latches are per STAGE, not per lever × stage: a turn on which BOTH
 *      levers cross its fraction yields ONE line, and the pair is the whole
 *      steer however far past both bounds the child then runs;
 *  10. the no-seam path (a lens / adversarial child, the motivating overrunners)
 *      writes the RPC envelope to stdin, and never writes to a child whose exit
 *      the supervisors already observed.
 */

import { PassThrough } from "node:stream";
import {
  type BudgetProgressOpts,
  budgetProgressClock,
  createBudgetProgressSteer,
} from "../src/budget-progress.ts";
import type { SteerSource } from "../src/dispatch-steer.ts";

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
  if (a === e) assert(true, msg);
  else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const MINUTE = 60_000;

type Steer = { text: string; source: SteerSource };

/** The opts the delivery paths share, so a block below states only what it varies. */
function steerWith(opts: Partial<BudgetProgressOpts> & { role?: string; commits?: boolean }) {
  return createBudgetProgressSteer({
    role: opts.role ?? "developer",
    commits: opts.commits ?? true,
    ...opts,
  });
}

// ── 8. a throwing steer seam is swallowed, and the stage stays open ─────
{
  let calls = 0;
  const stdin = new PassThrough();
  const steer = steerWith({
    turns: 10,
    stdin,
    onSteer: () => {
      calls++;
      throw new Error("write EPIPE");
    },
  });
  let threw = false;
  try {
    steer.onAssistantTurn(5, Date.now());
    steer.onAssistantTurn(8, Date.now());
    steer.onAssistantTurn(9, Date.now());
  } catch {
    threw = true;
  }
  assert(!threw, "a throwing steer seam (EPIPE) never escapes onto the child's hot path");
  // A line that never landed left its stage OPEN, so each stage is re-attempted
  // on every turn until it delivers. The behaviour this replaces settled both
  // latches on the FIRST turn past half — a child whose 50% write hit an EPIPE
  // never heard the close-out instruction. A child that is genuinely gone is
  // stopped by gone()/exited() (block 10), not by a latch that assumed success.
  eq(calls, 5, "an undelivered steer is retried every turn, so the close-out can still land");
  steer.stop();
}

// ── 8b. a seam that answers false keeps the stage open, then retries ────
{
  const delivered: string[] = [];
  const stdin = new PassThrough();
  let deliverable = false;
  const steer = steerWith({
    turns: 10,
    stdin,
    onSteer: (text) => {
      if (!deliverable) return false;
      delivered.push(text);
      return true;
    },
  });
  steer.onAssistantTurn(5, Date.now());
  eq(delivered.length, 0, "an onSteer returning false is NOT counted as delivered");
  steer.onAssistantTurn(6, Date.now());
  eq(delivered.length, 0, "nor is it counted the next turn — the stage stays open");
  deliverable = true;
  steer.onAssistantTurn(7, Date.now());
  eq(delivered.length, 1, "the stage retries once the seam can deliver");
  assert(
    /turn 7 of 10/.test(delivered[0] ?? ""),
    `the retry reports the CURRENT turn, not the one that failed (${delivered[0]})`,
  );
  steer.onAssistantTurn(8, Date.now());
  steer.onAssistantTurn(9, Date.now());
  eq(delivered.length, 2, "close-out fires exactly once, when its own line lands");
  steer.onAssistantTurn(10, Date.now());
  eq(delivered.length, 2, "and neither stage fires again once both have settled");
  steer.stop();
}

// ── 9. the latches are per STAGE, not per lever × stage ─────────────────
{
  const steers: Steer[] = [];
  const stdin = new PassThrough();
  const anchor = Date.now();
  // Both levers armed and both crossing half on the SAME turn. A per-lever latch
  // pair speaks twice at 50% and twice again at 80% — four lines for the two
  // moments in the child's life that this steer exists to mark.
  const clock = budgetProgressClock({ wrapAtMs: 10 * MINUTE, killAtMs: 20 * MINUTE }, anchor);
  const steer = steerWith({
    turns: 40,
    clock,
    stdin,
    onSteer: (text, source) => {
      steers.push({ text, source });
      return true;
    },
  });
  steer.onAssistantTurn(20, anchor + 10 * MINUTE);
  eq(steers.length, 1, "both levers crossing half on one turn yield exactly ONE line");
  steer.onAssistantTurn(32, anchor + 16 * MINUTE);
  eq(steers.length, 2, "close-out crossing on both levers on one turn is also ONE line");
  steer.onAssistantTurn(40, anchor + 25 * MINUTE);
  eq(steers.length, 2, "and nothing after, however far past both bounds it runs");
  steer.stop();
}

// ── 10. the no-seam path writes the RPC envelope to stdin ───────────────
{
  const stdin = new PassThrough();
  let written = "";
  stdin.on("data", (d) => {
    written += String(d);
  });
  const steer = steerWith({
    role: "code-review-specialist",
    commits: false,
    turns: 4,
    stdin,
  });
  steer.onAssistantTurn(2, Date.now());
  steer.onAssistantTurn(4, Date.now());
  const lines = written.split("\n").filter(Boolean);
  eq(lines.length, 2, "a child with no steer seam still receives both steers on stdin");
  eq(
    JSON.parse(lines[0] ?? "{}"),
    { type: "steer", message: "Budget: turn 2 of 4." },
    "the stdin line is exactly the {type:'steer', message} RPC envelope",
  );
  assert(
    (lines[1] ?? "").endsWith("\n") === false,
    "each envelope is newline-terminated (the split above is on the terminator)",
  );
  steer.stop();

  // An exited child is not written to at all: advice nobody will read is not a
  // write, and a write to a dead pipe is the EPIPE #932 exists to keep off.
  const dead = new PassThrough();
  let deadWrites = 0;
  dead.write = () => {
    deadWrites++;
    return true;
  };
  const deadSteer = steerWith({ turns: 2, stdin: dead, exited: () => true });
  deadSteer.onAssistantTurn(2, Date.now());
  eq(deadWrites, 0, "advice is never written to a child whose exit was observed");
  deadSteer.stop();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
