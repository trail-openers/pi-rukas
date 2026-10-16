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
 * So the tests assert the death and the attribution, on the settled result,
 * with no clock in between: each caller awaits `spawnSpecialist` to
 * completion, and that await is already bounded twice over — by the spawn's
 * own `timeoutMs` (the wall-clock cap, which attributes `killCause: "timeout"`)
 * and by `lib/verify-loop.sh`'s per-test watchdog
 * (`PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S`, default 300 s, exit 214). A genuinely
 * hung child therefore surfaces as a bounded failure rather than an infinite
 * wait, which is why the generous settle poll this file used to carry was
 * decorative: both callers polled AFTER the await had resolved, so the
 * predicate was evaluated once on a frozen value and the poll's `timedOut`
 * could never become true.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/poll-until-killed.ts` and
 * `lib/wait-for-ledger.ts`); coverage comes through the test file that imports
 * it, including the failability self-check at the bottom of test-cancel.ts.
 */

import type { DispatchResult } from "../../src/types.ts";

/**
 * Did a SIGTERM-trapping child die to the SIGKILL escalation, rather than
 * exiting on SIGTERM the way a well-behaved child does?
 *
 * The replacement for the `elapsedMs >= 5_000` floor. That floor was
 * load-INSENSITIVE in the dangerous direction: a saturated host delays the
 * escalation past 5 s so it passes, and if the escalation were ever shortened
 * below 5 s the fake child would exit on SIGTERM and the floor would STILL
 * pass — a decorative assertion. This one reads the death itself.
 *
 * The attribution is required, not optional: `killCause === "abort"` is what
 * says pi-rukas ended this child (#296), and without it any unrelated
 * signal-death or crash of the fake `pi` would read as a covered escalation.
 * Given that attribution, three exit shapes count as a SIGKILL death:
 * `-9` (Node's encoding of a signal death, 0 − 9), `137` (the 128 + 9 a
 * wrapper shell forwards instead of the raw negative), and `null` — which is
 * what the TERM-trapping fake `pi` actually reports here, measured as
 * `exit=null` on a real SIGKILL death, because Node gives no code for a
 * leader whose `exit` event arrives without one.
 *
 * What it must NOT accept is a shape the escalation did not cause: exit 0 (the
 * child answered SIGTERM, so Test 2 covered nothing), any other code, a
 * signal death attributed to something other than the abort, or a bare
 * `exitCode === null` with no attribution at all. The self-check at the bottom
 * of test-cancel.ts asserts exactly that discrimination, which is what keeps
 * this predicate from degrading into `return true`.
 */
export function diedToSigkill(p: Pick<DispatchResult, "exitCode" | "killCause">): boolean {
  if (p.killCause !== "abort") return false;
  return p.exitCode === -9 || p.exitCode === 137 || p.exitCode === null;
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
