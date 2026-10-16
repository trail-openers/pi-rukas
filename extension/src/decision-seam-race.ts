/**
 * decision-seam-race — one backend run against its bound (#1393).
 *
 * `decide()` needs a backend's answer, or a definite reason it did not get one,
 * within the seam's own timeout. Three racers, and the third is the one that
 * used to be missing:
 *
 *   - the backend settling, normally;
 *   - the seam's own `setTimeout`, which cancels the backend and reports the
 *     timeout;
 *   - the CALLER's `AbortSignal`, which must END the race rather than merely
 *     inform the backend. A backend that ignores its signal and never settling
 *     used to hold `await Promise.race` open for the whole seam bound, so a
 *     killed driver or a shutdown waited out a bound it had already cancelled —
 *     and held its shadow in-flight slot for the duration.
 *
 * The abort racer performs the SAME teardown the timeout racer does: `ac.abort()`
 * so the wedged backend is cancelled rather than left streaming, and
 * `clearTimeout(timer)` so the bound is not left armed past a call that has
 * already been abandoned. A run that settles after the bound is discarded but
 * TRACED — a judge that answers late is what an operator needs to see.
 *
 * Split from decision-seam.ts, which is at the repository's file-size cap; this
 * is the race and nothing else, so `decide()` keeps owning backends, composition
 * and the record.
 */

import type { Backend, BackendInput, BackendResult } from "./decision-backends.ts";
import { traceWarn } from "./trace.ts";

/** One backend's outcome, as `decide()` records it. */
export interface Attempt {
  backend: string;
  source: Backend["source"];
  latencyMs: number;
  result: BackendResult;
}

export async function runBounded(
  b: Backend,
  input: BackendInput,
  outer: AbortSignal | undefined,
): Promise<Attempt> {
  const t0 = Date.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  // #1393 — the outer signal must END the race, not merely signal the backend.
  // A backend that ignores its own AbortSignal and never settles used to hold
  // `await Promise.race` open for the whole seam timeout, so an aborted caller
  // waited out a bound it had already cancelled. The abort is now a third racer,
  // and — the half the first cut missed — it performs the SAME teardown the
  // timeout racer does: `ac.abort()` so the wedged backend is cancelled rather
  // than left streaming, and `clearTimeout(timer)` so the seam's own bound is
  // not left armed past a call that has already been abandoned.
  // The abort racer's handler, hoisted above the racer so the `finally` can name
  // it. The racer registers a THUNK that calls it, rather than the handler
  // itself: `removeEventListener` matches by identity, and the thunk is the
  // handler the signal holds — the two must be the same function or the removal
  // in `finally` silently removes nothing.
  const onOuterAbort = () => {
    ac.abort();
    if (timer) clearTimeout(timer);
    resolveOuter({ ok: false, error: "aborted" });
  };
  let resolveOuter: (r: BackendResult) => void = () => {};
  const aborted =
    outer === undefined
      ? undefined
      : new Promise<BackendResult>((resolve) => {
          resolveOuter = resolve;
          if (outer.aborted) {
            ac.abort();
            if (timer) clearTimeout(timer);
            resolve({ ok: false, error: "aborted before the backend ran" });
          } else outer.addEventListener("abort", onOuterAbort, { once: true });
        });
  // A run that settles after the bound is discarded, but traced: a judge that
  // answers late is exactly the event an operator needs to be able to see.
  const late = () =>
    traceWarn(`decision-seam: ${b.name} settled after its ${input.timeoutMs}ms bound; discarded`);
  try {
    if (outer?.aborted) throw new Error("aborted");
    const timeout = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        resolve({ ok: false, error: `timed out after ${input.timeoutMs}ms` });
      }, input.timeoutMs);
    });
    const run = b.run(input, ac.signal).then(
      (r) => {
        if (timedOut) late();
        return r;
      },
      (e) => {
        if (timedOut) late();
        throw e;
      },
    );
    const result = await Promise.race([run, timeout, aborted ?? new Promise<never>(() => {})]);
    return { backend: b.name, source: b.source, latencyMs: Date.now() - t0, result };
  } catch (err) {
    const error = `threw: ${(err as Error)?.message ?? String(err)}`.slice(0, 300);
    return {
      backend: b.name,
      source: b.source,
      latencyMs: Date.now() - t0,
      result: { ok: false, error },
    };
  } finally {
    if (timer) clearTimeout(timer);
    // Both listeners go when the race settles, not just the one that won it.
    // The abort racer resolves the promise but never removes its own `abort`
    // handler, so a signal held across many `decide()` calls accumulated one
    // closure per call — each keeping the controller, the timer and the
    // backend's input alive long after the decision it belonged to was recorded.
    // `outer` can be the driver's own long-lived signal, which makes the leak
    // proportional to the number of decisions a cycle takes rather than to
    // anything a caller could clean up. `{ once: true }` bounds it at one per
    // signal, but only once it FIRES: a signal that never aborts keeps every
    // listener forever (#1393).
    if (onOuterAbort) outer?.removeEventListener("abort", onOuterAbort);
    outer?.removeEventListener("abort", onAbort);
  }
}
