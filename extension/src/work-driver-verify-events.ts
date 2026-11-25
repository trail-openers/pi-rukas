/**
 * work-driver-verify-events — the develop gate's event-log entries: the
 * #1240 consolidated-verify skip and the #1415 verify-run bracket.
 *
 * Lives on the VERIFY side, not in `workflow-state-events-verify-flake.ts`.
 * That module is a pure type fragment — every sibling `workflow-state-events-*`
 * file imports types only, and `workflow-state-events.ts` composes the closed
 * `WorkEvent` union from them. A VALUE import of `appendEvent` from
 * `workflow-state.ts` inside that fragment closes a real require cycle
 * (`workflow-state.ts → workflow-state-events.ts → the fragment →
 * workflow-state.ts`), and a cycle through a module that runs top-level code
 * is exactly the shape that produced the TDZ crash in 9 CI tests on PR #1412.
 * The factory and the event type stay where the union can reach them; the
 * mutation lives here, where importing `workflow-state.ts` is ordinary.
 */
import { trace } from "./trace.ts";
import type { FenceLift } from "./work-develop-scope-fence-seam.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import {
  type BaseHealthConsulted,
  baseHealthConsultedNote,
} from "./work-driver-verify-base-health-channels.ts";
import { verifyCmdFor } from "./work-driver-verify-cmd.ts";
import type { ProvenanceDisclosure } from "./work-driver-verify-develop-provenance.ts";
import { type DevelopGateRecord, gatePassKey } from "./work-driver-verify-gate-reuse.ts";
import type { SelectedVerifyRecord } from "./work-driver-verify-select-exec.ts";
import type { VerifyAttributionRecord } from "./work-driver-verify-shared.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { makeConsolidatedVerifySkippedEvent } from "./workflow-state-events-verify-flake.ts";
// #2450 — the selector's verdict, recorded beside the gate's other develop records.
import { makeVerifySelectEvent } from "./workflow-state-events-verify-select.ts";
import type { VerifySelectArgs } from "./workflow-state-events-verify-select.ts";
import type {
  VerifyHeartbeatEvent,
  VerifyRunEventFragment,
  VerifyStartedEvent,
} from "./workflow-state-events-verify.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * The default beat interval — how long the gate may be silent on the host's
 * progress stream before it says something. `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS`
 * overrides it and `0` turns the beat off, which leaves the stream exactly as
 * it was written before the beat existed.
 */
export const VERIFY_HEARTBEAT_DEFAULT_MS = 300_000;

/**
 * `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS` — the beat's interval in ms, read ONCE per
 * /work invocation by the driver and passed down as an argument. It is never
 * read from the environment inside a project command: `verifyChildEnv` scrubs
 * every inventoried knob from those, so a read there could only ever answer
 * this default. A `0` (or anything not a positive finite number) means no beat.
 * A value above the interval is floored to whole ms, and a value that cannot be
 * read as a number is the shipped default rather than an off switch: only an
 * explicit `0` turns the beat off.
 */
