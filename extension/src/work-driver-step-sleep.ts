/**
 * work-driver-step-sleep — the injectable wait the retry backoffs sleep through.
 *
 * #366: real waits are the point in production (a burst 429 clears by waiting,
 * and waiting less than the provider asked for is what earns the next 429), but
 * the offline suite must never actually sleep. The seam was a module-local
 * `let` inside `work-driver-step-router.ts`; it moved here the moment the
 * RETRY_ONCE branch became its own module, because two modules cannot share a
 * file-local variable and a test that swaps one would silently leave the other
 * sleeping for real.
 */

let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** The current sleep implementation. Callers await it; they never replace it. */
export async function sleep(ms: number): Promise<void> {
  await sleepFn(ms);
}

/** Test seam. Returns a restore function. */
export function __setSleepFn(fn: (ms: number) => Promise<void>): () => void {
  const prev = sleepFn;
  sleepFn = fn;
  return () => {
    sleepFn = prev;
  };
}
