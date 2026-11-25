/**
 * work-driver-context-verify-heartbeat — the verify gate's heartbeat half of
 * `DriverContext`, split out for the AGENTS.md §12 size cap.
 *
 * The two fields live together because they are one knob's two halves: the
 * interval the driver resolved once per invocation, and the pump that consumes
 * it. A caller that set one and not the other would arm a beat that never fires
 * or fire one on an unintended interval, so they are read as a pair by
 * `verifyStepOutcome` and declared as a pair here.
 *
 * `WorkState`, `WorkStep` and `CycleContext` are type-only imports: this module
 * adds no runtime edge to the driver, and `work-driver-context.ts` keeps the
 * single place where the context's shape is composed.
 */
import type { CycleContext } from "./work-driver-context.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

/**
 * The develop / commit-pr verify gate's heartbeat interval in ms, resolved ONCE
 * by the driver from `PI_ENSEMBLE_VERIFY_HEARTBEAT_MS` (default 300000; `0`
 * turns the beat off; a positive value below 1000 reads as 1000, since each beat
 * rewrites the whole state file) and carried here. An argument and not an env read
 * at the leaf: `verifyChildEnv` scrubs every inventoried knob from a project
 * command's environment, so a gate that read the knob itself could only ever see
 * the default. Absent means the shipped default.
 */
export type VerifyHeartbeatMs = number;

/**
 * Test seam for the verify gate's heartbeat: the pump itself, injected rather
 * than reached for, so a test observes what the run armed the beat with and
 * whether the caller's `finally` stopped it, without a clock at all. Unset in
 * production, where the call site arms the real pump on a repeating unref'd timer
 * with `appendBeat` as its sink. It is a pump factory, not a clock: the pump takes
 * its own scheduling dependencies, so this seam adds no timekeeping to the gate.
 */
export type VerifyHeartbeatPump = (a: {
  ctx: CycleContext;
  state: WorkState;
  step: WorkStep;
  command: string;
  intervalMs: number | undefined;
  startedAt: number;
}) => () => void;
