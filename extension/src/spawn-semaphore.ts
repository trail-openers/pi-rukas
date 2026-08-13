/**
 * spawn-semaphore — the global ceiling on concurrent Pi child processes.
 *
 * There was none. `spawnSpecialist` went straight to `spawn()`, and the two
 * caps that look like they bound it do not:
 *
 *   - `MAX_JOBS` (async-jobs-registry) is a *rejection* cap that throws, and
 *     it only sees `dispatchCore`-routed work. `lens-review.ts` and
 *     `adversarial.ts` call `spawnSpecialist` directly, so six lens children
 *     and every adversarial child are invisible to it.
 *   - `MAX_PARALLEL` (dispatch.ts) validates one tool call's array length.
 *
 * Actual fanout: `develop` starts 2M children (a developer AND a speculative
 * explore per workstream), M is bounded only by #290's ceiling. Each is a
 * `pi --mode rpc` process with its own prompt dir, transcript and model
 * session, so the ceiling is a local-resource question — see `spawnCap`.
 *
 * This wraps `spawnSpecialist` itself rather than `startJob` — precisely
 * because the direct-spawn paths are the ones that need bounding. Excess
 * queues FIFO and never throws: a queued dispatch is a slower cycle, a
 * rejected one is a failed step, and `STEP_FAILURE_POLICY.develop` is HALT.
 */

import { trace } from "./trace.ts";

/**
 * Concurrent children allowed.
 *
 * This bounds LOCAL processes — pids, file descriptors, memory. It is not a
 * ration on provider capacity, and must never be used as one: a provider that
 * is saturated says so itself, with a 429 and a `retry-after` that Pi's client
 * waits out (`retry-config-check.ts` warns at startup when the host's
 * `maxRetryDelayMs` is low enough to discard that instruction). Backpressure
 * belongs to whoever has the information, and that is the provider.
 *
 * Sized above any single cycle's peak fanout so the cap can never serialise a
 * step against itself. The peak is `develop`, at 2 children per workstream (a
 * developer plus a speculative explore); at the MAX_WORKSTREAMS ceiling of 10
 * that is 20, and `lens-review`'s six-way fanout is far below it. 64 leaves
 * room for several cycles at that width while still catching a runaway.
 *
 * The previous value was 12, which one M=6 develop step consumed entirely —
 * so a second concurrent cycle got zero slots and queued. That queueing was
 * measured as "roles run ~2.4x slower under concurrency" and misread as
 * provider contention; it was this FIFO.
 *
 * `PI_ENSEMBLE_SPAWN_CAP=0` disables the semaphore entirely.
 */
export function spawnCap(): number {
  const env = Number(process.env.PI_ENSEMBLE_SPAWN_CAP);
  return Number.isFinite(env) && env >= 0 ? env : 64;
}

let active = 0;
const waiting: Array<() => void> = [];

/** Observability for tests and `/ensemble-debug`. */
export function spawnSlotStats(): { active: number; queued: number; cap: number } {
  return { active, queued: waiting.length, cap: spawnCap() };
}

/**
 * Run `fn` holding one spawn slot, queueing FIFO when the cap is reached.
 *
 * The slot is released in `finally`, so a throwing child frees its slot —
 * otherwise a run of failures would ratchet the effective cap to zero and
 * wedge every subsequent dispatch.
 */
export async function withSpawnSlot<T>(fn: () => Promise<T>): Promise<T> {
  const cap = spawnCap();
  if (cap === 0) return fn();
  if (active >= cap) {
    if (waiting.length === 0) {
      trace(`spawn-semaphore: cap ${cap} reached — queueing`);
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    // FIFO: shift, never pop. Order matters because the queue holds whole
    // pipeline steps — LIFO would let a late arrival overtake a developer
    // that the rest of its cycle is blocked on.
    const nextUp = waiting.shift();
    if (nextUp) nextUp();
  }
}

/** Test seam: drop queued waiters and reset the counter between fixtures. */
export function __resetSpawnSemaphore(): void {
  active = 0;
  waiting.length = 0;
}
