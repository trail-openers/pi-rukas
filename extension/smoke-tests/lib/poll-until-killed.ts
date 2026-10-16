/**
 * Shared bounded kill poll for the smoke tests that must observe a kill
 * actually landing rather than trust that it was requested.
 *
 * Two shapes share the loop, one for each kind of thing being waited on:
 *
 *  - `pollUntilKilled` — the #772 / #846 grace-window kill (test-dispatch-caps-772,
 *    test-loop-detector, test-loop-detector-wire). The #846 flake: those
 *    fixtures slept a fixed ~2400 ms against a 2000 ms grace window, but the
 *    kill fires from spawn-caps.ts's 500 ms setInterval poll, so it lands in
 *    [graceMs, graceMs + 500]. On a slow/saturated CI runner the fixed sleep
 *    finished BEFORE the poll tick — a flake. Polling instead removes the race.
 *
 *  - `pollUntilGone` (#1382) — the death of a real OS pid, observed through
 *    `kill(pid, 0)`. test-cancel's SIGTERM→SIGKILL escalation probe needs it:
 *    a `killCause: "abort"` + `exitCode: null` result is ALSO what a leader
 *    that never exited reports, because the abort resolves the spawn before
 *    the child is reaped. Only liveness of the pid distinguishes the two.
 *
 * Both bound their own wait, so the hung case is a bounded `ok: false` the
 * caller asserts on — never an infinite wait and never a frozen value read
 * once after an `await` that already settled.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/handoff-provenance-fixtures.ts`);
 * coverage comes through the test files that import it.
 */

import type { createCapSession } from "../../src/spawn-caps.ts";

/** The shared poll tick: fast enough that a passing case costs ~nothing. */
const POLL_TICK_MS = 50;

/**
 * #846 — poll until the grace-window kill is observed (50 ms tick, bounded
 * at graceMs + 5000 — 10× the 500 ms tick above the worst-case [grace, grace +
 * tick] landing, tight enough to keep the hang case short). The poll only
 * READS state (no observer traffic — new message_ends would re-arm a
 * streak-armed window). Fails (ok: false) with a distinct timeout the
 * caller's assertion separates from a product failure.
 */
export async function pollUntilKilled(
  s: ReturnType<typeof createCapSession>,
  graceMs: number,
): Promise<{ ok: boolean; at: number }> {
  const bound = graceMs + 5000;
  const t0 = Date.now();
  while (Date.now() - t0 < bound) {
    if (s.loopKilled()) return { ok: true, at: Date.now() };
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
  }
  return { ok: false, at: Date.now() };
}

/**
 * Is `pid` live? `kill(pid, 0)` sends no signal.
 *
 * NB an EXITED-but-not-yet-reaped pid also answers true — it is a zombie and
 * `kill -0` cannot tell the two apart. That is why the escalation probe does
 * NOT poll the leader Node spawned with `pollUntilGone`: the parent reaps that
 * one, and the window between the `exit` event and the reap makes a healthy
 * kill look alive. It polls the leader's own recorded pid and its grandchild
 * instead, and the leader is only load-bearing via the grandchild (see Test 2).
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * #1382 — poll until `pid` is GONE, bounded by `boundMs`. Returns false when
 * the pid is still alive at the deadline, which is the hung case: the caller
 * asserts on it rather than waiting forever. Reads live OS state every tick,
 * so unlike a predicate evaluated once on an already-settled result it can
 * actually become true (or stay false) as the kill lands.
 */
export async function pollUntilGone(
  pid: number,
  boundMs: number,
): Promise<{ ok: boolean; elapsedMs: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < boundMs) {
    if (!pidAlive(pid)) return { ok: true, elapsedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
  }
  return { ok: !pidAlive(pid), elapsedMs: Date.now() - t0 };
}
