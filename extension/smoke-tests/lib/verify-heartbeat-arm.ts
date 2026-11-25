/**
 * The `armVerifyHeartbeat` wiring harness: one armed beat driven against a REAL
 * state file and a REAL emit sink.
 *
 * Every pump case in `test-verify-heartbeat.ts` injects its own `persist`,
 * `now` and scheduler, so none of them touches the lines that actually put a
 * beat on the host's stream. Those lines — `persist: (state) => persistCycle(…)`,
 * `aborted: () => ctx.signal?.aborted === true`, `startedAt`, `now: Date.now`
 * and the unref'd timer — are a pass-through a mutant can replace with no-ops
 * and constants while the injected-dependency tests stay green. This harness is
 * what makes each of them observable: it arms the real wiring and counts what
 * reached the sink.
 *
 * The pump registers its beat with the real `setTimeout`, which cannot be slept
 * on for five minutes, so the registered callback is CAPTURED rather than
 * replaced and fired by the caller. The production wiring is still the code
 * under test; only the waiting is skipped.
 */

import type { CycleContext } from "../../src/work-driver-context.ts";
import { armVerifyHeartbeat } from "../../src/work-driver-verify-events.ts";
import { createEmitSink } from "../../src/work-state-emit.ts";
import type { WorkEvent } from "../../src/workflow-state-events.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { ctxFor, installVerifyCmd, makeExec, stateFor } from "./consolidated-verify-exec.ts";
import { fixture } from "./consolidated-verify-fixture.ts";

export type ArmRun = { emitted: WorkEvent[]; state: WorkState };

/**
 * Arm the real wiring against one fixture and fire its beat once.
 *
 * `stamp` pins `Date.now` for the beat's `at`, so the caller asserts an exact
 * elapsed against `startedAt` instead of a number that dwarfs it. `aborted`
 * stands in for a cycle whose signal has fired. `started` is handed to the
 * caller so the no-start case can pass `undefined`.
 */
export async function armOnce(
  root: string,
  name: string,
  issue: number,
  opts: {
    started: Parameters<typeof armVerifyHeartbeat>[0]["started"];
    startedAt: number;
    intervalMs: number;
    stamp: number;
    aborted?: boolean;
    /** A state of the caller's choosing instead of the fixture's own. */
    state?: WorkState;
    /** A repoRoot of the caller's choosing (the no-fixture cases). */
    repoRoot?: string;
  },
): Promise<ArmRun> {
  const withFixture = opts.repoRoot === undefined;
  const f = withFixture ? await fixture(root, name, ["default"]) : undefined;
  const repoRoot = opts.repoRoot ?? (f as { repo: string }).repo;
  if (withFixture) installVerifyCmd(repoRoot, "never-written.txt");
  const emitted: WorkEvent[] = [];
  const ctx = {
    ...ctxFor(repoRoot, issue, makeExec({ runs: [], repoRoot })),
    emitSink: createEmitSink((e) => emitted.push(e)),
    ...(opts.aborted === true ? { signal: { aborted: true } as AbortSignal } : {}),
  } as unknown as CycleContext;
  const state = opts.state ?? stateFor(f as never, issue);

  let fire: () => void = () => {};
  const realSetTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  Date.now = () => opts.stamp;
  (globalThis as { setTimeout?: unknown }).setTimeout = ((fn: () => void, ms: number) => {
    fire = fn;
    return realSetTimeout(() => {}, ms);
  }) as typeof setTimeout;
  let stop: () => void;
  try {
    stop = armVerifyHeartbeat({
      ctx,
      state,
      started: opts.started,
      intervalMs: opts.intervalMs,
      startedAt: opts.startedAt,
    });
  } finally {
    (globalThis as { setTimeout?: unknown }).setTimeout = realSetTimeout;
    Date.now = realNow;
  }
  // The beat's `persist` is a REAL async write behind the state file's write
  // chain, so the beat is counted only once that write has landed: a beat still
  // mid-write has emitted nothing yet, and counting it then would read a
  // healthy pump as a silent one. Settled on the real timer, never a fake one.
  await fire();
  await new Promise((r) => realSetTimeout(r, 20));
  stop();
  return { emitted, state };
}

/** How many times the real `setTimeout` was called while `fn` ran (timer armings). */
export async function countTimerArms(fn: () => void): Promise<number> {
  let arms = 0;
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout?: unknown }).setTimeout = ((inner: () => void, ms: number) => {
    arms++;
    return realSetTimeout(inner, ms);
  }) as typeof setTimeout;
  try {
    fn();
  } finally {
    (globalThis as { setTimeout?: unknown }).setTimeout = realSetTimeout;
  }
  return arms;
}

/**
 * Run `fn` with `setTimeout` wrapped so every timer it arms reports `unref()`.
 * The count is the unref evidence: a beat must never be the reason a process
 * stays alive.
 */
export async function withUnrefProbe(fn: () => void): Promise<number> {
  let unrefed = 0;
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout?: unknown }).setTimeout = ((inner: () => void, ms: number) => {
    const t = realSetTimeout(inner, ms);
    return Object.assign(t, {
      unref: () => {
        unrefed++;
        return t;
      },
    });
  }) as typeof setTimeout;
  try {
    fn();
  } finally {
    (globalThis as { setTimeout?: unknown }).setTimeout = realSetTimeout;
  }
  return unrefed;
}
