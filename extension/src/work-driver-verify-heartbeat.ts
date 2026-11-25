/**
 * work-driver-verify-heartbeat — the develop verify gate's progress beat: the
 * switch that sets its interval, the pump that decides when a beat happens, and
 * the wiring that makes one durable. Split out of `work-driver-verify-events.ts`
 * for the AGENTS.md §12 size cap; the bracket events (`verify-started` /
 * `verify-completed`) stay there, beside the union that owns them.
 *
 * The beat exists because the gate writes its `verify-started` and then prints
 * nothing until the project's command returns, and a host whose stall rule watches
 * the runner's progress stream stops a healthy cycle inside that silence.
 */
import { trace, traceWarn } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { VerifyHeartbeatEvent, VerifyStartedEvent } from "./workflow-state-events-verify.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendBeat, appendEvent } from "./workflow-state.ts";
/**
 * The default beat interval — how long the gate may be silent on the host's
 * progress stream before it says something. `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS`
 * overrides it and `0` turns the beat off, which leaves the stream exactly as
 * it was written before the beat existed.
 */
export const VERIFY_HEARTBEAT_DEFAULT_MS = 300_000;

/**
 * The floor on a beat's interval. Each beat rewrites the whole state file (see
 * `appendBeat`), so a sub-second interval would turn a liveness line into a
 * write-storm on the file every other driver persist shares. A positive value
 * under this reads as the floor; `0` stays the ONLY off value.
 */
export const VERIFY_HEARTBEAT_MIN_MS = 1_000;

/**
 * `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS` — the beat's interval in ms, read ONCE per
 * /work invocation by the driver and passed down as an argument. It is never
 * read from the environment inside a project command: `verifyChildEnv` scrubs
 * every inventoried knob from those, so a read there could only ever answer
 * this default. A `0` (or anything not a positive finite number) means no beat.
 * A value above the interval is floored to whole ms, and a value that cannot be
 * read as a number is the shipped default rather than an off switch: only an
 * explicit `0` turns the beat off. A positive value below {@link
 * VERIFY_HEARTBEAT_MIN_MS} reads as that floor, because every beat rewrites the
 * whole state file.
 */
export function verifyHeartbeatMs(): number {
  const raw = process.env.PI_ENSEMBLE_VERIFY_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === "") return VERIFY_HEARTBEAT_DEFAULT_MS;
  const n = Number(raw.replace(/_/g, ""));
  if (!Number.isFinite(n) || n < 0) return VERIFY_HEARTBEAT_DEFAULT_MS;
  // `0` is the off switch and stays below the floor; every other positive value
  // is a whole ms at or above it.
  return n === 0 ? 0 : Math.max(VERIFY_HEARTBEAT_MIN_MS, Math.floor(n));
}

/**
 * The pump's dependencies, every one of them injected. Nothing here reaches for
 * a timer, a wall clock, the environment or the state file: the pump is a small
 * deterministic loop a test drives by calling its registered callback by hand,
 * which is the only way the beat count is the pump's output rather than the
 * scheduler's timing. Production wires the real ones at {@link armVerifyHeartbeat}.
 */
export type VerifyHeartbeatDeps = {
  /** The interval to beat on; anything but a positive finite number arms nothing. */
  intervalMs: number | undefined;
  /** The clock the beat is stamped with — also the clock `startedAt` came from. */
  now: () => number;
  /** Arm the repeating beat. Returns its cancel; unref the timer when it supports unref. */
  setInterval: (fn: () => void, ms: number) => (() => void) | undefined;
  /** Tear the armed beat down. Optional because a fake scheduler may not return one. */
  clearInterval?: (cancel: (() => void) | undefined) => void;
  /**
   * Make one beat durable — in production, {@link appendBeat}, which appends to the
   * persisted log inside the file's write slot rather than rewriting a snapshot.
   */
  persist: (state: WorkState) => Promise<unknown>;
  /**
   * The log the pump builds its beat on and hands to `persist`. The injected pump
   * beats against it; the production wiring ignores it and reads the file instead.
   */
  state: WorkState;
  /** The step and command the beat names — taken from the run's own start event. */
  step: WorkStep;
  command: string;
  /** When the run began, on the same clock as `now`. */
  startedAt: number;
  /** True once the cycle's signal has fired: a beat then persists nothing. */
  aborted?: () => boolean;
};

