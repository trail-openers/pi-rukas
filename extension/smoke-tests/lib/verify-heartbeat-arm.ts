/**
 * The `armVerifyHeartbeat` wiring harness: one armed beat driven against a REAL
 * state file and a REAL emit sink.
 *
 * Every pump case in `test-verify-heartbeat.ts` injects its own `persist`,
 * `now` and scheduler, so none of them touches the lines that actually put a
 * beat on the host's stream. Those lines — `persist: () => appendBeat(…)`,
 * `aborted: () => ctx.signal?.aborted === true`, `startedAt`, `now: Date.now`
 * and the unref'd repeating timer — are a pass-through a mutant can replace with
 * no-ops and constants while the injected-dependency tests stay green. This
 * harness is what makes each of them observable: it arms the real wiring and
 * counts what reached the sink.
 *
 * The pump registers its beat with the real `setInterval`, which cannot be slept
 * on for five minutes, so the registered callbacks are CAPTURED rather than
 * replaced and fired by the caller. The production wiring is still the code
 * under test; only the waiting is skipped. (That the timer REPEATS across a long
 * gate is not observable here — firing a captured callback proves only that a
 * callback exists. `test-verify-heartbeat-repeat.ts` sleeps on real timers for
 * that, because a one-shot timer and a repeating one are the same object to a
 * caller that fires its callback by hand.)
 */

import type { CycleContext } from "../../src/work-driver-context.ts";
import { NDJSON_VERSION, formatLine, isStableKind } from "../../src/headless/ndjson.ts";
import { armVerifyHeartbeat } from "../../src/work-driver-verify-heartbeat.ts";
import * as workflowState from "../../src/workflow-state.ts";
import { type EmitSink, createEmitSink } from "../../src/work-state-emit.ts";
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
  // The beat appends to the state file that EXISTS at write time, so the run has
  // to have one — a cycle that persisted nothing yet gets no beat (the repeat test
  // pins that case). This is the bracket the beats land after.
  if (withFixture) {
    const { readState, writeState } = await import("../../src/workflow-state.ts");
    if ((await readState(repoRoot, issue)) === undefined) await writeState(repoRoot, state);
  }

  // The beat's OWN text comes from the code under test: the pump builds the event
  // and the wiring hands it to `appendBeat`, which reads the state file and appends
  // to it. Nothing here builds an event or fakes the write — a harness that did
  // would pass with the wiring's `step`, `command` or `startedAt` replaced by
  // constants, which is what the assertions at the call site catch. The lines read
  // back are what the REAL emit sink produced from the REAL persist.
  const fires: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const realNow = Date.now;
  Date.now = () => opts.stamp;
  (globalThis as { setInterval?: unknown }).setInterval = ((fn: () => void, ms: number) => {
    fires.push(fn);
    // Never a real timer: the caller fires the captured callback itself, and the
    // cancel below must have something harmless to clear.
    return undefined as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
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
    (globalThis as { setInterval?: unknown }).setInterval = realSetInterval;
    Date.now = realNow;
  }
  // The beat's `persist` is an async write behind the state file's write chain in
  // production, so the beat is counted only once such a write has settled: a beat
  // still mid-write has emitted nothing yet, and counting it then would read a
  // healthy pump as a silent one. Settled on the real timer, never a fake one.
  for (const fire of fires) await fire();
  await new Promise((r) => realSetInterval(r, 20));
  stop();
  return { emitted, state };
}

/**
 * How many REPEATING timers the real wiring armed while `fn` ran. The wrapper
 * sits on `setInterval` because that is the scheduler the production wiring
 * uses: a mapping back to a one-shot `setTimeout` reads as zero arms here, which
 * is one of the shapes this count exists to catch.
 */
export async function countTimerArms(fn: () => void): Promise<number> {
  let arms = 0;
  const realSetInterval = globalThis.setInterval;
  (globalThis as { setInterval?: unknown }).setInterval = ((inner: () => void, ms: number) => {
    arms++;
    return realSetInterval(inner, ms);
  }) as typeof setInterval;
  try {
    fn();
  } finally {
    (globalThis as { setInterval?: unknown }).setInterval = realSetInterval;
  }
  return arms;
}

/**
 * Run `fn` with `setInterval` wrapped so every timer it arms reports `unref()`.
 * The count is the unref evidence: a beat must never be the reason a process
 * stays alive.
 */
export async function withUnrefProbe(fn: () => void): Promise<number> {
  let unrefed = 0;
  const realSetInterval = globalThis.setInterval;
  (globalThis as { setInterval?: unknown }).setInterval = ((inner: () => void, ms: number) => {
    const t = realSetInterval(inner, ms);
    return Object.assign(t, {
      unref: () => {
        unrefed++;
        return t;
      },
    });
  }) as typeof setInterval;
  try {
    fn();
  } finally {
    (globalThis as { setInterval?: unknown }).setInterval = realSetInterval;
  }
  return unrefed;
}

/**
 * The host's own line for one event, normalised only where two runs of the same
 * gate must differ (each mints its own `at`, `ms` and idempotency key). The
 * off-switch case compares the lines the host actually receives, so a beat — or
 * a beat-shaped field on the bracket — that leaked onto the off arm changes a
 * line and fails there. Lives here with the other real-wiring helpers so the pump
 * test stays inside the file-size cap.
 */
export function normalisedLines(events: WorkEvent[], issue: number): string[] {
  return events
    .filter((e) => e.kind !== "verify-heartbeat")
    .map((e, i) =>
      formatLine({
        v: NDJSON_VERSION,
        kind: e.kind,
        at: "<at>",
        issue,
        key: `<key:${i}>`,
        event: JSON.parse(JSON.stringify({ ...e, at: 0, ms: 0 })),
        ...(isStableKind(e.kind) ? {} : { unstable: true as const }),
      }),
    );
}
