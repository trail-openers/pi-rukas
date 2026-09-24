/**
 * Shared grace-window kill poll for the #772 / #846 loop-kill smoke tests
 * (test-dispatch-caps-772.ts, test-loop-detector.ts, test-loop-detector-wire.ts).
 *
 * The #846 flake: those fixtures slept a fixed ~2400 ms against a 2000 ms
 * grace window, but the kill fires from spawn-caps.ts's 500 ms setInterval
 * poll, so it lands in [graceMs, graceMs + 500]. On a slow/saturated CI
 * runner the fixed sleep finished BEFORE the poll tick — a flake. Polling
 * instead removes the race.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/handoff-provenance-fixtures.ts`);
 * coverage comes through the test files that import it.
 */

import type { createCapSession } from "../../src/spawn-caps.ts";

/**
 * #846 — poll until the grace-window kill is observed (50 ms tick, 10 s
 * bound). The poll only READS state (no observer traffic — new message_ends
 * would re-arm a streak-armed window). Fails (ok: false) with a distinct
 * timeout the caller's assertion separates from a product failure.
 */
export async function pollUntilKilled(
  s: ReturnType<typeof createCapSession>,
): Promise<{ ok: boolean; at: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    if (s.loopKilled()) return { ok: true, at: Date.now() };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: false, at: Date.now() };
}