/**
 * The gate's beat: one `verify-heartbeat` per `intervalMs` while a verify command
 * is in flight, until `stop()`. A pump and nothing else — it decides when to
 * beat, what the beat carries, and when to stop beating; where the beat goes and
 * when it fires are both injected.
 *
 * Persisting is the whole point. An event built and held in memory emits nothing,
 * because the host's stream is written by the persist that makes an event durable
 * (`work-state-emit.ts`), and a periodic watch here once awaited the span it was
 * watching and never fired at all.
 *
 * The rules that keep the gate safe, each pinned by a pump test:
 *
 *   - one beat per tick, each carrying a whole-second `elapsedSeconds` and its own
 *     `at`, so the emit watermark (`index|kind|at`) sees the distinct events they
 *     are rather than one line repeated;
 *   - nothing after `stop()`, and nothing once `aborted()` is true: a beat that
 *     still finds a fired signal persists nothing, because the runner's own
 *     interrupt event is not the beat's to write (the production persist applies
 *     `applyInterrupt` for the window between that check and its write slot, and
 *     appends to the on-disk log rather than rewriting a snapshot — see
 *     `appendBeat`);
 *   - `intervalMs` 0 arms nothing and returns a no-op stop, which is the
 *     byte-identical stream the off switch promises;
 *   - a `persist` that throws is reported once (WARN) and never rethrown — the beat
 *     is progress for the host, never a gate on the cycle — and the following ticks
 *     still beat.
 *
 * In production the pump is armed on a REPEATING timer and the sink is
 * {@link appendBeat}: the whole point of the beat is that the gate's span outlasts
 * several intervals, so a one-shot timer would say nothing after the first beat,
 * and a `persistCycle` of the gate-start snapshot would roll back every driver
 * persist that landed since. The `state` dependency is what the injected pump
 * beats against (a fake sink, no file); the production wiring never reads it.
 */
export function startVerifyHeartbeat(d: VerifyHeartbeatDeps): () => void {
  const interval = d.intervalMs ?? VERIFY_HEARTBEAT_DEFAULT_MS;
  if (!(interval > 0) || !Number.isFinite(interval)) return () => {};
  let beating = true;
  let cancel: (() => void) | undefined;
  // The first failed beat of a run is the one worth a WARN: a whole gate whose
  // beats all failed is one silent line, not one per beat, and an operator
  // staring at a stream with no beats has to be able to tell "switched off" from
  // "every write failed". Later failures stay on the debug channel.
  let warned = false;
  const beat = async (): Promise<void> => {
    if (!beating) return;
    if (d.aborted?.() === true) return;
    const at = d.now();
    const event: VerifyHeartbeatEvent = {
      kind: "verify-heartbeat",
      at,
      step: d.step,
      // Verbatim from the start event it accompanies: this codebase names the
      // field `command`, as on `verify-started` / `verify-completed`.
      command: d.command,
      // Clamped: the docs promise a host a NON-NEGATIVE integer, and this is the
      // number a stall rule reads — a clock behind the run's origin (an NTP
      // correction) must not render `verify-heartbeat · develop · -5s`.
      elapsedSeconds: Math.max(0, Math.floor((at - d.startedAt) / 1000)),
    };
    // Awaited, and never rethrown: the beat's write must settle before the gate's
    // own awaits run on (an unawaited one is also an unhandled rejection), and a
    // persist that throws or rejects is reported here so it costs the live line and
    // never the gate. The next tick still beats whatever this one did.
    try {
      await d.persist(appendEvent(d.state, event));
    } catch (err) {
      const detail = `work-driver: verify-heartbeat not persisted — ${
        (err as Error)?.message?.slice(0, 160) ?? String(err)
      } (${d.step}: ${d.command})`;
      if (warned) trace(detail);
      else {
        warned = true;
        traceWarn(detail);
      }
    }
  };
  cancel = d.setInterval(() => {
    // The pump owns the beat's failure: `beat` catches its own persist, and a
    // rejection escaping it anyway is traced rather than left to surface as an
    // unhandled rejection. The gate is never the thing that sees it.
    void beat().catch((err: unknown) => {
      trace(
        `work-driver: verify-heartbeat beat failed — ${(err as Error)?.message ?? String(err)}`,
      );
    });
  }, interval);
  return () => {
    // No `beating` guard here on purpose: the fake scheduler in the pump tests
    // fires every registered callback, the cancelled ones included, so the
    // guard inside `beat` is the load-bearing stop — this line is its
    // bookkeeping, not the thing that halts the beat.
    beating = false;
    try {
      if (d.clearInterval) d.clearInterval(cancel);
      else cancel?.();
    } catch (err) {
      trace(`work-driver: verify-heartbeat cancel failed: ${(err as Error)?.message}`);
    }
    cancel = undefined;
  };
}

