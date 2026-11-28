#!/usr/bin/env bun
/**
 * A repair round refuses an unreadable seat, and bills it anyway (#2668).
 *
 * The round paid for one child and then read whatever that child left. Three holes followed:
 *
 *   1. a seat whose `DispatchResult` says it did not finish (ok false, or no clean exit) was JUDGED like a
 *      seat that finished, so a child killed mid-flight had its half-written files frozen as the contract;
 *   2. a dispatch that threw carried its cost rows on the error, the way `lean/specify-attempt.ts` reads
 *      them, and the round threw them away, so the refused round reported a free child the run had paid for;
 *   3. the round wrote its own copy of the submission scope rule, and a child whose every `submit_tests` call
 *      was unreadable got the sentence that says it named none.
 *
 * All four cases drive the REAL `runRepairRound` through `lib/lean-oracle-repair-round.ts`: a real repo, a
 * real worktree, a real `sh` runner, real judgement. Only the model is faked, so a refusal that reads right
 * was produced by the code that hands it back.
 */

import type { DispatchResult } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { FROZEN, HANGING_REL, TWO_SUBMISSIONS, driveRound } from "./lib/lean-oracle-repair-round.ts";

const { assert, failures } = makeAssert();

/** The usage trio a paid child reports, in the shape the loader accepts. */
const PAID = {
  role: "developer",
  ms: 4_321,
  ok: false,
  usage: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 7, toolCalls: 2 },
};

const rowsOf = (outcome: unknown): unknown[] =>
  // A row whose counters do not satisfy the record's own grammar is dropped by the loader, so the case
  // asserts against the shape the run can actually keep: `ok` true, every counter a non-negative integer.
  (outcome as { rows?: unknown[] }).rows ??
  (outcome as { dispatches?: unknown[] }).dispatches ??
  [];

// (1) An incomplete seat is refused BEFORE any judgement, whatever it left in its tree. The run holds one
// named file, so a round that judged would reach the runner's own 30s hang rather than hide it.
const unreadable = await driveRound(
  2801,
  { result: { ok: false, exitCode: null } as Partial<DispatchResult> },
  { tracked: [FROZEN], named: [FROZEN], headRunBudgetMs: 400 },
);
assert(unreadable.kind === "refused", `(1) an incomplete seat is refused (${unreadable.kind})`);
assert(
  unreadable.why.includes("could not") && unreadable.why.includes("finish"),
  `(1) the refusal says the seat could not finish (${unreadable.why})`,
);
// The judge runs the project's runner at the base, so a round that judged would show up in the runner log.
assert(unreadable.rows.length === 0, `(1) nothing was judged (${JSON.stringify(unreadable.rows)})`);

// A seat the runner says exited uncleanly is the same shape as one whose own flag says it did not finish.
const unclean = await driveRound(
  2806,
  { result: { exitCode: 1 } as Partial<DispatchResult> },
  { tracked: [FROZEN], named: [FROZEN], headRunBudgetMs: 400 },
);
assert(
  unclean.kind === "refused" &&
    unclean.why.includes("could not") &&
    unclean.why.includes("finish"),
  `(1) a seat that did not exit clean is refused too (${unclean.kind}: ${unclean.why})`,
);

// (2) A dispatch that threw still bills what the run spent.
const THROWING: Error & { dispatches?: unknown[] } = new Error("the child's session died");
THROWING.dispatches = [PAID];
const thrown = await driveRound(2802, { throws: THROWING });
assert(thrown.kind === "refused", `(2) a dispatch that threw is refused, not thrown (${thrown.kind})`);
const thrownRows = rowsOf(thrown.outcome) as Array<Record<string, unknown>>;
assert(
  thrownRows.length === 1 &&
    thrownRows[0]?.role === "developer" &&
    thrownRows[0]?.ms === 4_321 &&
    (thrownRows[0]?.usage as { cost?: number })?.cost === 0.5,
  `(2) the refused outcome still bills the rows off the thrown error (${JSON.stringify(thrownRows)})`,
);

// The rows the harness's dispatch reports, so a case can name the billing the fix must keep in place.
const seatRows = await driveRound(2807, { silent: true }, { tracked: [FROZEN], named: [FROZEN] });
assert(
  rowsOf(seatRows.outcome).length === 1,
  `(2) a round that ran its seat bills the one row it read (${JSON.stringify(rowsOf(seatRows.outcome))})`,
);

// (3) The two empty-submission wordings say different things.
const noneCalled = await driveRound(
  2803,
  { silent: true },
  { tracked: [FROZEN], named: [FROZEN] },
);
const allUnreadable = await driveRound(2804, {
  submit: [{ criterionId: "AC1", testFiles: [2, ""] }],
  tracked: [FROZEN],
  named: [FROZEN],
});
assert(
  noneCalled.kind === "refused" &&
    noneCalled.why === "the repair child submitted no test file",
  `(3) a seat that called the tool never says so (${noneCalled.kind}: ${noneCalled.why})`,
);
assert(
  allUnreadable.kind === "refused" &&
    allUnreadable.why === "the repair child's 1 submission was unreadable",
  `(3) a seat whose only call was unreadable does not get the "named none" sentence (${allUnreadable.kind}: ${allUnreadable.why})`,
);
assert(
  noneCalled.why !== allUnreadable.why,
  "(3) the two empty submissions refuse with two different sentences",
);

// (4) The scope refusal is the shared helper's wording.
const strayed = await driveRound(2805, {
  submit: [{ criterionId: "AC1", testFiles: [FROZEN, HANGING_REL] }],
  tracked: [FROZEN],
  named: [FROZEN],
});
assert(
  strayed.kind === "refused" &&
    strayed.why ===
      `the repair replaced 1 file(s) the blocked report never named: ${HANGING_REL}`,
  `(4) the out-of-scope refusal carries the shared helper's sentence (${strayed.kind}: ${strayed.why})`,
);
assert(strayed.rows.length === 1, "(4) the refused round still bills its one seat");

void TWO_SUBMISSIONS;
if (failures() > 0) process.exitCode = 1;
else console.log("lean oracle repair seat refusal: OK");
