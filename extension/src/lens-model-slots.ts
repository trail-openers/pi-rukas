/**
 * lens-model-slots — the opt-in bound on concurrent lens children per model
 * (#1348).
 *
 * The code review starts every lens at once. A provider that limits
 * concurrent requests per model (a self-hosted endpoint with N slots, or a
 * plan with a concurrency quota) answers the surplus with a 429 or "no free
 * slot", and the lens retries burn on it. `PI_ENSEMBLE_LENS_MODEL_CONCURRENCY`
 * caps how many lens children run at once on one resolved model; the rest
 * queue FIFO. Lenses on different models (`PI_ENSEMBLE_MODEL_LENS_<LENS>`)
 * never share a slot.
 *
 * Unset or 0 means no bound, so the default fan-out is unchanged. The bound
 * is process-wide, so two concurrent reviews on one model share it. It is
 * not the spawn semaphore (spawn-semaphore.ts), which bounds local processes
 * for every role and stays in force underneath this one.
 */

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

interface Slots {
  active: number;
  waiting: Array<() => void>;
}
const slots = new Map<string, Slots>();

/**
 * Run `fn` holding one of the lens's model slots, queueing FIFO when the bound
 * is reached. An abort of `signal` while queued leaves the queue and runs `fn`
 * without a slot: the lens child sees the aborted signal and returns at once,
 * so the run still gets its "aborted" result row instead of waiting out the
 * lenses ahead of it.
 */
export async function withLensModelSlot<T>(
  lens: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const cap = lensModelConcurrency();
  if (cap === 0) return fn();
  const key = lensModelKey(lens);
  const s = slots.get(key) ?? { active: 0, waiting: [] };
  slots.set(key, s);
  let holding = true;
  if (s.active >= cap) {
    trace(`lens-model-slots: ${lens} waits for ${key} (${s.active}/${cap} running)`);
    // The releaser hands its slot straight over, so `active` is not decremented
    // and re-taken: a new arrival cannot overtake a queued lens.
    holding = await new Promise<boolean>((resolve) => {
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
  } else {
    s.active += 1;
  }
  try {
    return await fn();
  } finally {
    if (holding) {
      const next = s.waiting.shift();
      if (next) next();
      else {
        s.active -= 1;
        if (s.active === 0) slots.delete(key);
      }
    }
  }
}

/** Observability for tests: running and queued lens children on `lens`'s model. */
export function lensModelSlotStats(lens: string): { active: number; queued: number } {
  const s = slots.get(lensModelKey(lens));
  return { active: s?.active ?? 0, queued: s?.waiting.length ?? 0 };
}