export function verifyHeartbeatMs(): number {
  const raw = process.env.PI_ENSEMBLE_VERIFY_HEARTBEAT_MS;
  if (raw === undefined || raw.trim() === "") return VERIFY_HEARTBEAT_DEFAULT_MS;
  const n = Number(raw.replace(/_/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : VERIFY_HEARTBEAT_DEFAULT_MS;
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
  /** Arm one beat. Returns its cancel; unref the timer when it supports unref. */
  setInterval: (fn: () => void, ms: number) => (() => void) | undefined;
  /** Tear the armed beat down. Optional because a fake scheduler may not return one. */
  clearInterval?: (cancel: (() => void) | undefined) => void;
  /** Make one beat durable — in production, `persistCycle`. */
  persist: (state: WorkState) => Promise<unknown>;
  /** Append a beat to this log and hand the result to `persist`. */
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
 *   - nothing after `stop()`, and nothing once `aborted()` is true: `persistCycle`
 *     rewrites a `running` snapshot as `interrupted` on an aborted signal and
 *     appends the runner's own interrupt event, which is not the beat's to write;
 *   - `intervalMs` 0 arms nothing and returns a no-op stop, which is the
 *     byte-identical stream the off switch promises;
 *   - a `persist` that throws is traced and never rethrown — the beat is progress
 *     for the host, never a gate on the cycle — and the following ticks still beat.
 *
 * Beats append to the caller's own log, so they land after `verify-started` at
 * fresh indices and the watermark never re-emits them.
 */
export function startVerifyHeartbeat(d: VerifyHeartbeatDeps): () => void {
  const interval = d.intervalMs ?? VERIFY_HEARTBEAT_DEFAULT_MS;
  if (!(interval > 0) || !Number.isFinite(interval)) return () => {};
  let beating = true;
  let cancel: (() => void) | undefined;
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
      elapsedSeconds: Math.max(0, Math.floor((at - d.startedAt) / 1000)),
    };
    // Awaited, and never rethrown: the beat's write must settle before the gate's
    // own awaits run on (an unawaited one is also an unhandled rejection), and a
    // persist that throws or rejects is traced here so it costs the live line and
    // never the gate. The next tick still beats whatever this one did.
    try {
      await d.persist(appendEvent(d.state, event));
    } catch (err) {
      trace(
        `work-driver: verify-heartbeat not persisted — ${(err as Error)?.message?.slice(0, 160) ?? String(err)}`,
      );
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
    if (!beating) return;
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
 * {@link startVerifyHeartbeat}: the real timers (unref'd, so a beat is never the
 * reason a process stays alive), the real clock, and `persistCycle` as the sink.
 *
 * Absent `started` there is no run to beat for — no command was resolved, so the
 * gate wrote no start and must write no beat. `state` is the snapshot the caller
 * handed `beginVerifyRun`, and `startedAt` its `at`, so a beat's elapsed and a
 * beat's `at` come from one clock and cannot disagree.
 */
export function armVerifyHeartbeat(a: {
  ctx: CycleContext;
  state: WorkState;
  /** Absent when no command was resolved: there is no run to beat for. */
  started: VerifyStartedEvent | undefined;
  /** The interval to beat on. The driver resolves it once from the switch. */
  intervalMs: number | undefined;
  /**
   * When the run began, on the same clock as `now` — the caller hands back the
   * `at` of the run's `verify-started`, so a beat's number and the beat's own
   * `at` come from one clock and cannot disagree.
   */
  startedAt: number;
  /**
   * The gate's OWN clock: the timer is armed against `schedule` and the beat is
   * stamped with `now`. A test injects one pair so it can drive a five-minute
   * interval without sleeping; production leaves it unset and the real
   * `setTimeout` (unref'd) and `Date.now` are used. The pair is one seam, not
   * two: a schedule that fired on fake time while the stamp read the real wall
   * clock would emit beats whose `at` values collide, and the emit watermark
   * fingerprints on `index|kind|at` — colliding beats are one line, not two.
   */
  clock?: { schedule: (fn: () => void, ms: number) => () => void; now: () => number };
}): () => void {
  if (a.started === undefined) return () => {};
  const started = a.started;
  return startVerifyHeartbeat({
    intervalMs: a.intervalMs,
    state: a.state,
    step: started.step,
    command: started.command,
    startedAt: a.startedAt,
    now: a.clock?.now ?? Date.now,
    setInterval:
      a.clock?.schedule ??
      ((fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        // A beat must never be the reason a process stays alive.
        t.unref?.();
        return () => clearTimeout(t);
      }),
    persist: (state) => persistCycle(a.ctx, state),
    aborted: () => a.ctx.signal?.aborted === true,
  });
}

/**
 * #1415 — record that the develop gate's verify is starting, and PERSIST it
 * before the command runs: the persist is what puts the event on the host's
 * stream (work-state-emit.ts), so an operator sees the gate start rather than
 * a silent gap the length of the project's suite. The caller's state is not
 * replaced — the gate's caller appends the same event object later (see
 * `recordDevelopGateEvents`), at the same log index, so the emit sink sees a
 * matching prefix and does not emit it twice.
 *
 * A failed persist costs only the live line, never the gate: it is traced and
 * the verify runs. A crash mid-gate leaves `currentStep` at develop either
 * way, so re-entry re-runs the step exactly as it would without this write.
 *
 * `step` is the CALLER's step, not a fixed `develop`: the commit-pr gate runs
 * the project's command too and its silence is as long as develop's.
 *
 * The returned `at` is the instant the caller hands to the heartbeat as the
 * run's origin, so a beat's elapsed and the bracket it sits inside are stamped
 * from the same moment.
 */
export async function beginVerifyRun(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
): Promise<VerifyStartedEvent | undefined> {
  const command = await verifyCmdFor(ctx.repoRoot);
  if (command === undefined) return undefined;
  const started: VerifyStartedEvent = {
    kind: "verify-started",
    at: Date.now(),
    step,
    command,
    target: { kind: "consolidated" },
  };
  try {
    await persistCycle(ctx, appendEvent(state, started));
  } catch (err) {
    trace(`work-driver: verify-started not persisted — ${(err as Error).message?.slice(0, 160)}`);
  }
  return started;
}

/** #1415 — the bracket for one gate run: its start and how it ended. */
export function finishVerifyRun(
  started: VerifyStartedEvent | undefined,
  ok: boolean,
): VerifyRunEventFragment[] {
  if (started === undefined) return [];
  const at = Date.now();
  return [
    started,
    {
      kind: "verify-completed",
      at,
      step: started.step,
      command: started.command,
      target: started.target,
      status: ok ? "success" : "failure",
      ok,
      ms: at - started.at,
    },
  ];
}

/**
 * Record the develop gate's events on the state: the single place that turns
 * a gate result into log entries, so EVERY path that re-runs the develop gate
 * records them. The gate runs at four seams (the topological develop pass, the
 * #1005 fence merge-and-retry, the #1323 sibling-symbol merge, and the #741
 * converge corrective re-run) and each one owns its own append; a skip
 * recorded only at the first would make the gate look like it ran on the three
 * re-run paths, which is the opposite of what #1240's "never silent" promise
 * means. `workstreamCount` is read from the state here for the same reason —
 * one rule for the count cannot drift per caller.
 *
 * Callers append this FIRST after the gate: `verify-started` was already
 * persisted at the next index, and appending anything before it would read to
 * the emit sink as a rewritten log.
 */
export function recordDevelopGateEvents(
  state: WorkState,
  gate: {
    consolidatedVerifySkipped?: AlreadyVerifiedTree;
    verifyEvents?: VerifyRunEventFragment[];
    gateRecord?: DevelopGateRecord;
    /**
     * The verdict the develop gate collected from the BACKGROUND base probe.
     * Recorded here — in the seam that owns the state write — because the branch
     * step starts that probe without awaiting it, and a background task that wrote
     * this state itself would race the develop step's own writes.
     */
    baseHealthProbe?: BaseHealthVerdict;
    /**
     * The record of the consultation the gate performed, appended as a
     * driver-completed event naming the verdict's colour and the probe's measured
     * ms. This is where the probe's operator-visible record lives now that the
     * branch step registers it instead of awaiting it.
     *
     * The event's `ms` is derived from the consultation's OWN measured probe time
     * (`baseHealthConsulted.ms`) — #1809 fix round. It used to come from a
     * `baseHealthStartedAt` the develop gate was asked to supply, which no
     * production caller did, so every consultation logged as though it had cost
     * nothing. There is no wall clock of our own to keep here: the probe's duration
     * is the only duration this event has ever had anything to be.
     */
    baseHealthConsulted?: BaseHealthConsulted;
    selectedVerify?: SelectedVerifyRecord;
    /**
     * #2450 — what the test selector decided for this develop round: the selected
     * run, or the reason it fell back to the whole suite. Recorded here because
     * this is the seam that owns the develop gate's state write; a verdict
     * collected by the plan and dropped by the caller is exactly how the selector
     * stayed invisible while it was inert.
     */
    verifySelect?: VerifySelectArgs;
    fenceLifts?: FenceLift[];
    /**
     * #2283 — the data-provenance disclosures of THIS develop pass, recorded onto the state
     * the caller owns so `work-driver-commit.ts` can render them into the PR body. Recorded
     * only when the pass produced some: a run that did not execute the gate leaves the field
     * as it found it rather than clearing an earlier pass's rows.
     */
    provenanceDisclosures?: ProvenanceDisclosure[];
  },
): WorkState {
  const [started, completed] = gate.verifyEvents ?? [];
  const events = [
    ...(started ? [started] : []),
    // #1405 — one event per admitted issue-fenced path, so a lifted fence is
    // explainable from the state file (no `step`, like fence-recovery-started).
    ...(gate.fenceLifts ?? []).map((l) => ({
      kind: "fence-lifted" as const,
      at: Date.now(),
      source: "precheck" as const,
      ...l,
    })),
    ...(gate.consolidatedVerifySkipped !== undefined
      ? [
          makeConsolidatedVerifySkippedEvent(
            "develop",
            gate.consolidatedVerifySkipped,
            // The degenerate N=1 shape carries no `worktrees` map (the one
            // workstream's worktree IS repoRoot), so count that as one.
            Object.keys(state.pipelineState.worktrees ?? {}).length || 1,
          ),
        ]
      : []),
    ...(gate.baseHealthConsulted === undefined
      ? []
      : [
          synthesizeDriverCompletion({
            step: "develop",
            label: "driver:base-health",
            summary: baseHealthConsultedNote(
              state.pipelineState.baseSha ?? "",
              gate.baseHealthConsulted,
            ),
            // The consultation's own measured probe time, not a wall clock the
            // caller was supposed to hand us: `synthesizeDriverCompletion` renders
            // `now - startedAt`, so a consultation whose probe measured N ms lands as
            // `ms: N`. A consultation that ran no suite of its own (a cache answer)
            // has no duration and honestly reports 0.
            startedAt: Date.now() - (gate.baseHealthConsulted.ms ?? 0),
            now: Date.now(),
          }),
        ]),
    ...(gate.verifySelect === undefined ? [] : [makeVerifySelectEvent(gate.verifySelect)]),
    ...(completed ? [completed] : []),
  ];
  const recorded = foldVerifyAttribution(
    withProvenanceDisclosures(
      withBaseHealthProbe(withGateRecord(state, gate.gateRecord), gate.baseHealthProbe),
      gate.provenanceDisclosures,
    ),
    gate.selectedVerify,
  );
  return events.length === 0 ? recorded : appendEvent(recorded, ...events);
}

/**
 * #2283 — record this develop pass's provenance disclosures. Absent leaves the state
 * untouched: an empty array here would render an empty PR-body section, and a pass that
 * executed nothing has no disclosures to speak of.
 */
function withProvenanceDisclosures(
  state: WorkState,
  disclosures: ProvenanceDisclosure[] | undefined,
): WorkState {
  if (disclosures === undefined) return state;
  return {
    ...state,
    pipelineState: { ...state.pipelineState, provenanceDisclosures: disclosures },
  };
}

/**
 * Record the base probe's verdict the develop gate read. A verdict that arrived
 * is never dropped: it is what a later develop round reuses instead of paying for
 * a third suite run, and what the handoff names when the base turned out red.
 */
function withBaseHealthProbe(state: WorkState, verdict: BaseHealthVerdict | undefined): WorkState {
  if (verdict === undefined) return state;
  return { ...state, pipelineState: { ...state.pipelineState, baseHealthProbe: verdict } };
}

/**
 * #1415 — fold one gate pass's reuse records into `pipelineState.gateReuse`:
 * the verdict it established (keyed by its triple), the greens it established,
 * and the removal of every green it refuted. Without this the gate computed its
 * records and nothing kept them, so no develop pass could ever reuse one.
 */
function withGateRecord(state: WorkState, record: DevelopGateRecord | undefined): WorkState {
  if (record === undefined) return state;
  const prev = state.pipelineState.gateReuse ?? { passes: {}, workstreamGreens: {} };
  const passes = { ...prev.passes };
  if (record.pass !== undefined) {
    const p = record.pass;
    passes[gatePassKey(p.treeHash, p.cmd, p.timeoutMs)] = p;
  }
  const workstreamGreens = { ...prev.workstreamGreens, ...Object.fromEntries(record.greens) };
  for (const id of record.refuted) delete workstreamGreens[id];
  return {
    ...state,
    pipelineState: { ...state.pipelineState, gateReuse: { passes, workstreamGreens } },
  };
}

/**
 * #1647 — fold one selected run's flaky and baseline-red tests into
 * `pipelineState.verifyAttribution`, keeping each name once across rounds. The
 * commit-pr PR body and the handoff both render what this records.
 */
export function foldVerifyAttribution(
  state: WorkState,
  record: SelectedVerifyRecord | undefined,
): WorkState {
  if (record === undefined) return state;
  if (record.flaky.length === 0 && record.baselineRed.length === 0) return state;
  const prev = state.pipelineState.verifyAttribution ?? { flaky: [], baselineRed: [] };
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      verifyAttribution: {
        ...prev,
        flaky: [...new Set([...prev.flaky, ...record.flaky])],
        baselineRed: [...new Set([...prev.baselineRed, ...record.baselineRed])],
      },
    },
  };
}