/**
 * Arm the gate's beat for the span of one verify run. The wiring seam for
 * {@link startVerifyHeartbeat}: a REPEATING unref'd timer (so the beat keeps
 * coming for the gate's whole span, and a beat is never the reason a process
 * stays alive), the real clock, and `appendBeat` as the sink.
 *
 * Both halves of that pairing are the feature: a one-shot timer beats once and
 * then says nothing for the rest of a long gate, and `persistCycle` of a snapshot
 * taken at gate start would rewrite the whole file and roll back whatever the
 * driver persisted while the gate ran. `appendBeat` re-reads the state inside the
 * file's write slot and appends there, exactly as `markInterrupted` does.
 *
 * Absent `started` there is no run to beat for — no command was resolved, so the
 * gate wrote no start and must write no beat. `startedAt` is the `at` of that
 * start event, so a beat's elapsed and a beat's `at` come from one clock and
 * cannot disagree. `state` is unused here: the beat appends to what is on disk,
 * never to a closed-over snapshot.
 */
export function armVerifyHeartbeat(a: {
  ctx: CycleContext;
  /** Unused by the production wiring — the beat reads the persisted log instead. */
  state: WorkState;
  /** Absent when no command was resolved: there is no run to beat for. */
  started: VerifyStartedEvent | undefined;
  /** The interval to beat on. The driver resolves it once from the switch. */
  intervalMs: number | undefined;
  /**
   * When the run began, on the same clock as the beat's `now` — the caller hands
   * back the `at` of the run's `verify-started`, so a beat's number and the beat's
   * own `at` come from one clock and cannot disagree.
   */
  startedAt: number;
}): () => void {
  if (a.started === undefined) return () => {};
  const started = a.started;
  return startVerifyHeartbeat({
    intervalMs: a.intervalMs,
    state: a.state,
    step: started.step,
    command: started.command,
    startedAt: a.startedAt,
    now: Date.now,
    // A real repeating timer: the pump arms it once and expects it to fire every
    // interval until cancelled. `unref` keeps a beat from holding the process.
    setInterval: (fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      // Optional-chained: a timer is what a real scheduler hands back, and a
      // fake one may hand back nothing. A beat that could not unref must still
      // beat, and must never throw on the way there.
      t?.unref?.();
      return () => clearInterval(t);
    },
    clearInterval: (cancel) => cancel?.(),
    // The pump built the beat into `snapshot`; the wiring adds only which file it
    // belongs to, and `appendBeat` appends that beat to the log ON DISK. The event
    // is never rebuilt here, so a harness that stubs the write still reads
    // `step`/`command`/`at`/`elapsedSeconds` off what the wiring's pump produced —
    // a constant in any of them fails those assertions rather than hiding here.
    persist: (snapshot) => {
      const beat = snapshot.eventLog[snapshot.eventLog.length - 1];
      if (beat === undefined) return Promise.resolve(undefined);
      return appendBeat(a.ctx.repoRoot, snapshot.issue, a.ctx.emitSink, a.ctx.signal, beat);
    },
    aborted: () => a.ctx.signal?.aborted === true,
  });
}
