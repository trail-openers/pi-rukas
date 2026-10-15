/**
 * work-driver-shutdown — a session shutdown is not a step failure.
 *
 * `session_shutdown` aborts every in-flight job, the driver's child included.
 * The driver used to read that as the step failing: it appended
 * `cap-hit: step-failed:<step>` — a diagnosis of its own abort — and entered
 * the handoff step, which needs an ops dispatch and forge calls that cannot
 * complete in a process that is exiting. The cycle was left at
 * `status: running, step: handoff` with a cap nobody had earned, and nothing
 * said why it ended (tehas #97: a reviewed, pushed change 47 s into its last
 * fix pass, reported as a failed lens fix).
 *
 * The driver now treats a shutdown as the crash #382 already knows how to
 * survive, plus one line saying so. It routes nothing and starts nothing; the
 * step's in-memory result is discarded, because every failure in it is the
 * abort's doing. What stays on disk is whatever the step last persisted — for
 * a step that write-aheads, `beginDispatch`'s record, which is exactly the
 * shape the next `/work <N>` resumes from once this process is gone. No new
 * status: `running` + a dead owner already means "resumable", and a caller
 * that wants to know whether a `running` file is live must read
 * `owner.pid`, as `classifyRunningState` does.
 *
 * Two snapshots, and the DISK one is authoritative. Re-entry reads the state
 * file, so `resumable`, the refusal reason and the disk-status gate are all
 * judged against what `readDiskState` returns. The in-memory `state` is used
 * only for the early exit (has the cycle already terminalised in memory?), the
 * branch name, and the failed-step test in `interruptedAfter`. It can be stale:
 * a step that was cut off returns a state describing the abort as its own
 * failure, which is why the event is appended to disk, never to memory.
 *
 * Everything here is synchronous. The process may not outlive an `await`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { notifyAgent } from "./agent-message.ts";
import { sessionShutdownReason } from "./session-shutdown.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { refusedWorkstreams } from "./work-driver-step-refusal.ts";
import { failureEventOf } from "./work-driver-step-router.ts";
import * as workWidget from "./work-widget.ts";
import { validateDiscriminants } from "./workflow-state-validate.ts";
import {
  WORK_STATE_SCHEMA_VERSION,
  type WorkState,
  type WorkStep,
  appendEvent,
  detectInconsistencies,
  workStateFile,
  writeStateSync,
} from "./workflow-state.ts";

/** True once `session_shutdown` has fired: no new cycle may start. */
export function sessionEnding(): boolean {
  return sessionShutdownReason() !== undefined;
}

/** The branch tip, when the cycle has a branch and git can still say. */
function headShaOf(repoRoot: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  try {
    return (
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch (err) {
    trace(`work-driver: could not read the tip of ${branch}: ${errorText(err)}`);
    return undefined;
  }
}

/** The state file as it stands on disk, or why it cannot be appended to. */
type DiskState = { ok: true; state: WorkState } | { ok: false; why: string };

/**
 * Read the state file the interruption will be appended to. An unreadable
 * file and one written under another schema version need different operator
 * action, so they are named differently.
 */
function readDiskState(file: string): DiskState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return {
      ok: false,
      why: `state file unreadable: ${(err as Error).message}`,
    };
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== WORK_STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      why: `state file has schemaVersion ${String(version)}, this build expects ${WORK_STATE_SCHEMA_VERSION}`,
    };
  }
  const shape = raw as Partial<WorkState>;
  if (
    !Array.isArray(shape.eventLog) ||
    typeof shape.pipelineState !== "object" ||
    shape.pipelineState === null
  ) {
    return {
      ok: false,
      why: "state file is malformed (eventLog or pipelineState missing)",
    };
  }
  return { ok: true, state: raw as WorkState };
}

/** Error text for the record and the trace, bounded so the state file stays small. */
function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.slice(0, 200);
}

/**
 * If the session is shutting down, record that this cycle was interrupted at
 * `step` and tell the caller to stop — before a step starts, and when one
 * returns or throws. Returns false (and does nothing) while the session
 * lives, and for a step that reached a terminal status: a merge that landed
 * or a handoff that got its comment out has finished, and the loop's own
 * terminal path records it.
 *
 * `cause` is the error a step threw, when there was one; its text is kept on
 * the record and traced, never dropped. A crash that coincides with a signal
 * is still a crash: only a throw while the session is shutting down is the
 * abort's doing, and the caller does not record it as a step crash.
 *
 * The event is appended to the state ON DISK, not to `state`: a step that was
 * cut off returns a state describing the abort as its own failure.
 */
