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

import { existsSync } from "node:fs";
import { trace } from "./trace.ts";
import { type WorkState, type WorkStep, writeState } from "./workflow-state.ts";

/** #382 escape hatch: PI_ENSEMBLE_RESUME=0 restores the pre-#382 behaviour. */
export function resumeEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_RESUME;
  return v !== "0" && v !== "false";
}

// ---------------------------------------------------------------------------
// #543 F3a — session re-attach (capability, DEFAULT-OFF).
//
// A child is already spawned with `--session <transcriptPath>` and that path is
// on `DispatchResult`. On a crash-resume, instead of always re-dispatching from
// scratch, we MAY re-attach the surviving session with `--mode rpc
// --session <transcriptPath>` + a "continue from your checkpoint" prompt. That
// is only safe for SINGLE-DISPATCH steps (explore/plan/ops/handoff/policy-judge)
// where there is exactly one child and its transcript. For FAN-OUT steps
// (develop/lens/adversarial) re-attaching one child of N is an unhandled state,
// so those re-dispatch. F3a FAILS OPEN: absent transcript, flag off, or a
// re-attach spawn failure → re-dispatch from scratch.
//
// `PI_ENSEMBLE_SESSION_REATTACH=1` opts in; at ship it defaults OFF (=0).
// ---------------------------------------------------------------------------

/** F3a escape hatch: PI_ENSEMBLE_SESSION_REATTACH=1 enables re-attach.
 * Pending: #543 F3a — the crash-resume path (classifyRunningState + a future
 * re-attach dispatch helper) is the intended caller; the F3a seam is shipped
 * as default-off infrastructure (PI_ENSEMBLE_SESSION_REATTACH=0, no
 * production caller, no dispatch-started transcriptPath wiring yet) so it
 * cannot change behaviour. Wired when the resume step learns to call
 * resolveReattach/reattachArgs/reattachPrompt for a single-dispatch step.
 */
export function sessionReattachEnabled(): boolean {
  return process.env.PI_ENSEMBLE_SESSION_REATTACH === "1";
}

/**
 * FAN-OUT steps — a step that dispatches MULTIPLE children. Re-attaching one
 * child of a fan-out is an unhandled state (the siblings are gone), so these
 * always re-dispatch. develop (N workstreams), lens-review (6 lenses), and
 * adversarial (per-workstream loops) all fan out.
 */
export const FAN_OUT_STEPS: ReadonlySet<WorkStep> = new Set<WorkStep>([
  "develop",
  "lens-review",
  "lens-fix",
  "adversarial",
]);

/** The floor on a re-attach grant: never less than 5 minutes. Deliberate
 * grace: a re-attaching child re-reads its own session (compaction / token
 * catch-up) before it can do useful work, so a grant tighter than this floor
 * would kill it before it speaks — the #296 false-positive shape. */
export const REATTACH_GRANT_FLOOR_MS = 5 * 60_000;

/**
 * Decide whether a crashed single-dispatch step should re-attach its surviving
 * session rather than re-dispatch from scratch.
 *
 * Returns `{ mode: "reattach", args }` only when ALL of: the feature is on,
 * the step is NOT a fan-out, the in-flight dispatch carried a transcript path,
 * and that file exists on disk. Everything else is `{ mode: "re-dispatch" }`
 * (fail-open) — a missing transcript or a fan-out step re-dispatches.
 *
 * Pending: #543 F3a — no production caller yet; the resume step does not
 * currently record `transcriptPath` on `dispatch-started`, so this returns
 * `re-dispatch` for every state file that reaches it today.
 */
export function resolveReattach(
  step: WorkStep,
  inFlight: { jobId: string; transcriptPath?: string }[],
  now: number,
  originalTimeoutMs?: number,
  dispatchStartedAt?: number,
  opts: { fs?: { existsSync: (p: string) => boolean } } = {},
): { mode: "re-dispatch" } | { mode: "reattach"; transcriptPath: string; grantMs: number } {
  if (!sessionReattachEnabled()) return { mode: "re-dispatch" };
  if (FAN_OUT_STEPS.has(step)) return { mode: "re-dispatch" };
  // Single-dispatch steps record exactly one in-flight job. A fan-out that
  // somehow reaches here has N; refuse to pick one.
  if (inFlight.length !== 1) return { mode: "re-dispatch" };
  const transcriptPath = inFlight[0]?.transcriptPath;
  if (!transcriptPath) return { mode: "re-dispatch" };
  const exists = (opts.fs?.existsSync ?? existsSync)(transcriptPath);
  if (!exists) return { mode: "re-dispatch" };
  // Grant = original timeout minus elapsed since dispatch-started, clamped to
  // the 5-min floor. Without an original timeout we fall back to the floor.
  let grantMs = REATTACH_GRANT_FLOOR_MS;
  if (originalTimeoutMs !== undefined && dispatchStartedAt !== undefined) {
    grantMs = Math.max(REATTACH_GRANT_FLOOR_MS, originalTimeoutMs - (now - dispatchStartedAt));
  }
  return { mode: "reattach", transcriptPath, grantMs };
}

/**
 * The child arg suffix for a re-attach spawn: `--session <transcriptPath>`.
 *
 * `--mode rpc` is already on every child (CHILD_ARGS_BASE), so a re-attach is
 * the same spawn with the SAME `--session` path (Pi resumes the existing
 * session file) instead of a fresh transcript path. Exported as a pure
 * function so the offline test asserts the args array without spawning.
 */
export function reattachArgs(transcriptPath: string): string[] {
  return ["--session", transcriptPath];
}

/**
 * The prompt sent to a re-attached session: it resumes from its own
 * transcript (its prior turns are already in context), so the prompt tells it
 * to continue from its checkpoint rather than re-state the task.
 */
export function reattachPrompt(step: WorkStep, role: string): string {
  return `[resume] Your Pi process was restarted mid-dispatch on step '${step}' (role ${role}). Your prior transcript is loaded in this session. Continue from your checkpoint: finish the work you were doing and produce the same final report you would have, as if the restart had not happened. Do not re-do completed work.`;
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

/** Record the intent to dispatch, so a crash mid-flight is visible on disk.
 *  `transcriptPath` (#543 F3a) is the child's session file — recorded at dispatch
 *  time so a crash-resume can re-attach the surviving session instead of
 *  re-dispatching from scratch. It is optional: steps that don't know the path
 *  up front (the child mints it inside spawn) leave it unset and F3a fails open
 *  to re-dispatch. */
export function markDispatchStarted(
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  jobId: string,
  at: number,
  transcriptPath?: string,
): WorkState {
  return {
    ...state,
    resumable: true,
    owner: { pid: process.pid, at },
    pipelineState: {
      ...state.pipelineState,
      inFlightJobIds: [...state.pipelineState.inFlightJobIds, jobId],
    },
    eventLog: [
      ...state.eventLog,
      { kind: "dispatch-started", step, role, label, jobId, at, transcriptPath },
    ],
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
  transcriptPath?: string,
): Promise<{ state: WorkState; jobId: string }> {
  const jobId = mintJobId(step, label, at);
  if (!resumeEnabled()) return { state, jobId };
  const next = markDispatchStarted(state, step, role, label, jobId, at, transcriptPath);
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
