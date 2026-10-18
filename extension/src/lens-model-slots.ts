/**
 * lens-model-slots — the bounds on concurrent lens children: one host-wide
 * (#1591), and an opt-in one per model (#1348).
 *
 * The code review starts every lens at once. Two things run out:
 *
 *   - The host. A lens can run the product's gate, so six lenses side by side
 *     can be six parallel test suites; in a container that exhausted
 *     `pids.max` and the runner's Bun aborted (#1591). The host bound comes
 *     from the host budget (`lensConcurrency`: CPUs, memory and the pid
 *     limit), or `PI_ENSEMBLE_LENS_CONCURRENCY` (`0` = unbounded). A large
 *     host's budget is above the roster size, so its fan-out is unchanged.
 *   - The provider. One that limits concurrent requests per model answers the
 *     surplus with a 429 or "no free slot", and the lens retries burn on it.
 *     `PI_ENSEMBLE_LENS_MODEL_CONCURRENCY` caps lens children on one resolved
 *     model; lenses on different models (`PI_ENSEMBLE_MODEL_LENS_<LENS>`)
 *     never share a slot. Unset or 0 means no bound.
 *
 * Both queue FIFO and are process-wide, so two concurrent reviews share them.
 * A lens takes its host slot first, then its model slot, always in that order,
 * so a full pool cannot deadlock. Neither is the spawn semaphore
 * (spawn-semaphore.ts), which bounds local processes for every role and stays
 * in force underneath.
 */

import { lensConcurrency } from "./host-resources.ts";
import { resolveModel } from "./models.ts";
import { trace } from "./trace.ts";

/** Concurrent lens children allowed per model; 0 = unbounded (the default). */
export function lensModelConcurrency(): number {
  const raw = process.env.PI_ENSEMBLE_LENS_MODEL_CONCURRENCY;
  const n = raw === undefined || raw.trim() === "" ? 0 : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The slot key: the model a lens child of `lens` resolves to. */
export function lensModelKey(lens: string): string {
  const c = resolveModel("code-review-specialist", undefined, lens);
  return `${c.provider ?? ""}/${c.model ?? "(Pi default)"}`;
}

/** The host-wide pool's key; no model key starts with a space. */
const HOST_KEY = " host";

interface Slots {
  active: number;
  waiting: Array<() => void>;
}
const slots = new Map<string, Slots>();

/**
 * Take one slot of `key` (bound `cap`, 0 = none), queueing FIFO when full.
 * Resolves to a release function, or undefined when no slot is held: no bound,
 * or an abort of `signal` while queued — the lens child then sees the aborted
 * signal and returns at once, so the run still gets its "aborted" result row
 * instead of waiting out the lenses ahead of it.
 */
async function takeSlot(
  key: string,
  cap: number,
  what: string,
  signal?: AbortSignal,
): Promise<(() => void) | undefined> {
  if (cap === 0) return undefined;
  const s = slots.get(key) ?? { active: 0, waiting: [] };
  slots.set(key, s);
  if (s.active >= cap) {
    trace(`lens-model-slots: ${what} (${s.active}/${cap} running)`);
    // The releaser hands its slot straight over, so `active` is not decremented
    // and re-taken: a new arrival cannot overtake a queued lens.
    const took = await new Promise<boolean>((resolve) => {
      if (signal?.aborted) return resolve(false);
      const take = () => {
        signal?.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const i = s.waiting.indexOf(take);
        if (i >= 0) s.waiting.splice(i, 1);
        resolve(false);
      };
      s.waiting.push(take);
      signal?.addEventListener("abort", leave, { once: true });
    });
    if (!took) return undefined;
  } else {
    s.active += 1;
  }
  return () => {
    const next = s.waiting.shift();
    if (next) next();
    else {
      s.active -= 1;
      if (s.active === 0) slots.delete(key);
    }
  };
}

/** Run `fn` holding a host lens slot and one of the lens's model slots. */
export async function withLensModelSlot<T>(
  lens: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const releaseHost = await takeSlot(
    HOST_KEY,
    lensConcurrency(),
    `${lens} waits for a host lens slot`,
    signal,
  );
  try {
    const cap = lensModelConcurrency();
    const key = cap === 0 ? "" : lensModelKey(lens);
    const releaseModel = await takeSlot(key, cap, `${lens} waits for ${key}`, signal);
    try {
      return await fn();
    } finally {
      releaseModel?.();
    }
  } finally {
    releaseHost?.();
  }
}

/** Observability for tests: running and queued lens children on `lens`'s model. */
export function lensModelSlotStats(lens: string): { active: number; queued: number } {
  const s = slots.get(lensModelKey(lens));
  return { active: s?.active ?? 0, queued: s?.waiting.length ?? 0 };
}

/** Observability for tests: running and queued lens children host-wide. */
export function lensHostSlotStats(): { active: number; queued: number } {
  const s = slots.get(HOST_KEY);
  return { active: s?.active ?? 0, queued: s?.waiting.length ?? 0 };
}
