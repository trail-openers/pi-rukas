/**
 * /work workflow state — child-crash fragment (#1403).
 *
 * A develop child whose ENGINE died mid-pass used to be indistinguishable,
 * in the step accounting and in the handoff, from a child that finished:
 * tehas cycle 238-261015-223744 logged `step-completed … develop, round 3,
 * recovered: false` for a pass whose process exited 1, the safety net never
 * ran for that round, and the fix it had already written sat uncommitted in
 * the worktree until the cycle parked.
 *
 * The crash is its own FACT, not a cap. `pipelineState.childCrash` carries
 * one structured record per dead child so the factory's cycle record, the
 * handoff and `/work-status` can name the crash WITHOUT routing its text
 * into `capEvidence` beside a cap that has nothing to do with it — which is
 * exactly what the incident's record did (`cap: adversarial-loop` beside
 * `capReason: "the engine stopped unexpectedly (exit code 1)"`).
 *
 * Same seam pattern as workflow-state-events-safety-net.ts: a pure fragment
 * composed into the closed `WorkEvent` union by name.
 */

/** How the child died, in the terms the harness can actually observe. */
export type ChildCrashKind =
  /** The child process exited non-zero with no structured self-kill — the
   *  "the engine stopped unexpectedly (exit code N)" shape. */
  | "engine-exit"
  /** Exit 0 with a synthetic `stopReason: "error"` on the last assistant
   *  message (a provider HTTP timeout or a severed transport). */
  | "provider-error-stop"
  /** The dispatch itself rejected (spawn threw before any verdict existed). */
  | "dispatch-threw";

/**
 * One dead develop child, recorded structurally on
 * `pipelineState.childCrash` AND emitted as a `child-crash` event. Written by
 * the develop step; read by the handoff renderers and `/work-status`.
 */
export type ChildCrashRecord = {
  /** Epoch ms of the record. */
  at: number;
  /** The step the child was dispatched for (`develop` today; the field keeps
   *  the shape honest if another step adopts it). */
  step: string;
  /** The workstream whose child died. */
  workstreamId: string;
  /** The dispatch label as dispatched (`developer[default]` when N>1). */
  label: string;
  /** How it died. */
  crash: ChildCrashKind;
  /** The child's exit code when the process itself failed; null when the
   *  process exited 0 and the failure was inside the conversation. */
  exitCode?: number | null;
  /** Bounded tail of the failure text (never the whole transcript). */
  detail?: string;
  /** Transcript path, when the child produced one — the recovery handle. */
  transcriptPath?: string;
  /** Wall-clock ms the dead child ran. */
  ms: number;
  /**
   * Non-driver paths still uncommitted in the worktree when the driver
   * finished judging this workstream. An empty array means "checked, nothing
   * was left" — it is a positive read, never an unread one.
   */
  paths?: string[];
  /** Paths the driver committed driver-side (the #622 net) from the dead
   *  pass. Present only when it committed something. */
  committed?: string[];
  /** Why the driver did NOT commit the leftovers, when it refused to. */
  note?: string;
};

/** The `child-crash` event member of the closed `WorkEvent` union. */
export type ChildCrashEvent = ChildCrashRecord & { kind: "child-crash" };
