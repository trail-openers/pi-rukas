/**
 * Outcome predicates for the fake-`pi` kill assertions in test-cancel.ts
 * (issue #1382).
 *
 * #1382 removed the last two absolute wall-clock assertions from that file —
 * Test 2's `elapsedMs >= 5_000` floor on the SIGTERM→SIGKILL escalation and
 * Test 3's `elapsed < 15_000` ceiling on a 2000 ms inactivity budget. Neither
 * measured the product: the 5 s floor is what a saturated host clears EASILY
 * (so it can never fail for the right reason), and the 15 s ceiling is what a
 * saturated host blows through while the watchdog itself is healthy — the
 * observed 30 s stall in the sibling test was bun startup and descheduling,
 * not the kill path. A bound that fails for reasons unrelated to the code
 * under test manufactures false parks (the #777/#798 shape #809 removed for
 * the real-spawn variants).
 *
 * What replaced them reads the DEATH and the ATTRIBUTION. Two facts, and the
 * division of labour between them is the whole design:
 *
 *  - the ATTRIBUTION (`killCause`) says pi-rukas ended this child (#296);
 *  - the DEATH is read from the OS — the leader's own recorded pid, polled to
 *    gone by `lib/poll-until-killed.ts`'s `pollUntilGone` — because the result
 *    shape alone cannot say it. `killCause: "abort"` + `exitCode: null` is
 *    what a SIGKILLed leader reports AND what a leader that never exited
 *    reports, since the abort resolves the spawn before the reaping. A
 *    predicate over the result alone was therefore satisfied by a child that
 *    was never killed at all: with the escalation deleted from spawn-kill.ts,
 *    Test 2 still printed ✓ and the file then hung to the watchdog.
 *
 * So these predicates take the reaped-pid verdict as an argument rather than
 * trying to infer it, and the caller bounds both the poll and the spawn await
 * (see test-cancel.ts's header). Nothing here reads a clock.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/poll-until-killed.ts` and
 * `lib/wait-for-ledger.ts`); coverage comes through the test file that imports
 * it, including the failability self-check at the bottom of test-cancel.ts.
 */

import type { DispatchResult } from "../../src/types.ts";

/**
 * Did the abort actually KILL the TERM-trapping leader?
 *
 * The replacement for the `elapsedMs >= 5_000` floor, which was load-INSENSITIVE
 * in the dangerous direction: a saturated host delays the escalation past 5 s
 * so it passes, and if the escalation were ever shortened below 5 s the fake
 * child would exit on SIGTERM and the floor would STILL pass — a decorative
 * assertion.
 *
 * Two facts, both required, neither sufficient alone:
 *
 *  - `reaped` — the caller polled the group's pid to gone inside the deadline
 *    it derived from `KILL_GRACE_MS` (the group grace — the probe spawns with
 *    `processGroup: true`, see `lib/cancel-escalation.ts`). This is the death evidence,
 *    read from live OS state. It is what a result shape can never supply: an
 *    un-exited leader and a SIGKILLed one look identical in `exitCode`.
 *  - `killCause === "abort"` — pi-rukas ended the child, not an unrelated
 *    signal or a crash of the fake `pi`. Without it any death reads as a
 *    covered escalation.
 *
 * `exitCode` is deliberately NOT part of the predicate. The round-2 version
 * accepted `-9`, `137` and `null`; `-9` is Node's signal-death encoding and
 * `null` is what the measured TERM-trapping death reports, but `137` has no
 * producer here at all (nothing in this path forwards 128+9), and asserting on
 * it implied a shape the code never emits. Requiring nothing of it also keeps
 * the predicate honest about what it can and cannot see: the pid poll is the
 * evidence, and the exit code is context the caller prints.
 */
export function diedToSigkill(p: Pick<DispatchResult, "killCause">, reaped: boolean): boolean {
  return reaped && p.killCause === "abort";
}

/**
 * Did the inactivity watchdog kill a silent child with the budget it was
 * armed with? The replacement for `elapsed < 15_000`: the budget is the
 * product's own recorded value, so a descheduled host cannot move it. All
 * three facts are required — a missing cause, another cause, or a budget that
 * is not the armed one each means the watchdog did not do what Test 3 claims.
 */
export function killedByInactivityBudget(
  p: Pick<DispatchResult, "ok" | "killCause" | "killBudgetMs">,
  budgetMs: number,
): boolean {
  return p.killCause === "inactivity" && p.killBudgetMs === budgetMs && p.ok === false;
}