export function interruptedByShutdown(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
  cause?: unknown,
): boolean {
  const reason = sessionShutdownReason();
  if (reason === undefined || state.pipelineState.status !== "running") return false;
  workWidget.clear(ctx.issue);
  const branch = state.pipelineState.branchName;
  const headSha = headShaOf(ctx.repoRoot, branch);
  const detail = cause === undefined ? undefined : errorText(cause);
  if (detail !== undefined) trace(`work-driver: ${step} threw during session shutdown: ${detail}`);
  // Why re-entry would refuse this file, if it would. A step that does not
  // write-ahead leaves the previous boundary on disk, which the resume check
  // reads as drift — true of a crash there too, and said rather than hidden.
  const disk = readDiskState(workStateFile(ctx.repoRoot, ctx.issue));
  let recorded: { kind: "recorded"; refusal: string | undefined } | { kind: "failed"; why: string };
  if (!disk.ok) recorded = { kind: "failed", why: disk.why };
  else if (disk.state.pipelineState.status !== "running") {
    // Already interrupted or terminal on disk: a second record is a second stop.
    recorded = {
      kind: "failed",
      why: `state file is already ${disk.state.pipelineState.status}, not running`,
    };
  } else {
    // Inside the guarded region: a throw from the checks must still record,
    // with the refusal named, rather than escape with no record and no line.
    // Re-entry's verdict is classifyRunningState plus the halts after it. Only
    // the state checks can be evaluated here: classifyRunningState's refuse arm
    // needs an owner pid other than this process, and the owner on this file is
    // this process.
    let refusal: string | undefined;
    try {
      refusal = [...detectInconsistencies(disk.state), ...validateDiscriminants(disk.state)][0];
    } catch (err) {
      refusal = `state could not be checked (${errorText(err)})`;
    }
    try {
      writeStateSync(
        ctx.repoRoot,
        appendEvent(disk.state, {
          kind: "cycle-interrupted",
          at: Date.now(),
          step,
          reason,
          ...(branch ? { branch } : {}),
          ...(headSha ? { headSha } : {}),
          resumable: refusal === undefined,
          ...(detail !== undefined ? { error: detail } : {}),
        }),
      );
      recorded = { kind: "recorded", refusal };
    } catch (err) {
      const why = `write failed: ${errorText(err)}`;
      trace(`work-driver: could not record the interruption: ${why}`);
      recorded = { kind: "failed", why };
    }
  }
  const where = branch ? ` — work on ${branch}${headSha ? ` at ${headSha.slice(0, 8)}` : ""}` : "";
  const next =
    recorded.kind === "failed"
      ? `could not record the interruption (${recorded.why})`
      : recorded.refusal === undefined
        ? `state is resumable — run /work ${ctx.issue}`
        : `/work ${ctx.issue} will refuse this state (${recorded.refusal})`;
  const line = `cycle interrupted: session shutdown (${reason}) during ${step}; ${next}${where}`;
  // `quit` tears the session down, so stderr is the one channel still read;
  // any other reason leaves a live TUI that a raw write would corrupt.
  if (reason === "quit") process.stderr.write(`[pi-rukas] ${line}\n`);
  else {
    try {
      notifyAgent(
        ctx.host,
        `pi-rukas:driver-event v1 kind=interrupted issue=${ctx.issue} at=${new Date().toISOString()}\npi-rukas: /work ${line}`,
      );
    } catch (err) {
      trace(`work-driver: could not deliver the shutdown line: ${errorText(err)}`);
    }
  }
  return true;
}

/**
 * Did the step that just returned end in a failure? The same signals
 * `routeStepOutcome` routes on: a failure event at the tail (or behind a
 * fan-out), a cap-hit, or a driver refusal.
 */
function stepFailed(state: WorkState, step: WorkStep): boolean {
  const last = state.eventLog[state.eventLog.length - 1];
  return (
    failureEventOf(state.eventLog) !== undefined ||
    last?.kind === "cap-hit" ||
    refusedWorkstreams(state.eventLog, step).length > 0
  );
}

/**
 * The post-step check, after `runStep` returned without throwing. A shutdown
 * ends the cycle here only when the step FAILED, because a failure under
 * shutdown is the abort's doing. A step that SUCCEEDED is not interrupted: it
 * routes and persists its boundary normally, and the loop's pre-step check
 * records the shutdown on the NEXT step. Recording a succeeded step as
 * interrupted would leave it at `currentStep`, and re-entry would run it again.
 */
export function interruptedAfter(ctx: DriverContext, state: WorkState, step: WorkStep): boolean {
  if (!stepFailed(state, step)) return false;
  return interruptedByShutdown(ctx, state, step);
}
