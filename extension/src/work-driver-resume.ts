/**
 * work-driver-resume — survive the Pi process dying mid-cycle.
 *
 * `/work` is meant to be something you fire and walk away from, and until
 * #382 a crash in the middle of it lost the cycle *and* left the state file
 * asserting otherwise. The resume machinery was declared but inert:
 *
 *   - `resumable: false` was a literal in the TYPE, so it could never be
 *     anything else.
 *   - `inFlightJobIds` was declared, validated and rendered — and never
 *     written anywhere in `src/`.
 *   - `dispatch-started` was never emitted at all, so the validator that
 *     cross-checks in-flight ids against it could only ever pass vacuously.
 *   - State was persisted only at step boundaries, while a single dispatch
 *     can run for thirty minutes. A crash inside that window left the file
 *     at the *previous* boundary, still saying `status: "running"`.
 *
 * The result was that a crashed cycle looked exactly like a running one
 * forever, and the only documented escape — `--restart` — wipes the state
 * file but not GitHub, so it either rebuilt already-committed work or halted
 * on the #362 pre-flight.
 *
 * Two mechanisms here:
 *
 *   1. **Write-ahead.** `markDispatchStarted` persists the intent to dispatch
 *      BEFORE the await, so a crash is recorded rather than invisible.
 *   2. **Ownership.** A state file that says `running` is either a live
 *      driver's or a corpse's, and those need opposite responses. The owner
 *      record distinguishes them: resuming a live cycle would run two drivers
 *      against one branch, which is worse than refusing.
 *
 * Resume granularity is the STEP, not the dispatch — the child process is
 * gone and its work with it. That is sound because every step is
 * dispatch-then-verify and the verify gates catch partial work; `commit-pr`
 * and `merged` additionally carry their own idempotency (#362's PR
 * pre-flight, already-merged tolerance).
 */

import { trace } from "./trace.ts";
import { type WorkState, type WorkStep, writeState } from "./workflow-state.ts";

/** #382 escape hatch: PI_ENSEMBLE_RESUME=0 restores the pre-#382 behaviour. */
export function resumeEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_RESUME;
  return v !== "0" && v !== "false";
}

/**
 * A driver-side id for a dispatch, minted BEFORE it starts.
 *
 * The dispatch's own `jobId` only exists once it returns, which is precisely
 * the information a crash destroys. Includes the pid so two drivers on the
 * same repo cannot mint the same id.
 */
export function mintJobId(step: WorkStep, label: string, at: number): string {
  return `${step}:${label}:${process.pid}:${at}`;
}

/** Record the intent to dispatch, so a crash mid-flight is visible on disk. */
export function markDispatchStarted(
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  jobId: string,
  at: number,
): WorkState {
  return {
    ...state,
    resumable: true,
    owner: { pid: process.pid, at },
    pipelineState: {
      ...state.pipelineState,
      inFlightJobIds: [...state.pipelineState.inFlightJobIds, jobId],
    },
    eventLog: [...state.eventLog, { kind: "dispatch-started", step, role, label, jobId, at }],
  };
}

/**
 * Record the intent to dispatch AND persist it, before the await.
 *
 * Every step that dispatches must call this, not just the ones that go
 * through `runSingleDispatch` — `explore`, `plan`, `develop` and `handoff`
 * have their own dispatch shapes (barrier fetch, fan-out over workstreams),
 * and `develop` is the longest-running step in the cycle, so covering only
 * the shared helper would have left the biggest crash window uncovered.
 *
 * For a fan-out one marker per STEP is enough: resume granularity is the
 * step, and a half-finished fan-out is re-entered wholesale.
 */
export async function beginDispatch(
  repoRoot: string,
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  at: number,
): Promise<{ state: WorkState; jobId: string }> {
  const jobId = mintJobId(step, label, at);
  if (!resumeEnabled()) return { state, jobId };
  const next = markDispatchStarted(state, step, role, label, jobId, at);
  await writeState(repoRoot, next);
  return { state: next, jobId };
}

/** Clear the in-flight marker once the dispatch has settled, either way. */
export function clearDispatch(state: WorkState, jobId: string): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      inFlightJobIds: state.pipelineState.inFlightJobIds.filter((id) => id !== jobId),
    },
  };
}

export type RunningVerdict =
  | { action: "fresh" }
  | { action: "resume"; step: WorkStep; jobIds: string[] }
  | { action: "refuse"; ownerPid: number };

/**
 * Is this process still alive?
 *
 * `kill(pid, 0)` sends no signal and only tests reachability. EPERM means the
 * pid exists but belongs to another user — still alive, so still an owner.
 * Pid reuse can in principle make a dead owner look live; the failure mode is
 * refusing to resume, which is the safe direction.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Decide what a `status: "running"` state file means.
 *
 * Three cases, and conflating any two of them is a real incident:
 *
 *   - **Someone else is running it.** Refuse. Two drivers on one branch is
 *     how you get interleaved commits and a PR nobody can review.
 *   - **A dispatch was in flight and the owner is gone.** The cycle crashed.
 *     Re-enter at the step that was in flight.
 *   - **No dispatch was in flight.** A clean step boundary — just continue,
 *     which is what the driver did before this module existed.
 */
export function classifyRunningState(state: WorkState, selfPid = process.pid): RunningVerdict {
  const owner = state.owner;
  if (owner && owner.pid !== selfPid && processAlive(owner.pid)) {
    return { action: "refuse", ownerPid: owner.pid };
  }
  // Only ids backed by a `dispatch-started` event are evidence of a crash.
  // An id with no such event cannot have come from the write-ahead — it is
  // corrupt state, and `detectInconsistencies` must be left to halt on it.
  // Resuming from it would clear the very field that proves the file is bad.
  const started = new Set(
    state.eventLog.filter((e) => e.kind === "dispatch-started").map((e) => e.jobId),
  );
  const inFlight = state.pipelineState.inFlightJobIds.filter((id) => started.has(id));
  if (inFlight.length > 0) {
    trace(
      `work-driver: resuming issue #${state.issue} at ${state.pipelineState.currentStep} — ${inFlight.length} dispatch(es) were in flight when the driver died`,
    );
    return { action: "resume", step: state.pipelineState.currentStep, jobIds: [...inFlight] };
  }
  return { action: "fresh" };
}

/**
 * Clear a crashed cycle's in-flight markers so the step can be re-entered.
 *
 * The orphaned `dispatch-started` events are deliberately KEPT. They are the
 * only record that a dispatch was paid for and lost, and deleting them would
 * make a resumed cycle indistinguishable from one that never crashed — in the
 * event log the operator reads when something looks wrong.
 */
export function clearForResume(state: WorkState): WorkState {
  return {
    ...state,
    pipelineState: { ...state.pipelineState, inFlightJobIds: [] },
  };
}

/** Operator-facing message for a refused re-entry. */
export function explainRefusal(issue: number, ownerPid: number): string {
  return `pi-ensemble: /work for issue #${issue} is already running in process ${ownerPid}. Two drivers on one branch interleave commits and produce a PR nobody can review, so this invocation is refusing rather than joining. If that process is gone, its state file will say so once it exits — or remove .pi/work-state/${issue}.json to force a fresh cycle.`;
}

/** Operator-facing message for a resumed cycle. */
export function explainResume(issue: number, step: WorkStep, lost: number): string {
  return `pi-ensemble: /work for issue #${issue} is resuming at \`${step}\` — the previous run died with ${lost} dispatch(es) in flight. Completed steps are not re-run; only \`${step}\` is re-entered. Its prior child process and whatever it had done are gone, so the step starts over rather than continuing mid-flight.`;
}
