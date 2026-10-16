/**
 * Shared load-tolerant settle poll for the fake-`pi` kill assertions in
 * test-cancel.ts (issue #1382).
 *
 * The #1365 diagnosis: `test-cancel.ts` asserted two absolute wall-clock
 * bounds — a ≥5000 ms floor on the SIGTERM→SIGKILL escalation and a
 * `< 15_000` ceiling on a 2000 ms inactivity budget. Neither measures the
 * product: the 5 s floor is what a saturated host clears EASILY (so it can
 * never fail for the right reason), and the 15 s ceiling is what a saturated
 * host blows through while the watchdog itself is healthy — the observed
 * 30 s stall in the sibling test was bun startup and descheduling, not the
 * kill path. A bound that fails for reasons unrelated to the code under test
 * manufactures false parks (the #777/#798 shape #809 removed for the
 * real-spawn variants).
 *
 * So the tests assert OUTCOMES, and this helper is the only place a clock
 * still appears: a generous bound, measured from the caller's own `startedAt`
 * (the abort / budget arming), whose only job is to turn a genuinely hung
 * child into a RED assertion instead of a verify-loop watchdog kill
 * (`lib/verify-loop.sh` honours `PI_ENSEMBLE_VERIFY_TEST_TIMEOUT_S`, default
 * 300 s, and exits 214 — a hang must be visible as a test failure first).
 * 120 s is 8× that watchdog's per-test budget and orders of magnitude above
 * any descheduling ever measured here (worst observation: 30 s), while
 * `poll-until-killed.ts` (#846, grace + 5000 ms) and `lib/wait-for-ledger.ts`
 * (#984, a flat 30 s for two subprocess hops) are the precedents for
 * preferring headroom over a tight margin.
 *
 * A poll TIMEOUT is reported as `{ ok: false, timedOut: true }`, kept
 * distinct from a product failure (`ok: false, timedOut: false`) exactly as
 * `pollUntilKilled` distinguishes its two failure shapes — so a test message
 * says whether the child never settled or settled wrong.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/poll-until-killed.ts` and
 * `lib/wait-for-ledger.ts`); coverage comes through the test file that
 * imports it, including the failability self-check at the bottom of
 * test-cancel.ts.
 */

/** The generous bound every settle poll in this file uses — see header. */
export const SETTLE_BOUND_MS = 120_000;

/** Poll cadence — same 50 ms tick as `poll-until-killed.ts`. */
const SETTLE_TICK_MS = 50;

/** What a settle poll observed: the predicate's answer, plus a clock that is
 *  logged and never asserted on. */
export interface SettleObservation<T> {
  ok: boolean;
  timedOut: boolean;
  value: T | null;
  waitedMs: number;
}

/**
 * Poll `read` until `predicate` accepts what it returns, or the generous
 * bound expires. Returns the last value read either way, so the caller's
 * assertion prints the real outcome rather than a bare "timeout".
 */
export async function pollUntilSettled<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  opts: { startedAt: number; boundMs?: number; tickMs?: number } = { startedAt: Date.now() },
): Promise<SettleObservation<T>> {
  const boundMs = opts.boundMs ?? SETTLE_BOUND_MS;
  const tickMs = opts.tickMs ?? SETTLE_TICK_MS;
  const deadline = opts.startedAt + boundMs;
  let value: T | null = null;
  for (;;) {
    value = await read();
    if (predicate(value)) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, tickMs));
  }
  return {
    ok: predicate(value as T),
    timedOut: predicate(value as T) === false && Date.now() >= deadline,
    value,
    waitedMs: Date.now() - opts.startedAt,
  };
}

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
 * Two shapes count as "died to SIGKILL": `exitCode === -9` (Node's encoding
 * of a signal death, 0 − 9) and `exitCode === null`, which is what the
 * TERM-trapping fake `pi` actually reports here — Node gives no code for a
 * leader whose `exit` event arrives without one. 137 is accepted too, the
 * 128 + 9 a wrapper shell forwards instead of the raw negative.
 *
 * What it must NOT accept is the shape the escalation did not cause: exit 0
 * (the child answered SIGTERM, so Test 2 covered nothing) or any other code.
 * The self-check at the bottom of test-cancel.ts asserts exactly that
 * discrimination, which is what keeps this predicate from degrading into
 * `return true`.
 */
export function diedToSigkill(p: { exitCode: number | null }): boolean {
  return p.exitCode === -9 || p.exitCode === null || p.exitCode === 137;
}

/**
 * Did the inactivity watchdog kill a silent child with the budget it was
 * armed with? The replacement for `elapsed < 15_000`: the budget is the
 * product's own recorded value, so a descheduled host cannot move it.
 */
export function killedByInactivityBudget(
  p: { ok: boolean; killCause?: string; killBudgetMs?: number },
  budgetMs: number,
): boolean {
  return p.killCause === "inactivity" && p.killBudgetMs === budgetMs && p.ok === false;
}
